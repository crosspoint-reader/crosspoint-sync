package com.crosspointreader.sync

import android.content.ClipData
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import java.io.File

class MainActivity : TauriActivity() {
  // Android drops incoming multicast unless the app holds a MulticastLock;
  // without it the Rust mDNS fallback never hears crosspoint.local answer.
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
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
    webView.addJavascriptInterface(ShareBridge(), "CrossPointShare")
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
