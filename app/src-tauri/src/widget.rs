//! iOS home screen widget data: the app hands over the current book and
//! stats, and this writes them into the App Group container the WidgetKit
//! extension (gen/apple/CrossPointWidget) reads. Android uses a JS bridge in
//! MainActivity instead; elsewhere there's no widget, so this is a no-op.

#[tauri::command]
pub fn update_widget(json: String, cover: String) -> Result<(), String> {
  #[cfg(target_os = "ios")]
  {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::os::fd::AsRawFd;
    let dir = group_dir().ok_or("App Group container unavailable")?;
    // Shared with the extension. Its refresh checks the old snapshot under this
    // lock before publishing, so a request finishing after logout cannot revive it.
    extern "C" { fn flock(fd: i32, operation: i32) -> i32; }
    struct Lock(std::fs::File);
    impl Drop for Lock {
      fn drop(&mut self) { unsafe { flock(self.0.as_raw_fd(), 8); } }
    }
    let file = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(dir.join("widget.lock")).map_err(|e| e.to_string())?;
    if unsafe { flock(file.as_raw_fd(), 2) } != 0 { return Err("Widget snapshot lock unavailable".into()); }
    let guard = Lock(file);
    let cover_path = dir.join("cover.png");
    if cover.is_empty() {
      let incoming = serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
      let previous = std::fs::read(dir.join("widget.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
      // An offline app update may have no image bytes. Keep the saved cover
      // only when its account, document and exact URL still identify this book.
      let same_cover = previous.as_ref().is_some_and(|old| matching_cover(&incoming, old));
      if !same_cover { let _ = std::fs::remove_file(cover_path); }
    } else {
      let temp = dir.join("cover.tmp");
      std::fs::write(&temp, STANDARD.decode(cover).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
      std::fs::rename(temp, cover_path).map_err(|e| e.to_string())?;
    }
    let temp = dir.join("widget.tmp");
    std::fs::write(&temp, json).map_err(|e| e.to_string())?;
    std::fs::rename(temp, dir.join("widget.json")).map_err(|e| e.to_string())?;
    drop(guard);
    // Redraw now rather than at the widget's next scheduled refresh.
    unsafe { crosspoint_reload_widgets() };
  }
  #[cfg(not(target_os = "ios"))]
  let _ = (json, cover);
  Ok(())
}

#[cfg(target_os = "ios")]
extern "C" {
  // gen/apple/Sources/crosspoint-sync-app/WidgetReload.swift
  fn crosspoint_reload_widgets();
}

#[cfg(target_os = "ios")]
#[allow(unused_unsafe)]
pub(crate) fn group_dir() -> Option<std::path::PathBuf> {
  use objc2_foundation::{NSFileManager, NSString};
  let manager = unsafe { NSFileManager::defaultManager() };
  let url = unsafe { manager.containerURLForSecurityApplicationGroupIdentifier(&NSString::from_str("group.com.crosspointreader.sync")) }?;
  let path = unsafe { url.path() }?;
  Some(path.to_string().into())
}

/// Credential-free offline data in private Application Support storage, read by
/// App Intents in the main app process (no App Group entitlement required). Writes are atomic so
/// Shortcuts never sees a partially written library. `None` clears it on logout.
#[tauri::command]
pub fn update_shortcuts(app: tauri::AppHandle, json: Option<String>) -> Result<(), String> {
  #[cfg(target_os = "ios")]
  {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = crate::shortcuts_cache::snapshot_dir(&app_data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::shortcuts_cache::publish(&dir, json.as_deref()).map_err(|e| e.to_string())?;
  }
  #[cfg(not(target_os = "ios"))]
  let _ = (app, json);
  Ok(())
}

// Kept independent of the iOS filesystem so identity boundaries are testable.
#[cfg(any(target_os = "ios", test))]
fn matching_cover(incoming: &serde_json::Value, previous: &serde_json::Value) -> bool {
  // Credentials can rotate without changing the account that owns the image.
  ["server", "username"].iter().all(|key|
    incoming["session"][*key].is_string() && incoming["session"][*key] == previous["session"][*key]) &&
    ["book_document", "cover_url"].iter().all(|key|
      !incoming[*key].is_null() && incoming[*key] == previous[*key])
}

#[cfg(test)]
mod cover_tests {
  use super::matching_cover;
  use serde_json::json;

  #[test]
  fn retains_only_the_exact_account_book_and_cover() {
    let saved = json!({"session": {"server": "https://sync.test", "username": "reader", "key": "secret"},
      "book_document": "book-a", "cover_url": "https://covers.test/a.jpg", "percent": 40});
    let mut updated = saved.clone();
    updated["percent"] = json!(50);
    assert!(matching_cover(&updated, &saved));
    updated["session"]["key"] = json!("rotated-secret");
    assert!(matching_cover(&updated, &saved), "password rotation keeps the same cover");
    for (key, value) in [("book_document", json!("book-b")), ("cover_url", json!("https://covers.test/fixed.jpg")),
      ("session", json!({"server": "https://sync.test", "username": "other", "key": "secret"})),
      ("session", json!({"server": "https://other.test", "username": "reader", "key": "secret"}))] {
      let mut changed = updated.clone();
      changed[key] = value;
      assert!(!matching_cover(&changed, &saved), "changed {key}");
    }
    for key in ["session", "book_document", "cover_url"] {
      let mut cleared = updated.clone();
      cleared.as_object_mut().unwrap().remove(key);
      assert!(!matching_cover(&cleared, &saved), "missing {key}");
      assert!(!matching_cover(&saved, &cleared), "legacy missing {key}");
    }
    assert!(!matching_cover(&json!({}), &saved));
  }
}
