mod mdns;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Requests go through Rust so self-hosted servers work over plain http and
    // regardless of the server's CORS_ORIGINS (the webview would block both).
    .plugin(tauri_plugin_http::init())
    .invoke_handler(tauri::generate_handler![mdns::resolve_local])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
