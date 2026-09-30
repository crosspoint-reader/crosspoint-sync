mod books;
mod mdns;
mod opds;
mod optimizer;
mod widget;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Requests go through Rust so self-hosted servers work over plain http and
    // regardless of the server's CORS_ORIGINS (the webview would block both).
    .plugin(tauri_plugin_http::init())
    // Opens share-intent links (X, Bluesky...) in the user's browser.
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      mdns::resolve_local,
      books::opds_feed,
      books::opds_search,
      books::download_book,
      books::list_downloads,
      books::delete_download,
      books::send_download,
      books::send_bytes,
      books::save_file,
      widget::update_widget,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
