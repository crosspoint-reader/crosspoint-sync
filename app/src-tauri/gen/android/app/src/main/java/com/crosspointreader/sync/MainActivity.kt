package com.crosspointreader.sync

import android.net.wifi.WifiManager
import android.os.Bundle

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
}
