//! iOS home screen widget data: the app hands over the current book and
//! stats, and this writes them into the App Group container the WidgetKit
//! extension (gen/apple/CrossPointWidget) reads. Android uses a JS bridge in
//! MainActivity instead; elsewhere there's no widget, so this is a no-op.

#[tauri::command]
pub fn update_widget(json: String, cover: String) -> Result<(), String> {
  #[cfg(target_os = "ios")]
  {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let dir = group_dir().ok_or("App Group container unavailable")?;
    std::fs::write(dir.join("widget.json"), json).map_err(|e| e.to_string())?;
    let cover_path = dir.join("cover.png");
    if cover.is_empty() {
      let _ = std::fs::remove_file(cover_path);
    } else {
      std::fs::write(cover_path, STANDARD.decode(cover).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
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
fn group_dir() -> Option<std::path::PathBuf> {
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
