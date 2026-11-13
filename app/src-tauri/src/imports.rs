use crate::import_store;
use tauri::{AppHandle, ipc::Request};
#[cfg(not(target_os = "ios"))]
use tauri::Manager;
use std::path::PathBuf;

fn queue_dir(_app: &AppHandle) -> Result<PathBuf, String> {
  #[cfg(target_os = "ios")]
  { return crate::widget::group_dir().map(|p| p.join("ImportQueue")).ok_or("App Group container unavailable".into()); }
  #[cfg(not(target_os = "ios"))]
  { Ok(_app.path().app_data_dir().map_err(|e| e.to_string())?.join("ImportQueue")) }
}
#[derive(serde::Serialize)]
pub struct Import { id: String, name: String, size: u64 }
impl From<import_store::Entry> for Import {
  fn from(e: import_store::Entry) -> Self { Self { id: e.id, name: e.name, size: e.size } }
}
#[tauri::command]
pub async fn list_imports(app: AppHandle) -> Result<Vec<Import>, String> {
  import_store::list(&queue_dir(&app)?).map(|v| v.into_iter().map(Into::into).collect()).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn add_import(app: AppHandle, request: Request<'_>) -> Result<Import, String> {
  let name = request.headers().get("x-name").and_then(|v| v.to_str().ok())
    .and_then(crate::books::urlencoding_decode).ok_or("Missing file name")?;
  let bytes = crate::books::body_bytes(&request)?;
  import_store::add(&queue_dir(&app)?, &name, &bytes).map(Into::into).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn read_import(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
  import_store::read(&queue_dir(&app)?, &id).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn remove_import(app: AppHandle, id: String) -> Result<(), String> {
  import_store::remove(&queue_dir(&app)?, &id).map_err(|e| e.to_string())
}

// Open In is delivered by tao on both cold and warm launches. Copy while the
// system's security-scoped grant is active, before the URL leaves native code.
#[cfg(target_os = "ios")]
pub fn open(app: &AppHandle, url: &url::Url) {
  use objc2_foundation::{NSString, NSURL};
  use tauri::Emitter;
  if url.scheme() != "file" { return }
  let result = (|| -> Result<(), String> {
    let native = NSURL::URLWithString(&NSString::from_str(url.as_str())).ok_or("Invalid file URL")?;
    let access = unsafe { native.startAccessingSecurityScopedResource() };
    let result = (|| {
      let path = url.to_file_path().map_err(|_| "Invalid file URL")?;
      let name = path.file_name().and_then(|s| s.to_str()).ok_or("Invalid file name")?;
      if !import_store::valid_name(name) { return Err("Choose books, TTF/OTF/CPFONT fonts, or PNG/JPG/WebP/GIF/BMP sleep screens".into()); }
      let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
      import_store::add(&queue_dir(app)?, name, &bytes).map_err(|e| e.to_string())?;
      Ok(())
    })();
    if access { unsafe { native.stopAccessingSecurityScopedResource() }; }
    result
  })();
  if let Err(error) = result { let _ = app.emit("import-error", error); }
}
