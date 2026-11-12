package com.crosspointreader.sync

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import java.io.File

/** Same atomic directory format as Rust import_store and iOS ImportStore. */
internal object IncomingFiles {
  @Suppress("DEPRECATION")
  fun uris(intent: Intent): List<Uri> {
    val streams: List<Uri> = when (intent.action) {
      Intent.ACTION_VIEW -> listOfNotNull(intent.data)
      Intent.ACTION_SEND -> listOfNotNull(if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
      Intent.ACTION_SEND_MULTIPLE -> (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
      else -> return emptyList()
    }
    val clips = intent.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } } ?: emptyList()
    return (streams + clips).filter { it.scheme == "content" || it.scheme == "file" }.distinct()
  }

  fun copy(context: Context, uri: Uri, id: String) {
    require(id.matches(Regex("[a-zA-Z0-9-]+")))
    // Persist completion separately from the queue: rotating or restoring the
    // activity must not resurrect a file the user already sent or removed.
    val delivered = context.getSharedPreferences("import-deliveries", Context.MODE_PRIVATE)
    if (delivered.getBoolean(id, false)) return
    val root = File(context.applicationInfo.dataDir, "ImportQueue").apply { check(mkdirs() || isDirectory) }
    val destination = File(root, id)
    // A prior process may have died after publish but before recording delivery.
    if (destination.isDirectory) {
      check(delivered.edit().putBoolean(id, true).commit()) { "Couldn't record imported file" }
      return
    }
    val resolver = context.contentResolver
    val displayName = if (uri.scheme == "content") {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
      }
    } else null
    val name = displayName ?: uri.lastPathSegment ?: throw IllegalArgumentException("Missing file name")
    require(validName(name)) { "Choose EPUB, Markdown, text or ACSM files: $name" }
    // Tauri PathPlugin.getDataDir resolves applicationInfo.dataDir, not filesDir.
    val staging = File(root, ".$id")
    staging.deleteRecursively() // Retry an incomplete copy after process death.
    check(staging.mkdir()) { "Couldn't create import folder" }
    try {
      resolver.openInputStream(uri)?.use { input ->
        File(staging, name).outputStream().use { output -> input.copyTo(output) }
      } ?: throw IllegalArgumentException("Couldn't read $name")
      check(staging.renameTo(destination)) { "Couldn't save $name" }
      check(delivered.edit().putBoolean(id, true).commit()) { "Couldn't record imported file" }
    } catch (error: Exception) {
      staging.deleteRecursively()
      throw error
    }
  }

  private fun validName(name: String): Boolean =
    name.isNotEmpty() && !name.startsWith('.') && name.none { it == '/' || it == '\\' || it.isISOControl() } &&
      name.substringAfterLast('.', "").lowercase() in setOf("epub", "acsm", "md", "txt")
}
