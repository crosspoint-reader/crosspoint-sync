//! EPUB image optimizer, ported from common-stacks (same author, MIT), which
//! mirrors the on-device optimizer in CrossPoint's FilesPage.html. Re-encodes
//! every image inside an EPUB as a single-quality JPEG, renames the entry, and
//! rewrites OPF/XHTML/CSS references so the book still opens. Output is a
//! valid EPUB OCF (mimetype first, STORE).

use anyhow::Result;
use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const IMG_EXTENSIONS: &[&str] = &["png", "gif", "webp", "bmp", "jpg", "jpeg"];
const TEXT_EXTENSIONS: &[&str] = &["html", "xhtml", "htm", "opf", "ncx", "xml", "css", "smil"];

/// Re-encode every image as JPEG at `quality`, calling `progress(done, total)`.
pub fn optimize(input: &[u8], quality: u8, progress: &dyn Fn(u64, u64)) -> Result<Vec<u8>> {
    let mut archive = ZipArchive::new(Cursor::new(input))?;
    let mut out_buf = Cursor::new(Vec::with_capacity(input.len()));
    let mut out = ZipWriter::new(&mut out_buf);

    // First pass: figure out which entries we'll rename (image → .jpg) so the
    // text-rewrite step can swap references in one shot. Also count total
    // images so progress can report "N of M".
    let mut renames: HashMap<String, String> = HashMap::new();
    let mut total_images: u64 = 0;
    for i in 0..archive.len() {
        let f = archive.by_index(i)?;
        let name = f.name().to_string();
        if let Some(ext) = extension(&name) {
            let lower = ext.to_ascii_lowercase();
            if IMG_EXTENSIONS.contains(&lower.as_str()) {
                total_images += 1;
                if lower != "jpg" {
                    let stem = &name[..name.len() - ext.len() - 1]; // strip ".<ext>"
                    renames.insert(name.clone(), format!("{}.jpg", stem));
                }
            }
        }
    }
    progress(0, total_images);

    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // EPUB OCF requires `mimetype` first, stored uncompressed.
    if let Ok(mut f) = archive.by_name("mimetype") {
        let mut data = Vec::new();
        f.read_to_end(&mut data)?;
        out.start_file("mimetype", stored)?;
        out.write_all(&data)?;
    }

    let mut processed_images: u64 = 0;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = f.name().to_string();
        if name == "mimetype" {
            continue;
        }
        if f.is_dir() {
            // Preserve directory entries with no content.
            out.add_directory(&name, deflated)?;
            continue;
        }

        let mut data = Vec::new();
        f.read_to_end(&mut data)?;

        let new_name = renames.get(&name).cloned().unwrap_or_else(|| name.clone());
        let lower_ext = extension(&name)
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        if IMG_EXTENSIONS.contains(&lower_ext.as_str()) {
            processed_images += 1;
            progress(processed_images, total_images);
            match reencode_jpeg(&data, quality) {
                Ok(jpg) => {
                    out.start_file(&new_name, stored)?;
                    out.write_all(&jpg)?;
                }
                Err(e) => {
                    eprintln!("optimizer: keeping original {} ({})", name, e);
                    out.start_file(&name, deflated)?;
                    out.write_all(&data)?;
                }
            }
        } else if TEXT_EXTENSIONS.contains(&lower_ext.as_str()) {
            let text = String::from_utf8(data).map(|s| rewrite_text(&s, &renames));
            match text {
                Ok(updated) => {
                    out.start_file(&new_name, deflated)?;
                    out.write_all(updated.as_bytes())?;
                }
                Err(e) => {
                    out.start_file(&new_name, deflated)?;
                    out.write_all(e.as_bytes())?;
                }
            }
        } else {
            out.start_file(&new_name, deflated)?;
            out.write_all(&data)?;
        }
    }

    out.finish()?;
    Ok(out_buf.into_inner())
}

fn extension(name: &str) -> Option<&str> {
    let last = name.rsplit('/').next()?;
    let idx = last.rfind('.')?;
    if idx + 1 >= last.len() {
        return None;
    }
    Some(&last[idx + 1..])
}

fn reencode_jpeg(bytes: &[u8], quality: u8) -> Result<Vec<u8>> {
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()?
        .decode()?;
    let rgb = img.to_rgb8();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    {
        let mut enc = JpegEncoder::new_with_quality(&mut out, quality);
        enc.encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)?;
    }
    Ok(out)
}

/// Rewrite image filename references inside text-like EPUB entries. Replaces
/// the full path, the basename, and updates known image MIME types to
/// image/jpeg. Done as a string replace; HTML attribute boundaries are
/// preserved because the search strings include the original extension.
fn rewrite_text(input: &str, renames: &HashMap<String, String>) -> String {
    let mut out = input.to_string();
    for (old, new) in renames {
        out = out.replace(old, new);
        if let (Some(old_base), Some(new_base)) =
            (old.rsplit('/').next(), new.rsplit('/').next())
        {
            if old_base != old.as_str() {
                out = out.replace(old_base, new_base);
            }
        }
    }
    out = out.replace("image/png", "image/jpeg");
    out = out.replace("image/gif", "image/jpeg");
    out = out.replace("image/webp", "image/jpeg");
    out = out.replace("image/bmp", "image/jpeg");
    out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn converts_images_and_rewrites_references() {
    let mut png = Vec::new();
    image::RgbImage::from_pixel(8, 8, image::Rgb([200, 30, 30]))
      .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
      .unwrap();
    let mut epub = Cursor::new(Vec::new());
    {
      let mut z = ZipWriter::new(&mut epub);
      let opt = SimpleFileOptions::default();
      z.start_file("mimetype", opt.compression_method(CompressionMethod::Stored)).unwrap();
      z.write_all(b"application/epub+zip").unwrap();
      z.start_file("OEBPS/content.opf", opt).unwrap();
      z.write_all(br#"<item href="img/cover.png" media-type="image/png"/>"#).unwrap();
      z.start_file("OEBPS/img/cover.png", opt).unwrap();
      z.write_all(&png).unwrap();
      z.finish().unwrap();
    }
    let out = optimize(&epub.into_inner(), 70, &|_, _| {}).unwrap();
    let mut z = ZipArchive::new(Cursor::new(out)).unwrap();
    assert_eq!(z.by_index(0).unwrap().name(), "mimetype");
    let mut opf = String::new();
    z.by_name("OEBPS/content.opf").unwrap().read_to_string(&mut opf).unwrap();
    assert_eq!(opf, r#"<item href="img/cover.jpg" media-type="image/jpeg"/>"#);
    let mut jpg = Vec::new();
    z.by_name("OEBPS/img/cover.jpg").unwrap().read_to_end(&mut jpg).unwrap();
    assert_eq!(&jpg[..2], &[0xFF, 0xD8]); // JPEG magic
  }
}

