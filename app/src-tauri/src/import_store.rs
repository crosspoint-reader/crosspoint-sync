//! On-disk interchange with Android and the iOS Share extension. A committed
//! entry is a unique directory containing one original-named file; dot-prefixed
//! staging directories are invisible until the producer atomically renames them.
use std::{fs, io, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

#[derive(Debug, Clone)]
pub struct Entry { pub id: String, pub name: String, pub size: u64 }
fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, "Invalid queued file") }
pub fn valid_name(name: &str) -> bool {
  !name.is_empty() && !name.starts_with('.') && !name.chars().any(|c| c == '/' || c == '\\' || c.is_control()) &&
    name.rsplit_once('.').is_some_and(|(_, ext)| ["epub", "acsm", "md", "txt", "ttf", "otf", "cpfont", "png", "jpg", "jpeg", "webp", "gif", "bmp"].contains(&ext.to_ascii_lowercase().as_str()))
}
fn entry_dir(root: &Path, id: &str) -> io::Result<PathBuf> {
  if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err(invalid()); }
  let dir = root.join(id);
  if fs::symlink_metadata(&dir)?.file_type().is_symlink() { return Err(invalid()); }
  Ok(dir)
}
pub fn list(root: &Path) -> io::Result<Vec<Entry>> {
  fs::create_dir_all(root)?;
  let mut entries = Vec::new();
  for item in fs::read_dir(root)? {
    let item = item?;
    let id = item.file_name().to_string_lossy().into_owned();
    let Ok(dir) = entry_dir(root, &id) else { continue };
    if !item.file_type()?.is_dir() { continue }
    // Another consumer may finish/remove an entry during a list operation.
    let Ok(contents) = fs::read_dir(dir) else { continue };
    for file in contents {
      let Ok(file) = file else { continue };
      let name = file.file_name().to_string_lossy().into_owned();
      if valid_name(&name) && file.file_type().is_ok_and(|t| t.is_file()) {
        let Ok(meta) = file.metadata() else { continue };
        entries.push(Entry { id: id.clone(), name, size: meta.len() });
        break;
      }
    }
  }
  entries.sort_by(|a, b| a.id.cmp(&b.id));
  Ok(entries)
}
pub fn read(root: &Path, id: &str) -> io::Result<Vec<u8>> {
  let dir = entry_dir(root, id)?;
  let entry = list(root)?.into_iter().find(|e| e.id == id).ok_or_else(invalid)?;
  fs::read(dir.join(entry.name))
}
pub fn remove(root: &Path, id: &str) -> io::Result<()> {
  let dir = entry_dir(root, id)?;
  fs::remove_dir_all(dir)
}
pub fn add(root: &Path, name: &str, bytes: &[u8]) -> io::Result<Entry> {
  if !valid_name(name) { return Err(invalid()) }
  fs::create_dir_all(root)?;
  static NEXT: AtomicU64 = AtomicU64::new(0);
  let id = format!("{}-{}-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(), std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
  let temp = root.join(format!(".{id}"));
  fs::create_dir(&temp)?;
  let result = (|| {
    fs::write(temp.join(name), bytes)?;
    fs::rename(&temp, root.join(&id))?;
    Ok(Entry { id, name: name.into(), size: bytes.len() as u64 })
  })();
  if result.is_err() { let _ = fs::remove_dir_all(temp); }
  result
}

#[cfg(test)]
mod tests {
  use super::*;
  fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("crosspoint-import-test-{}-{:?}", std::process::id(), std::thread::current().id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap(); root
  }
  #[test]
  fn same_names_survive_restart_and_independent_removal() {
    let root = root();
    let first = add(&root, "Été.EPUB", b"one").unwrap();
    let second = add(&root, "Été.EPUB", b"two").unwrap();
    assert_eq!(list(&root).unwrap().len(), 2);
    assert_eq!(read(&root, &first.id).unwrap(), b"one");
    remove(&root, &first.id).unwrap();
    assert_eq!(read(&root, &second.id).unwrap(), b"two");
    assert_eq!(list(&root).unwrap().len(), 1);
    fs::remove_dir_all(root).unwrap();
  }
  #[test]
  fn rejects_traversal_unsupported_files_and_incomplete_copies() {
    let root = root();
    for name in ["../book.epub", "folder/book.txt", "a\\b.md", ".hidden.epub", "photo.heic", "bad\n.txt"] {
      assert!(add(&root, name, b"bad").is_err(), "{name}");
    }
    fs::create_dir(root.join(".partial")).unwrap();
    fs::write(root.join(".partial/book.epub"), b"partial").unwrap();
    assert!(list(&root).unwrap().is_empty());
    assert!(read(&root, "../elsewhere").is_err());
    assert!(remove(&root, "..").is_err());
    for name in ["book.epub", "loan.acsm", "notes.md", "notes.TXT", "font.TTF", "font.otf", "font.cpfont", "sleep.PNG", "sleep.jpg", "sleep.jpeg", "sleep.webp", "sleep.gif", "sleep.bmp"] { add(&root, name, b"ok").unwrap(); }
    assert_eq!(list(&root).unwrap().len(), 13);
    fs::remove_dir_all(root).unwrap();
  }
}
