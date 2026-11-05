import Foundation

func check(_ value: @autoclosure () -> Bool, _ message: String) {
  if !value() { fatalError(message) }
}
var calendar = Calendar(identifier: .gregorian)
calendar.timeZone = TimeZone(identifier: "America/New_York")!
let now = ISO8601DateFormatter().date(from: "2027-01-01T02:00:00Z")!
check(ReadingMetrics.day(now, calendar: calendar) == "2026-12-31", "local calendar day")
check(ReadingMetrics.streak(["2026-12-29", "2026-12-30"], now: now, calendar: calendar) == 2, "yesterday preserves streak")
check(ReadingMetrics.streak(["2026-12-29", "2026-12-30"], now: now.addingTimeInterval(86400), calendar: calendar) == 0, "midnight expires stale streak")
check(ReadingMetrics.streak(["2027-01-01"], now: now, calendar: calendar) == 0, "future dates excluded")
let goal = ReadingGoal(year: 2026, target: 12, completed: 15)
check(goal.remaining == 0 && goal.fraction == 1, "completed goals clamp visual fill only")
check(goal.active(at: now, calendar: calendar), "goal uses local year")
check(!goal.active(at: now.addingTimeInterval(86400), calendar: calendar), "goal does not carry into next year")
let legacy = Data(#"{"label":"CONTINUE READING","title":"Book","author":"","percent":40,"stats":""}"#.utf8)
let data = try JSONDecoder().decode(ReadingData.self, from: legacy)
check(data.goal == nil && data.history_days == nil, "legacy snapshots decode")
var longStreak = data
longStreak.history_known = true
longStreak.history_days = [ReadingMetrics.day(Date())]
longStreak.current_streak = 400
longStreak.snapshot_day = ReadingMetrics.day(Date())
check(longStreak.streak(at: Date()) == 400, "bounded history never truncates authoritative streak")
longStreak.goals = [ReadingGoal(year: 2027, target: 24, completed: 0)]
check(longStreak.activeGoal(at: ISO8601DateFormatter().date(from: "2027-01-02T12:00:00Z")!)?.target == 24, "explicit next-year goal activates offline")
let importedPage = Data(#"{"items":[{"document":"goodreads.101","title":"Imported book","percentage":null,"status":"reading"}],"next":"100:next"}"#.utf8)
let page = try JSONDecoder().decode(WidgetBooksPage.self, from: importedPage)
check(page.items.first?.document == "goodreads.101" && page.items.first?.percentage == nil && page.next == "100:next", "history-only books decode with nullable progress and paging")
print("Widget metrics: 11 checks passed")
