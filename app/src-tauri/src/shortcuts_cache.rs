//! Atomic publication for the credential-free App Intents snapshot.
use std::{path::Path, sync::Mutex};

static WRITES: Mutex<()> = Mutex::new(());

pub fn snapshot_dir(app_data_dir: &Path) -> std::path::PathBuf {
  app_data_dir.join("Shortcuts")
}

pub fn publish(dir: &Path, json: Option<&str>) -> Result<(), std::io::Error> {
  let _lock = WRITES.lock().unwrap_or_else(|e| e.into_inner());
  let path = dir.join("shortcuts.json");
  if let Some(json) = json {
    let temp = dir.join("shortcuts.json.tmp");
    std::fs::write(&temp, json)?;
    std::fs::rename(temp, path)
  } else {
    match std::fs::remove_file(path) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(e),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn private_snapshot_directory_matches_native_reader() {
    assert_eq!(snapshot_dir(Path::new("/sandbox/Library/Application Support/com.crosspointreader.sync")),
      Path::new("/sandbox/Library/Application Support/com.crosspointreader.sync/Shortcuts"));
  }
  #[test]
  fn replaces_and_clears_snapshots_without_leaving_partial_files() {
    let dir = std::env::temp_dir().join(format!("crosspoint-shortcuts-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    publish(&dir, Some(r#"{"books":["one"]}"#)).unwrap();
    publish(&dir, Some(r#"{"books":[]}"#)).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("shortcuts.json")).unwrap(), r#"{"books":[]}"#);
    assert!(!dir.join("shortcuts.json.tmp").exists());
    // A failed write must preserve the previous complete snapshot.
    std::fs::create_dir(dir.join("shortcuts.json.tmp")).unwrap();
    assert!(publish(&dir, Some("partial")).is_err());
    assert_eq!(std::fs::read_to_string(dir.join("shortcuts.json")).unwrap(), r#"{"books":[]}"#);
    std::fs::remove_dir(dir.join("shortcuts.json.tmp")).unwrap();
    publish(&dir, None).unwrap();
    publish(&dir, None).unwrap();
    assert!(!dir.join("shortcuts.json").exists());
    std::fs::remove_dir(dir).unwrap();
  }
}
