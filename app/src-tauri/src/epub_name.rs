//! "Rename from Book Metadata": `Title - Author.epub` from the EPUB's own OPF,
//! a port of getMetadataFilenameForEpub / buildMetadataFilename in
//! crosspoint-reader's FilesPage.html so the app names files like the
//! reader's own web upload page does.

use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::{Cursor, Read};
use zip::ZipArchive;

/// `Title - Author.epub`, or None when the book has no usable title.
pub fn metadata_filename(epub: &[u8]) -> Option<String> {
  let mut zip = ZipArchive::new(Cursor::new(epub)).ok()?;
  let path = opf_path(&mut zip)?;
  let opf = read(&mut zip, &path)?;
  let (title, author) = title_author(&opf)?;
  build_filename(&title, &author)
}

fn read(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<String> {
  let mut buf = Vec::new();
  zip.by_name(name).ok()?.read_to_end(&mut buf).ok()?;
  Some(String::from_utf8_lossy(&buf).into_owned())
}

// META-INF/container.xml's rootfile, else the first .opf in the archive.
fn opf_path(zip: &mut ZipArchive<Cursor<&[u8]>>) -> Option<String> {
  let container = zip.file_names().find(|n| n.eq_ignore_ascii_case("meta-inf/container.xml")).map(String::from);
  if let Some(xml) = container.and_then(|c| read(zip, &c)) {
    let mut reader = Reader::from_str(&xml);
    loop {
      match reader.read_event() {
        Ok(Event::Start(e) | Event::Empty(e)) if e.local_name().as_ref() == b"rootfile" => {
          let path = e.attributes().flatten().find(|a| a.key.local_name().as_ref() == b"full-path");
          if let Some(a) = path {
            let p = String::from_utf8_lossy(&a.value).into_owned();
            if zip.file_names().any(|n| n == p) {
              return Some(p);
            }
          }
        }
        Ok(Event::Eof) | Err(_) => break,
        _ => {}
      }
    }
  }
  zip.file_names().find(|n| n.to_ascii_lowercase().ends_with(".opf")).map(String::from)
}

// First <title>; the first <creator> with role "aut", else the first without a role.
fn title_author(opf: &str) -> Option<(String, String)> {
  let mut reader = Reader::from_str(opf);
  let mut title: Option<String> = None;
  let mut creators: Vec<(String, String, String)> = Vec::new(); // (role, text, file-as)
  let mut in_tag: Option<(&'static str, String, String)> = None; // (tag, role, file-as)
  let mut text = String::new();
  loop {
    match reader.read_event() {
      Ok(Event::Start(e)) => {
        let tag = match e.local_name().as_ref() {
          b"title" if title.is_none() => "title",
          b"creator" => "creator",
          _ => continue,
        };
        let attr = |name: &[u8]| {
          e.attributes()
            .flatten()
            .find(|a| a.key.local_name().as_ref() == name)
            .map(|a| String::from_utf8_lossy(&a.value).into_owned())
            .unwrap_or_default()
        };
        in_tag = Some((tag, attr(b"role").to_lowercase(), attr(b"file-as")));
        text.clear();
      }
      Ok(Event::Text(t)) if in_tag.is_some() => text.push_str(&t.xml_content().unwrap_or_default()),
      Ok(Event::CData(t)) if in_tag.is_some() => text.push_str(&String::from_utf8_lossy(&t)),
      Ok(Event::End(_)) => {
        if let Some((tag, role, file_as)) = in_tag.take() {
          match tag {
            "title" => title = Some(text.clone()),
            _ => creators.push((role, text.trim().to_string(), file_as)),
          }
        }
      }
      Ok(Event::Eof) | Err(_) => break,
      _ => {}
    }
  }
  let author = creators
    .iter()
    .find(|c| c.0 == "aut")
    .or_else(|| creators.iter().find(|c| c.0.is_empty()))
    .map(|(_, text, file_as)| if text.is_empty() { file_as.clone() } else { text.clone() })
    .unwrap_or_default();
  Some((title?, author))
}

fn sanitize(value: &str) -> String {
  let cleaned: String = value
    .chars()
    .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { ' ' } else { c })
    .collect();
  cleaned.split_whitespace().collect::<Vec<_>>().join(" ").trim_matches(|c| c == '.' || c == ' ').to_string()
}

fn build_filename(title: &str, author: &str) -> Option<String> {
  let (title, author) = (sanitize(title), sanitize(author));
  if title.is_empty() {
    return None;
  }
  let mut base = if author.is_empty() { title } else { format!("{title} - {author}") };
  if base.chars().count() > 180 {
    let cut: String = base.chars().take(180).collect();
    // Break at a word like the firmware does, unless that leaves nothing.
    base = match cut.rfind(char::is_whitespace) {
      Some(i) if i > 0 => cut[..i].trim().to_string(),
      _ => cut.trim().to_string(),
    };
  }
  Some(format!("{base}.epub"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;
  use zip::write::SimpleFileOptions;

  fn epub(opf: &str) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    let mut z = zip::ZipWriter::new(&mut buf);
    z.start_file("META-INF/container.xml", SimpleFileOptions::default()).unwrap();
    z.write_all(br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#).unwrap();
    z.start_file("OEBPS/content.opf", SimpleFileOptions::default()).unwrap();
    z.write_all(opf.as_bytes()).unwrap();
    z.finish().unwrap();
    buf.into_inner()
  }

  #[test]
  fn names_from_title_and_author_role() {
    let opf = r#"<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><metadata>
      <dc:title>Foundryside: A Novel</dc:title>
      <dc:creator opf:role="ill">Some Illustrator</dc:creator>
      <dc:creator opf:role="aut" opf:file-as="Bennett, Robert Jackson">Robert Jackson Bennett</dc:creator>
    </metadata></package>"#;
    // ':' is not filename-safe, same as the firmware's sanitizer.
    assert_eq!(metadata_filename(&epub(opf)).as_deref(), Some("Foundryside A Novel - Robert Jackson Bennett.epub"));
  }

  #[test]
  fn falls_back_to_file_as_and_title_only() {
    let opf = r#"<package><metadata><title>Dune</title><creator file-as="Herbert, Frank"></creator></metadata></package>"#;
    assert_eq!(metadata_filename(&epub(opf)).as_deref(), Some("Dune - Herbert, Frank.epub"));
    let untitled = r#"<package><metadata><creator>Nobody</creator></metadata></package>"#;
    assert_eq!(metadata_filename(&epub(untitled)), None);
    assert_eq!(build_filename(&"word ".repeat(60), "").unwrap().chars().count() <= 185, true);
  }
}

