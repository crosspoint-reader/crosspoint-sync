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

// Acquire and retain the source grant before returning to the event loop. Both
// provider coordination (which can wait for iCloud) and disk I/O run on a worker.
#[cfg(target_os = "ios")]
pub fn open(app: &AppHandle, url: &url::Url) {
  use crate::coordinated_import::ScopedSource;
  use tauri::Emitter;
  if url.scheme() != "file" { return }
  let prepare = (|| -> Result<_, String> {
    let path = url.to_file_path().map_err(|_| "Invalid file URL")?;
    let name = path.file_name().and_then(|s| s.to_str()).ok_or("Invalid file name")?.to_owned();
    if !import_store::valid_name(&name) { return Err("Choose books, TTF/OTF/CPFONT fonts, or PNG/JPG/WebP/GIF/BMP sleep screens".into()); }
    Ok((ScopedSource::acquire(url)?, name))
  })();
  match prepare {
    Err(error) => { let _ = app.emit("import-error", error); }
    Ok((source, name)) => {
      let app = app.clone();
      tauri::async_runtime::spawn_blocking(move || objc2::rc::autoreleasepool(|_| {
        let result = queue_dir(&app).and_then(|root| source.import_into(&root, &name));
        // source owns its security grant until this worker completes, including
        // any failed coordination/read/publication path (released by Drop).
        if let Err(error) = result { let _ = app.emit("import-error", error); }
        drop(source); // release the scope inside the worker autorelease pool
      }));
    }
  }
}
