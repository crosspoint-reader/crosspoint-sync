mod books;
mod epub_name;
mod mdns;
mod opds;
mod optimizer;
mod refresh;
mod widget;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Requests go through Rust so self-hosted servers work over plain http and
    // regardless of the server's CORS_ORIGINS (the webview would block both).
    .plugin(tauri_plugin_http::init())
    // Opens share-intent links (X, Bluesky...) in the user's browser.
    .plugin(tauri_plugin_opener::init())
    // https app links back from browser sign-in (OAuth callbacks).
    .plugin(tauri_plugin_deep_link::init())
    // Taps and bumps for drag-to-reorder (iOS and Android; no-op elsewhere).
    .plugin(tauri_plugin_haptics::init())
    // Native UITabBar over the webview on iPhone (Liquid Glass on iOS 26).
    .plugin(tauri_plugin_system_components::init())
    .setup(|_app| {
      #[cfg(target_os = "ios")]
      native_scroll(_app)?;
      #[cfg(target_os = "ios")]
      refresh::install(_app)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      mdns::resolve_local,
      books::opds_feed,
      books::opds_search,
      books::opds_image,
      books::download_book,
      books::list_downloads,
      books::delete_download,
      books::send_download,
      books::send_bytes,
      books::save_file,
      widget::update_widget,
      set_appearance,
      set_page_scroll,
      refresh::end_refresh,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// iOS scroll view: wry turns off bounce, but native apps rubber-band (even on pages too
// short to scroll).
#[cfg(target_os = "ios")]
fn native_scroll(app: &tauri::App) -> tauri::Result<()> {
  use tauri::Manager;
  let Some(window) = app.get_webview_window("main") else { return Ok(()) };
  window.with_webview(|webview| unsafe {
    use objc2::{msg_send, runtime::AnyObject};
    let view = &*(webview.inner() as *const AnyObject);
    let scroll: *mut AnyObject = msg_send![view, scrollView];
    let _: () = msg_send![scroll, setBounces: true];
    let _: () = msg_send![scroll, setAlwaysBounceVertical: true];
  })
}

// iOS: the page stops bouncing (so it can't pull to refresh) while a sheet is open;
// CSS overflow:hidden already stops it scrolling. Not setScrollEnabled: that also
// freezes the sheet's own scroller, cutting off sheets taller than the screen.
#[tauri::command]
fn set_page_scroll(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
  #[cfg(target_os = "ios")]
  window
    .with_webview(move |webview| unsafe {
      use objc2::{msg_send, runtime::AnyObject};
      let view = &*(webview.inner() as *const AnyObject);
      let scroll: *mut AnyObject = msg_send![view, scrollView];
      let _: () = msg_send![scroll, setBounces: enabled];
      let _: () = msg_send![scroll, setAlwaysBounceVertical: enabled];
    })
    .map_err(|e| e.to_string())?;
  #[cfg(not(target_os = "ios"))]
  let _ = (window, enabled);
  Ok(())
}

// The in-app Appearance choice for native UI on iOS: status bar text, the tab bar,
// the keyboard. Tauri's setTheme doesn't reach iOS. "light" | "dark" | "system".
// Also paints the native backdrop (window, webview, overscroll) in the page colour.
#[tauri::command]
fn set_appearance(window: tauri::WebviewWindow, pref: String, dark: bool) -> Result<(), String> {
  #[cfg(target_os = "ios")]
  window
    .with_webview(move |webview| unsafe {
      use objc2::{class, msg_send, runtime::AnyObject};
      let view = &*(webview.inner() as *const AnyObject);
      let win: *mut AnyObject = msg_send![view, window];
      // theme.js PAGE: #fafaf9 light, #121110 dark.
      let (r, g, b) = if dark { (0x12, 0x11, 0x10) } else { (0xfa, 0xfa, 0xf9) };
      let page: *mut AnyObject = msg_send![class!(UIColor), colorWithRed: r as f64 / 255.0, green: g as f64 / 255.0, blue: b as f64 / 255.0, alpha: 1.0f64];
      let _: () = msg_send![view, setBackgroundColor: page];
      let _: () = msg_send![view, setUnderPageBackgroundColor: page];
      let scroll: *mut AnyObject = msg_send![view, scrollView];
      let _: () = msg_send![scroll, setBackgroundColor: page];
      // UIUserInterfaceStyle: 0 unspecified (follow the system), 1 light, 2 dark.
      let style: isize = match pref.as_str() { "light" => 1, "dark" => 2, _ => 0 };
      if !win.is_null() {
        let _: () = msg_send![win, setOverrideUserInterfaceStyle: style];
        let _: () = msg_send![win, setBackgroundColor: page];
      }
    })
    .map_err(|e| e.to_string())?;
  #[cfg(not(target_os = "ios"))]
  let _ = (window, pref, dark);
  Ok(())
}
