package com.crosspointreader.sync

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File

// Home screen widget: the current book and reading totals. The app pushes the
// data through window.CrossPointWidget.update (MainActivity) whenever it loads.
class ReadingWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { manager.updateAppWidget(it, render(context)) }
  }

  companion object {
    const val PREFS = "reading_widget"
    const val COVER = "widget_cover.png"

    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, ReadingWidget::class.java))
      ids.forEach { manager.updateAppWidget(it, render(context)) }
    }

    private fun render(context: Context): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.reading_widget)
      val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("data", null)
      val data = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
      if (data == null) {
        views.setTextViewText(R.id.widget_label, "CROSSPOINT SYNC")
        views.setTextViewText(R.id.widget_title, "Open the app to sign in")
        views.setViewVisibility(R.id.widget_progress, View.GONE)
      } else {
        val percent = data.optInt("percent", -1)
        views.setTextViewText(R.id.widget_label, data.optString("label", "CONTINUE READING"))
        views.setTextViewText(R.id.widget_title, data.optString("title"))
        views.setTextViewText(R.id.widget_author, data.optString("author"))
        views.setTextViewText(R.id.widget_stats, data.optString("stats"))
        if (percent >= 0) {
          views.setViewVisibility(R.id.widget_progress, View.VISIBLE)
          views.setProgressBar(R.id.widget_progress, 100, percent, false)
          views.setTextViewText(R.id.widget_percent, "$percent%")
        } else {
          views.setViewVisibility(R.id.widget_progress, View.GONE)
          views.setTextViewText(R.id.widget_percent, "")
        }
      }
      val cover = File(context.filesDir, COVER)
      val bitmap = if (data != null && cover.exists()) {
        // Downsample: widget bitmaps travel over IPC and must stay small.
        BitmapFactory.decodeFile(cover.path, BitmapFactory.Options().apply { inSampleSize = 2 })
      } else null
      if (bitmap != null) {
        views.setViewVisibility(R.id.widget_cover, View.VISIBLE)
        views.setImageViewBitmap(R.id.widget_cover, bitmap)
      } else {
        views.setViewVisibility(R.id.widget_cover, View.GONE)
      }
      val open = PendingIntent.getActivity(
        context, 0, Intent(context, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      views.setOnClickPendingIntent(R.id.widget_root, open)
      return views
    }
  }
}
