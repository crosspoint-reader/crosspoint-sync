package com.crosspointreader.sync

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.roundToInt

open class ReadingWidget : AppWidgetProvider() {
  protected open val focus = "reading"
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    manager.updateAppWidget(id, render(context, manager, id, focus))
  }
  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == Intent.ACTION_DATE_CHANGED || intent.action == Intent.ACTION_TIMEZONE_CHANGED || intent.action == Intent.ACTION_TIME_CHANGED) refresh(context)
  }
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { manager.updateAppWidget(it, render(context, manager, it, focus)) }
    if (!fetching.compareAndSet(false, true)) return
    val pending = goAsync()
    Thread {
      try { if (fetch(context)) refresh(context) }
      catch (_: Exception) { /* Transient failures retain the last snapshot. */ }
      finally { fetching.set(false); pending.finish() }
    }.start()
  }

  companion object {
    const val PREFS = "reading_widget"
    const val COVER = "widget_cover.png"
    private val lock = Any()
    private val fetching = AtomicBoolean(false)
    private class Unauthorized : Exception()
    private fun day(calendar: Calendar = Calendar.getInstance()): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(calendar.time)
    private fun year(): Int = Calendar.getInstance().get(Calendar.YEAR)
    private fun currentStreak(data: JSONObject): Int {
      if (data.optString("snapshot_day") == day()) return data.optInt("current_streak")
      val dates = data.optJSONArray("history_days") ?: return if (data.optString("snapshot_day") == day()) data.optInt("current_streak") else 0
      if (dates.length() == 0) return if (data.optString("snapshot_day") == day()) data.optInt("current_streak") else 0
      val known = (0 until dates.length()).map { dates.optString(it) }.toSet()
      val cursor = Calendar.getInstance()
      val yesterday = Calendar.getInstance().apply { add(Calendar.DATE, -1) }
      if (data.optString("snapshot_day") == day(yesterday) && known.contains(day(yesterday))) return data.optInt("current_streak")
      if (!known.contains(day(cursor))) cursor.add(Calendar.DATE, -1)
      var count = 0
      while (known.contains(day(cursor))) { count++; cursor.add(Calendar.DATE, -1) }
      return count
    }
    private fun get(session: JSONObject, path: String): JSONObject? {
      val conn = URL(session.getString("server") + path).openConnection() as HttpURLConnection
      conn.connectTimeout = 10_000
      conn.readTimeout = 10_000
      conn.setRequestProperty("x-auth-user", session.getString("username"))
      conn.setRequestProperty("x-auth-key", session.getString("key"))
      conn.setRequestProperty("accept", "application/json")
      return try {
        if (conn.responseCode == 401) throw Unauthorized()
        if (conn.responseCode == 200) JSONObject(conn.inputStream.bufferedReader().use { it.readText() }) else null
      } finally { conn.disconnect() }
    }
    fun saveFromApp(context: Context, json: String, coverBase64: String) {
      synchronized(lock) {
        val file = File(context.filesDir, COVER)
        if (coverBase64.isEmpty()) file.delete() else file.writeBytes(Base64.decode(coverBase64, Base64.DEFAULT))
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("data", json).apply()
      }
      refresh(context)
    }
    private fun allBooks(session: JSONObject): JSONArray? {
      val items = JSONArray()
      val seen = mutableSetOf<String>()
      var path = "/api/v1/progress?limit=500&include_history=1"
      while (true) {
        val page = get(session, path) ?: return null
        val batch = page.optJSONArray("items") ?: return null
        for (n in 0 until batch.length()) items.put(batch.getJSONObject(n))
        val next = page.takeUnless { it.isNull("next") }?.optString("next")?.takeIf { it.isNotEmpty() } ?: return items
        if (!seen.add(next)) return null
        path = "/api/v1/progress?limit=500&include_history=1&cursor=" + URLEncoder.encode(next, "UTF-8")
      }
    }
    private fun fetch(context: Context): Boolean {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val original = synchronized(lock) { prefs.getString("data", null) } ?: return false
      var data = JSONObject(original)
      val session = data.optJSONObject("session") ?: return false
      var changedCover = false
      var cover: ByteArray? = null
      try {
        val tz = -TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        var loaded = 0
        get(session, "/api/v1/stats/overview?tz=$tz")?.let { o ->
          loaded++
          val seconds = o.optDouble("seconds", 0.0)
          data.put("stats", if (seconds >= 60) "${o.optInt("current_streak")}-day streak · ${(seconds / 3600).roundToInt()}h read"
            else "${NumberFormat.getIntegerInstance().format(o.optInt("pages_read"))} pages · ${o.optInt("finished_this_year")} finished this year")
          val dates = JSONArray()
          val bytes = Base64.decode(o.optString("history_b64"), Base64.DEFAULT)
          val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { clear(); set(2000, 0, 1); add(Calendar.DATE, o.optInt("anchor_day")) }
          val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
          for (n in 0 until bytes.size * 8) {
            if ((bytes[n / 8].toInt() and (1 shl (n % 8))) != 0) dates.put(fmt.format(utc.time))
            utc.add(Calendar.DATE, -1)
          }
          data.put("history_days", dates).put("history_known", true).put("current_streak", o.optInt("current_streak"))
            .put("longest_streak", o.optInt("longest_streak")).put("snapshot_day", day())
        }
        get(session, "/api/v1/account/reading-goals?tz=$tz")?.let { g ->
          loaded++
          val goals = g.optJSONArray("goals") ?: JSONArray()
          val goal = (0 until goals.length()).map { goals.getJSONObject(it) }.firstOrNull { it.optInt("year") == year() }
          data.put("goal", goal ?: JSONObject.NULL).put("goals", goals).put("goal_supported", true).put("recent_finished", g.optJSONArray("recent_finished") ?: JSONArray())
          data.put("recent_finished_year", g.optInt("year"))
        }
        allBooks(session)?.let { items ->
          loaded++
          val current = (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull { it.optString("status") == "reading" && title(it) != null }
          data.put("label", if (current == null) "CROSSPOINT SYNC" else "CONTINUE READING")
            .put("title", current?.let { title(it) } ?: "Nothing in progress")
            .put("author", current?.takeUnless { it.isNull("author") }?.optString("author") ?: "")
            .put("percent", current?.let { ((it.optDouble("percentage", 0.0).takeIf { value -> value.isFinite() } ?: 0.0).coerceIn(0.0, 1.0) * 100).roundToInt() } ?: -1)
            .put("book_document", current?.optString("document") ?: JSONObject.NULL)
          val url = current?.takeUnless { it.isNull("cover_url") }?.optString("cover_url")
          val old = data.takeUnless { it.isNull("cover_url") }?.optString("cover_url")
          changedCover = url != old
          if (changedCover && url != null) cover = runCatching { coverPng(url) }.getOrNull()
          if (!changedCover || cover != null || url == null) data.put("cover_url", url ?: JSONObject.NULL)
        }
        if (loaded == 0) return false
        if (loaded == 3) data.put("updated_at", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(java.util.Date()))
      } catch (_: Unauthorized) {
        data = JSONObject().put("label", "CROSSPOINT SYNC").put("title", "Sign in to see your reading").put("percent", -1)
        changedCover = true
      }
      synchronized(lock) {
        if (prefs.getString("data", null) != original) return false
        if (changedCover) {
          val file = File(context.filesDir, COVER)
          if (cover == null) file.delete() else file.writeBytes(cover!!)
        }
        prefs.edit().putString("data", data.toString()).apply()
      }
      return true
    }
    private fun title(book: JSONObject): String? = listOf("title", "filename").firstNotNullOfOrNull { k -> book.takeUnless { it.isNull(k) }?.optString(k)?.takeIf { it.isNotEmpty() } }
    private fun coverPng(link: String): ByteArray? {
      val conn = URL(link).openConnection() as HttpURLConnection
      conn.connectTimeout = 10_000
      conn.readTimeout = 10_000
      val src = try { if (conn.responseCode != 200) return null; BitmapFactory.decodeStream(conn.inputStream) } finally { conn.disconnect() } ?: return null
      val out = Bitmap.createBitmap(168, 252, Bitmap.Config.ARGB_8888)
      val scale = max(168f / src.width, 252f / src.height)
      val w = src.width * scale; val h = src.height * scale
      Canvas(out).drawBitmap(src, null, android.graphics.RectF((168 - w) / 2, (252 - h) / 2, (168 + w) / 2, (252 + h) / 2), null)
      return java.io.ByteArrayOutputStream().also { out.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }
    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      listOf(ReadingWidget::class.java to "reading", StreakWidget::class.java to "streak", GoalWidget::class.java to "goal").forEach { (type, focus) ->
        manager.getAppWidgetIds(ComponentName(context, type)).forEach { id -> manager.updateAppWidget(id, render(context, manager, id, focus)) }
      }
    }
    private fun render(context: Context, manager: AppWidgetManager, id: Int, focus: String): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.reading_widget)
      val data = synchronized(lock) { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("data", null)?.let { runCatching { JSONObject(it) }.getOrNull() } }
      val options = manager.getAppWidgetOptions(id)
      val compact = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250) < 220
      val expanded = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110) >= 220
      val short = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110) < 145
      val signedIn = data?.optJSONObject("session") != null
      var destination = "library"
      views.setViewVisibility(R.id.widget_cover, View.GONE)
      views.setViewVisibility(R.id.widget_progress, View.GONE)
      views.setViewVisibility(R.id.widget_progress_row, View.GONE)
      views.setViewVisibility(R.id.widget_author, View.GONE)
      views.setViewVisibility(R.id.widget_history, View.GONE)
      views.setViewVisibility(R.id.widget_detail, View.GONE)
      views.setTextViewText(R.id.widget_author, "")
      views.setTextViewText(R.id.widget_percent, "")
      views.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, if (focus == "reading") (if (expanded) 22f else 16f) else (if (compact) 28f else 36f))
      views.setInt(R.id.widget_title, "setMaxLines", if (expanded) 4 else 2)
      if (!signedIn || data == null) {
        views.setTextViewText(R.id.widget_label, "CROSSPOINT SYNC")
        views.setTextViewText(R.id.widget_title, "Open the app to sign in")
        views.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, 16f)
        views.setTextViewText(R.id.widget_stats, "")
      } else if (focus == "reading") {
        views.setTextViewText(R.id.widget_label, data.optString("label"))
        views.setTextViewText(R.id.widget_title, data.optString("title"))
        if (!short) { views.setViewVisibility(R.id.widget_author, View.VISIBLE); views.setTextViewText(R.id.widget_author, data.optString("author")) }
        views.setTextViewText(R.id.widget_stats, data.optString("stats"))
        views.setViewVisibility(R.id.widget_stats, if (short) View.GONE else View.VISIBLE)
        val percent = data.optInt("percent", -1)
        if (percent >= 0) {
          views.setViewVisibility(R.id.widget_progress, View.VISIBLE)
          views.setViewVisibility(R.id.widget_progress_row, View.VISIBLE)
          views.setProgressBar(R.id.widget_progress, 100, percent.coerceIn(0, 100), false)
          views.setTextViewText(R.id.widget_percent, "$percent%")
        }
        val bitmap = if (!compact) BitmapFactory.decodeFile(File(context.filesDir, COVER).path, BitmapFactory.Options().apply { inSampleSize = 2 }) else null
        if (bitmap != null) { views.setViewVisibility(R.id.widget_cover, View.VISIBLE); views.setImageViewBitmap(R.id.widget_cover, bitmap) }
        if (!data.isNull("book_document")) destination = "book/${data.optString("book_document")}"
        if (expanded && data.optBoolean("history_known")) history(context, views, data, 35)
      } else if (focus == "streak") {
        destination = "stats"
        views.setTextViewText(R.id.widget_label, "READING STREAK")
        if (data.optBoolean("history_known")) {
          val streak = currentStreak(data)
          views.setTextViewText(R.id.widget_title, "$streak ${if (streak == 1) "day" else "days"}")
          views.setTextViewText(R.id.widget_stats, "Longest streak: ${data.optInt("longest_streak")} days")
          history(context, views, data, if (expanded) 35 else 7)
        } else {
          views.setTextViewText(R.id.widget_title, "Your reading days")
          views.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, 18f)
          views.setTextViewText(R.id.widget_stats, "Open the app to sync your history")
        }
      } else {
        val allGoals = data.optJSONArray("goals")
        val goal = if (allGoals != null) (0 until allGoals.length()).map { allGoals.getJSONObject(it) }.firstOrNull { it.optInt("year") == year() }
          else data.optJSONObject("goal")?.takeIf { it.optInt("year") == year() }
        destination = if (goal == null) "settings/goals" else "stats"
        views.setTextViewText(R.id.widget_label, if (goal == null) "YEARLY GOAL · OPTIONAL" else "${year()} READING GOAL")
        if (goal == null) {
          views.setTextViewText(R.id.widget_title, "Read at your own pace")
          views.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, 18f)
          views.setTextViewText(R.id.widget_stats, "Choose a goal in Settings if you’d like")
        } else {
          val target = goal.optInt("target", 1).coerceAtLeast(1)
          val completed = goal.optInt("completed")
          val remaining = max(0, target - completed)
          views.setTextViewText(R.id.widget_title, "$completed of $target")
          views.setTextViewText(R.id.widget_author, "books finished")
          views.setViewVisibility(R.id.widget_author, View.VISIBLE)
          views.setViewVisibility(R.id.widget_progress, View.VISIBLE)
          views.setViewVisibility(R.id.widget_progress_row, View.VISIBLE)
          views.setProgressBar(R.id.widget_progress, target, completed.coerceIn(0, target), false)
          views.setTextViewText(R.id.widget_stats, if (remaining == 0) "Goal reached" else "$remaining ${if (remaining == 1) "book" else "books"} to go")
          if (expanded) {
            val recent = if (data.optInt("recent_finished_year") == year()) data.optJSONArray("recent_finished") ?: JSONArray() else JSONArray()
            val lines = (0 until minOf(4, recent.length())).map { "✓  ${recent.getJSONObject(it).optString("title")}" }
            views.setViewVisibility(R.id.widget_detail, View.VISIBLE)
            views.setTextViewText(R.id.widget_detail, if (lines.isEmpty()) "Every finished book this year counts." else "RECENTLY FINISHED\n\n" + lines.joinToString("\n\n"))
          }
        }
      }
      val intent = Intent(context, MainActivity::class.java).apply { action = Intent.ACTION_VIEW; setData(Uri.parse("crosspointsync://widget/$destination")) }
      val open = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      views.setOnClickPendingIntent(R.id.widget_root, open)
      return views
    }
    private fun history(context: Context, views: RemoteViews, data: JSONObject, count: Int) {
      val dates = data.optJSONArray("history_days") ?: JSONArray()
      val known = (0 until dates.length()).map { dates.optString(it) }.toSet()
      views.setViewVisibility(R.id.widget_history, View.VISIBLE)
      views.removeAllViews(R.id.widget_history)
      for (week in 0 until count / 7) {
        val row = RemoteViews(context.packageName, R.layout.widget_history_row)
        for (weekday in 0..6) {
          val cursor = Calendar.getInstance().apply { add(Calendar.DATE, week * 7 + weekday - count + 1) }
          val read = known.contains(day(cursor))
          val cell = RemoteViews(context.packageName, R.layout.widget_day)
          cell.setTextViewText(R.id.widget_day, cursor.get(Calendar.DAY_OF_MONTH).toString())
          cell.setTextColor(R.id.widget_day, context.getColor(if (read) R.color.widget_day_text else R.color.widget_ink))
          cell.setInt(R.id.widget_day, "setBackgroundResource", if (read) R.drawable.widget_day_read else R.drawable.widget_day_empty)
          cell.setContentDescription(R.id.widget_day, "${day(cursor)}: ${if (read) "Read" else "No recorded reading"}")
          row.addView(R.id.widget_history_row, cell)
        }
        views.addView(R.id.widget_history, row)
      }
    }
  }
}
class StreakWidget : ReadingWidget() { override val focus = "streak" }
class GoalWidget : ReadingWidget() { override val focus = "goal" }
