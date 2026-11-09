import Foundation

// Read and compare under the provider's snapshot lock. Cover-only app writes
// supersede in-flight network work just like a change to the JSON snapshot.
struct WidgetSnapshot: Equatable {
  let json: Data
  let cover: Data?

  static func read(in dir: URL) -> WidgetSnapshot? {
    guard let json = try? Data(contentsOf: dir.appendingPathComponent("widget.json")) else { return nil }
    return WidgetSnapshot(json: json, cover: try? Data(contentsOf: dir.appendingPathComponent("cover.png")))
  }
}

struct WidgetBook: Decodable {
  let document: String
  let title: String?
  let filename: String?
  let author: String?
  let percentage: Double?
  let status: String?
  let cover_url: String?
}
struct WidgetBooksPage: Decodable {
  let items: [WidgetBook]
  let next: String?
}

struct Session: Codable, Equatable {
  let server: String
  let username: String
  let key: String
}

struct ReadingGoal: Codable {
  let year: Int
  let target: Int
  let completed: Int
  var remaining: Int { max(0, target - completed) }
  var fraction: Double { min(1, max(0, Double(completed) / Double(max(1, target)))) }
  func active(at date: Date, calendar: Calendar = .current) -> Bool {
    year == calendar.component(.year, from: date)
  }
}

struct FinishedBook: Codable, Identifiable {
  let document: String
  let title: String
  var id: String { document }
}

struct ReadingData: Codable {
  var label: String
  var title: String
  var author: String
  var percent: Int
  var stats: String
  var cover_url: String?
  var session: Session?
  var book_document: String?
  var history_days: [String]?
  var history_known: Bool?
  var current_streak: Int?
  var longest_streak: Int?
  var goal: ReadingGoal?
  var goals: [ReadingGoal]?
  var goal_supported: Bool?
  var snapshot_day: String?
  var updated_at: String?
  var pages_read: Int?
  var finished_this_year: Int?
  var recent_finished: [FinishedBook]?
  var recent_finished_year: Int?

  func activeGoal(at date: Date) -> ReadingGoal? {
    if let goals { return goals.first { $0.active(at: date) } }
    return goal?.active(at: date) == true ? goal : nil
  }

  func streak(at date: Date) -> Int? {
    guard history_known == true else { return nil }
    let today = ReadingMetrics.day(date)
    let yesterday = ReadingMetrics.day(Calendar.current.date(byAdding: .day, value: -1, to: date)!)
    if let current_streak, snapshot_day == today || (snapshot_day == yesterday && history_days?.contains(yesterday) == true) { return current_streak }
    // A fallback counter without dates is valid only on the day it was fetched.
    if let days = history_days, !days.isEmpty { return ReadingMetrics.streak(days, now: date) }
    return snapshot_day == ReadingMetrics.day(date) ? current_streak ?? 0 : 0
  }
}

enum ReadingMetrics {
  static func day(_ date: Date, calendar: Calendar = .current) -> String {
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
  }

  static func streak(_ days: [String], now: Date, calendar: Calendar = .current) -> Int {
    let known = Set(days)
    var cursor = calendar.startOfDay(for: now)
    if !known.contains(day(cursor, calendar: calendar)) { cursor = calendar.date(byAdding: .day, value: -1, to: cursor)! }
    var count = 0
    while known.contains(day(cursor, calendar: calendar)) {
      count += 1
      cursor = calendar.date(byAdding: .day, value: -1, to: cursor)!
    }
    return count
  }

  static func dates(history: String, anchor: Int) -> [String] {
    guard let bytes = Data(base64Encoded: history) else { return [] }
    let epoch = Date(timeIntervalSince1970: 946684800)
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(secondsFromGMT: 0)!
    return (0..<(bytes.count * 8)).compactMap { n in
      guard bytes[n >> 3] & (1 << (n & 7)) != 0 else { return nil }
      return day(epoch.addingTimeInterval(Double(anchor - n) * 86400), calendar: utc)
    }
  }
}
