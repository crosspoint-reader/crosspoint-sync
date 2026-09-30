package com.crosspointreader.sync

import android.app.UiModeManager
import android.content.ClipData
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File

class MainActivity : TauriActivity() {
  companion object {
    private const val PAPER = 0xFFFAFAF9.toInt()
    private const val PAPER_DARK = 0xFF121110.toInt()
  }

  // Android drops incoming multicast unless the app holds a MulticastLock;
  // without it the Rust mDNS fallback never hears crosspoint.local answer.
  private var multicastLock: WifiManager.MulticastLock? = null

  // Android removes the system splash (icon on the page colour) as soon as this
  // window first draws, but the WebView paints the app much later, so the icon
  // only flashed. Hold drawing until the web app calls CrossPointTheme.ready(),
  // capped so a stuck page can never hide behind the splash.
  @Volatile private var webReady = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    val deadline = SystemClock.uptimeMillis() + 3000
    content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
      override fun onPreDraw(): Boolean {
        if (!webReady && SystemClock.uptimeMillis() < deadline) {
          content.postDelayed({ content.invalidate() }, 50)
          return false
        }
        content.viewTreeObserver.removeOnPreDrawListener(this)
        return true
      }
    })
    val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
    multicastLock = wifi.createMulticastLock("crosspoint-mdns").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  override fun onDestroy() {
    multicastLock?.release()
    multicastLock = null
    super.onDestroy()
  }

  // Android's WebView has no Web Share API, so the app shares clipping cards
  // through this bridge: window.CrossPointShare.share(text, pngBase64, title).
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // Paint the page colour until the web app draws, instead of WebView's default black.
    val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    webView.setBackgroundColor(if (night) PAPER_DARK else PAPER)
    webView.addJavascriptInterface(ShareBridge(), "CrossPointShare")
    webView.addJavascriptInterface(WidgetBridge(), "CrossPointWidget")
    webView.addJavascriptInterface(ThemeBridge(), "CrossPointTheme")
  }

  private var webView: WebView? = null
  private var appliedPref: String? = null

  // In-app Appearance: window.CrossPointTheme.apply("system"|"light"|"dark", isDark).
  // The per-app night mode also picks the values-night splash on the next launch.
  inner class ThemeBridge {
    @JavascriptInterface
    fun ready() {
      webReady = true
    }

    @JavascriptInterface
    fun apply(pref: String, dark: Boolean) {
      runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && pref != appliedPref) {
          getSystemService(UiModeManager::class.java).setApplicationNightMode(
            when (pref) {
              "dark" -> UiModeManager.MODE_NIGHT_YES
              "light" -> UiModeManager.MODE_NIGHT_NO
              else -> UiModeManager.MODE_NIGHT_AUTO
            }
          )
          appliedPref = pref
        }
        val color = if (dark) PAPER_DARK else PAPER
        @Suppress("DEPRECATION")
        window.statusBarColor = color
        @Suppress("DEPRECATION")
        window.navigationBarColor = color
        WindowInsetsControllerCompat(window, window.decorView).apply {
          isAppearanceLightStatusBars = !dark
          isAppearanceLightNavigationBars = !dark
        }
        webView?.setBackgroundColor(color)
      }
    }
  }

  // Home screen widget data: window.CrossPointWidget.update(json, coverPngBase64 or "").
  inner class WidgetBridge {
    @JavascriptInterface
    fun update(json: String, coverBase64: String) {
      getSharedPreferences(ReadingWidget.PREFS, MODE_PRIVATE).edit().putString("data", json).apply()
      val cover = File(filesDir, ReadingWidget.COVER)
      if (coverBase64.isEmpty()) cover.delete() else cover.writeBytes(Base64.decode(coverBase64, Base64.DEFAULT))
      ReadingWidget.refresh(this@MainActivity)
    }
  }

  inner class ShareBridge {
    @JavascriptInterface
    fun share(text: String, pngBase64: String, title: String) {
      val dir = File(cacheDir, "share").apply { mkdirs() }
      val file = File(dir, "clipping.png")
      file.writeBytes(Base64.decode(pngBase64, Base64.DEFAULT))
      val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TEXT, text)
        clipData = ClipData.newRawUri(title, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      runOnUiThread { startActivity(Intent.createChooser(send, title)) }
    }
  }
}
