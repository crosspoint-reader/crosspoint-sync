//! OPDS browsing, downloads, and sending books to a CrossPoint reader.
//! Download naming and extension resolution follow common-stacks.

use crate::opds::{self, feed::Feed, Auth};
use crate::optimizer;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::{AppHandle, Manager};

type Res<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
  e.to_string()
}

/// What we know about a downloaded file (from the catalog entry it came from).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BookMeta {
  pub title: String,
  pub author: Option<String>,
  pub cover: Option<String>,
  pub source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Download {
  pub name: String,
  pub size: u64,
  pub added_ms: u64,
  pub meta: Option<BookMeta>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum Progress {
  Downloading { done: u64, total: Option<u64> },
  Optimizing { done: u64, total: u64 },
  Uploading,
}

// Desktop: a visible folder under ~/Books. Mobile: the app's own storage.
fn books_dir(app: &AppHandle) -> Res<PathBuf> {
  let p = app.path();
  let dir = if cfg!(any(target_os = "ios", target_os = "android")) {
    p.app_data_dir().map_err(err)?.join("Books")
  } else {
    p.home_dir().map_err(err)?.join("Books").join("CrossPoint Sync")
  };
  fs::create_dir_all(&dir).map_err(err)?;
  Ok(dir)
}

const INDEX: &str = ".crosspoint-sync.json";

fn read_index(dir: &PathBuf) -> HashMap<String, BookMeta> {
  fs::read(dir.join(INDEX)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_index(dir: &PathBuf, index: &HashMap<String, BookMeta>) -> Res<()> {
  fs::write(dir.join(INDEX), serde_json::to_vec_pretty(index).map_err(err)?).map_err(err)
}

/// Keep a name inside the books folder (no separators or `..`).
fn safe_name(name: &str) -> Res<String> {
  let clean = sanitize_filename::sanitize(name);
  if clean.is_empty() || clean.starts_with('.') {
    return Err("invalid file name".into());
  }
  Ok(clean)
}

#[tauri::command]
pub async fn opds_feed(url: String, auth: Option<Auth>) -> Res<Feed> {
  opds::fetch_feed(&auth.unwrap_or_default(), &url).await.map_err(err)
}

#[tauri::command]
pub async fn opds_search(url: String, query: String, auth: Option<Auth>) -> Res<Feed> {
  opds::search(&auth.unwrap_or_default(), &url, &query).await.map_err(err)
}

#[tauri::command]
pub async fn download_book(
  app: AppHandle,
  url: String,
  mime: Option<String>,
  auth: Option<Auth>,
  meta: BookMeta,
  on_progress: Channel<Progress>,
) -> Res<Download> {
  // Throttle progress to every 64 KiB so fast downloads don't flood IPC.
  let mut last = 0;
  let (bytes, ct) = opds::download(&auth.unwrap_or_default(), &url, |done, total| {
    if total.is_some_and(|t| done >= t) || done - last >= 64 * 1024 {
      last = done;
      let _ = on_progress.send(Progress::Downloading { done, total });
    }
  })
  .await
  .map_err(err)?;

  let ext = ext_from_href(&url)
    .or_else(|| mime.as_deref().and_then(ext_from_mime).map(String::from))
    .or_else(|| ct.as_deref().and_then(ext_from_mime).map(String::from))
    .unwrap_or_else(|| "bin".into());
  let base = match meta.author.as_deref() {
    Some(a) if !a.is_empty() => format!("{} - {}", meta.title, a),
    _ => meta.title.clone(),
  };
  let dir = books_dir(&app)?;
  let name = unique_name(&dir, &format!("{}.{}", sanitize_filename::sanitize(&base), ext));
  fs::write(dir.join(&name), &bytes).map_err(err)?;
  let mut index = read_index(&dir);
  index.insert(name.clone(), meta.clone());
  write_index(&dir, &index)?;
  Ok(Download { name, size: bytes.len() as u64, added_ms: now_ms(), meta: Some(meta) })
}

#[tauri::command]
pub fn list_downloads(app: AppHandle) -> Res<Vec<Download>> {
  let dir = books_dir(&app)?;
  let index = read_index(&dir);
  let mut out = Vec::new();
  for entry in fs::read_dir(&dir).map_err(err)?.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    let Ok(md) = entry.metadata() else { continue };
    if name.starts_with('.') || !md.is_file() {
      continue;
    }
    let added_ms = md
      .modified()
      .ok()
      .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
      .map_or(0, |d| d.as_millis() as u64);
    out.push(Download { meta: index.get(&name).cloned(), name, size: md.len(), added_ms });
  }
  out.sort_by(|a, b| b.added_ms.cmp(&a.added_ms));
  Ok(out)
}

#[tauri::command]
pub fn delete_download(app: AppHandle, name: String) -> Res<()> {
  let dir = books_dir(&app)?;
  let name = safe_name(&name)?;
  fs::remove_file(dir.join(&name)).map_err(err)?;
  let mut index = read_index(&dir);
  if index.remove(&name).is_some() {
    write_index(&dir, &index)?;
  }
  Ok(())
}

/// Send a downloaded book to the reader. `quality` set = optimize EPUB images first.
#[tauri::command]
pub async fn send_download(
  app: AppHandle,
  name: String,
  base: String,
  folder: String,
  quality: Option<u8>,
  rename: Option<bool>,
  on_progress: Channel<Progress>,
) -> Res<String> {
  let name = safe_name(&name)?;
  let bytes = fs::read(books_dir(&app)?.join(&name)).map_err(err)?;
  send(&base, &folder, &name, bytes, quality, rename.unwrap_or(false), Some(on_progress)).await
}

/// Raw IPC body bytes. Android's WebView can't expose request bodies to the IPC
/// protocol, so Tauri JSON-encodes the message there; the app sends base64 text
/// (ipcBytes in api.js), and a plain byte array still works as a fallback.
fn body_bytes(request: &Request<'_>) -> Res<Vec<u8>> {
  use base64::{engine::general_purpose::STANDARD, Engine};
  match request.body() {
    InvokeBody::Raw(bytes) => Ok(bytes.clone()),
    InvokeBody::Json(serde_json::Value::String(b64)) => STANDARD.decode(b64).map_err(err),
    InvokeBody::Json(serde_json::Value::Array(items)) => items
      .iter()
      .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
      .collect::<Option<Vec<u8>>>()
      .ok_or_else(|| "file bytes were not a byte array".into()),
    _ => Err("expected file bytes".into()),
  }
}

/// Send a file picked in the webview. Body = raw bytes; x-name / x-base /
/// x-folder / x-quality / x-rename headers carry the rest (raw IPC avoids JSON-encoding MBs).
#[tauri::command]
pub async fn send_bytes(request: Request<'_>) -> Res<String> {
  let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
  let decode = |v: Option<String>| v.and_then(|s| urlencoding_decode(&s)).ok_or("missing header");
  let name = decode(header("x-name"))?;
  let base = decode(header("x-base"))?;
  let folder = decode(header("x-folder"))?;
  let quality = header("x-quality").and_then(|q| q.parse().ok());
  let bytes = body_bytes(&request)?;
  let rename = header("x-rename").is_some_and(|v| v == "1");
  send(&base, &folder, &name, bytes, quality, rename, None).await
}

/// Save a generated file (share card PNG, clippings Markdown) to Downloads.
/// Body = raw bytes; x-name header = file name.
#[tauri::command]
pub async fn save_file(app: AppHandle, request: Request<'_>) -> Res<String> {
  let name = request
    .headers()
    .get("x-name")
    .and_then(|v| v.to_str().ok())
    .and_then(urlencoding_decode)
    .map(|n| sanitize_filename::sanitize(n))
    .filter(|n| !n.is_empty())
    .unwrap_or_else(|| "crosspoint-sync".into());
  let bytes = body_bytes(&request)?;
  // iOS: images go to Photos; other files to the app's Documents, which the
  // Files app shows (UIFileSharingEnabled). Android saves via MediaStore in JS.
  #[cfg(target_os = "ios")]
  {
    let lower = name.to_ascii_lowercase();
    if [".png", ".jpg", ".jpeg", ".bmp"].iter().any(|e| lower.ends_with(e)) {
      save_to_photos(&bytes)?;
      return Ok("Photos".into());
    }
  }
  #[cfg(target_os = "ios")]
  let dir = app.path().document_dir().map_err(err)?;
  #[cfg(not(target_os = "ios"))]
  let dir = app.path().download_dir().map_err(err)?;
  let name = unique_name(&dir, &name);
  fs::write(dir.join(&name), bytes).map_err(err)?;
  Ok(dir.join(name).to_string_lossy().to_string())
}

#[cfg(target_os = "ios")]
fn save_to_photos(bytes: &[u8]) -> Res<()> {
  use objc2_foundation::NSData;
  use objc2_ui_kit::UIImage;
  let data = NSData::with_bytes(bytes);
  let image = UIImage::imageWithData(&data).ok_or("That image couldn't be read")?;
  // Needs NSPhotoLibraryAddUsageDescription; iOS asks the user once.
  unsafe { image.write_to_saved_photos_album(None, None, std::ptr::null_mut()) };
  Ok(())
}

async fn send(
  base: &str,
  folder: &str,
  name: &str,
  bytes: Vec<u8>,
  quality: Option<u8>,
  rename: bool,
  progress: Option<Channel<Progress>>,
) -> Res<String> {
  let emit = |p: Progress| {
    if let Some(ch) = &progress {
      let _ = ch.send(p);
    }
  };
  let is_epub = name.to_ascii_lowercase().ends_with(".epub");
  // "Rename from Book Metadata", like the reader's own upload page. Read from the
  // original bytes, before the optimizer rewrites the archive.
  let name = match rename && is_epub {
    true => crate::epub_name::metadata_filename(&bytes).unwrap_or_else(|| name.to_string()),
    false => name.to_string(),
  };
  let name = name.as_str();
  let bytes = match quality {
    Some(q) if is_epub => {
      let ch = progress.clone();
      tauri::async_runtime::spawn_blocking(move || {
        optimizer::optimize(&bytes, q.clamp(1, 100), &|done, total| {
          if let Some(ch) = &ch {
            let _ = ch.send(Progress::Optimizing { done, total });
          }
        })
        // A book the optimizer can't parse still goes over as-is.
        .unwrap_or(bytes)
      })
      .await
      .map_err(err)?
    }
    _ => bytes,
  };

  emit(Progress::Uploading);
  let part = reqwest::multipart::Part::bytes(bytes).file_name(name.to_string()).mime_str(mime_for(name)).map_err(err)?;
  let url = format!("{}/upload?path={}", base.trim_end_matches('/'), urlencoding_encode(folder));
  let resp = reqwest::Client::new()
    .post(&url)
    .multipart(reqwest::multipart::Form::new().part("file", part))
    .timeout(std::time::Duration::from_secs(600))
    .send()
    .await
    .map_err(|e| format!("Couldn't reach your reader: {}", e))?;
  if !resp.status().is_success() {
    let text = resp.text().await.unwrap_or_default();
    return Err(if text.to_ascii_lowercase().contains("already exists") {
      "Already on your reader".into()
    } else if text.trim().is_empty() {
      "Upload failed".into()
    } else {
      text.trim().to_string()
    });
  }
  Ok(name.to_string())
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn unique_name(dir: &PathBuf, name: &str) -> String {
  if !dir.join(name).exists() {
    return name.to_string();
  }
  let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
  (1..)
    .map(|n| if ext.is_empty() { format!("{} ({})", stem, n) } else { format!("{} ({}).{}", stem, n, ext) })
    .find(|c| !dir.join(c).exists())
    .unwrap()
}

fn ext_from_href(href: &str) -> Option<String> {
  let path = href.split(['?', '#']).next().unwrap_or(href);
  let ext = path.rsplit('/').next()?.rsplit_once('.')?.1;
  (2..=5).contains(&ext.len()).then_some(()).filter(|_| ext.chars().all(|c| c.is_ascii_alphanumeric()))?;
  Some(ext.to_ascii_lowercase())
}

fn ext_from_mime(mime: &str) -> Option<&'static str> {
  match mime.split(';').next().unwrap_or("").trim() {
    "application/epub+zip" => Some("epub"),
    "application/pdf" => Some("pdf"),
    "application/x-mobipocket-ebook" => Some("mobi"),
    "application/vnd.amazon.ebook" => Some("azw3"),
    "application/x-cbz" | "application/vnd.comicbook+zip" => Some("cbz"),
    "text/plain" => Some("txt"),
    "text/markdown" => Some("md"),
    _ => None,
  }
}

fn mime_for(name: &str) -> &'static str {
  match name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
    Some("epub") => "application/epub+zip",
    Some("txt") => "text/plain",
    Some("md") => "text/markdown",
    _ => "application/octet-stream",
  }
}

fn urlencoding_encode(s: &str) -> String {
  s.bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
      _ => format!("%{:02X}", b),
    })
    .collect()
}

fn urlencoding_decode(s: &str) -> Option<String> {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' {
      out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resolves_extensions_and_names() {
    assert_eq!(ext_from_href("https://x.org/b/1342.epub?x=1").as_deref(), Some("epub"));
    // Gutenberg-style suffixes aren't extensions; the MIME type decides.
    assert_eq!(ext_from_href("https://m.gutenberg.org/ebooks/1342.epub3.images"), None);
    assert_eq!(ext_from_mime("application/epub+zip; charset=x"), Some("epub"));
    assert!(safe_name("../../etc/passwd").is_err()); // path tricks never escape the folder
    assert_eq!(safe_name("a/../b.epub").unwrap(), "a..b.epub");
    assert!(safe_name(".crosspoint-sync.json").is_err());
    assert_eq!(urlencoding_decode(&urlencoding_encode("/Books/Été 1.epub")).unwrap(), "/Books/Été 1.epub");
  }
}


