import SwiftUI
import WidgetKit
import Darwin

private let appGroup = "group.com.crosspointreader.sync"
private func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
  func color(_ v: UInt32) -> UIColor {
    UIColor(red: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
  }
  return Color(UIColor { $0.userInterfaceStyle == .dark ? color(dark) : color(light) })
}
private let paper = adaptive(0xFAFAF9, 0x121110)
private let ink = adaptive(0x1C1917, 0xF3F0ED)
private let soft = adaptive(0x78716C, 0xA09993)
private let brand = adaptive(0x4A7A62, 0x8FB9A6)

struct ReadingEntry: TimelineEntry {
  let date: Date
  let data: ReadingData?
  let cover: UIImage?
}
private struct Overview: Decodable {
  let current_streak: Int
  let longest_streak: Int
  let seconds: Double
  let pages_read: Int
  let finished_this_year: Int
  let anchor_day: Int
  let history_b64: String
}
private struct Goals: Decodable {
  let year: Int
  let goals: [ReadingGoal]
  let recent_finished: [FinishedBook]?
}
private enum RefreshError: Error { case unauthorized }

struct Provider: TimelineProvider {
  private var dir: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) }
  func placeholder(in context: Context) -> ReadingEntry {
    var data = ReadingData(label: "CONTINUE READING", title: "Eternity’s Tomb", author: "Dan Moren", percent: 62, stats: "1,923 pages · 4 finished this year")
    data.history_known = true
    data.session = Session(server: "https://example.invalid", username: "preview", key: "")
    data.history_days = (0..<35).filter { $0 % 8 != 5 }.map { ReadingMetrics.day(Calendar.current.date(byAdding: .day, value: -$0, to: Date())!) }
    data.longest_streak = 18
    data.goal = ReadingGoal(year: Calendar.current.component(.year, from: Date()), target: 24, completed: 16)
    let cover = Bundle.main.url(forResource: "PreviewCover", withExtension: "jpg").flatMap { UIImage(contentsOfFile: $0.path) }
    return ReadingEntry(date: Date(), data: data, cover: cover)
  }
  func getSnapshot(in context: Context, completion: @escaping (ReadingEntry) -> Void) {
    completion(context.isPreview ? placeholder(in: context) : load())
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<ReadingEntry>) -> Void) {
    Task {
      await refresh()
      let now = Date()
      // Date-derived views roll over even if the next network refresh fails.
      let midnight = Calendar.current.startOfDay(for: Calendar.current.date(byAdding: .day, value: 1, to: now)!)
      let saved = load()
      let entries = [ReadingEntry(date: now, data: saved.data, cover: saved.cover), ReadingEntry(date: midnight, data: saved.data, cover: saved.cover)]
      completion(Timeline(entries: entries, policy: .after(min(now.addingTimeInterval(1800), midnight))))
    }
  }

  // App and extension use the same advisory lock; network work never holds it.
  private func locked<T>(_ body: (URL) -> T) -> T? {
    guard let dir else { return nil }
    let file = dir.appendingPathComponent("widget.lock").path
    let fd = Darwin.open(file, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { return nil }
    defer { Darwin.close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { return nil }
    defer { flock(fd, LOCK_UN) }
    return body(dir)
  }
  private func load() -> ReadingEntry {
    locked { dir in
      let data = (try? Data(contentsOf: dir.appendingPathComponent("widget.json"))).flatMap { try? JSONDecoder().decode(ReadingData.self, from: $0) }
      let cover = data?.session == nil ? nil : UIImage(contentsOfFile: dir.appendingPathComponent("cover.png").path)
      return ReadingEntry(date: Date(), data: data, cover: cover)
    } ?? ReadingEntry(date: Date(), data: nil, cover: nil)
  }
  private func get<T: Decodable>(_ session: Session, _ path: String) async throws -> T? {
    guard let url = URL(string: session.server + path) else { return nil }
    var req = URLRequest(url: url, timeoutInterval: 12)
    req.setValue(session.username, forHTTPHeaderField: "x-auth-user")
    req.setValue(session.key, forHTTPHeaderField: "x-auth-key")
    req.setValue("application/json", forHTTPHeaderField: "accept")
    guard let (body, response) = try? await URLSession.shared.data(for: req), let status = (response as? HTTPURLResponse)?.statusCode else { return nil }
    if status == 401 { throw RefreshError.unauthorized }
    guard status == 200 else { return nil }
    return try? JSONDecoder().decode(T.self, from: body)
  }
  private func refresh() async {
    guard let original = locked({ try? Data(contentsOf: $0.appendingPathComponent("widget.json")) }) ?? nil,
      var data = try? JSONDecoder().decode(ReadingData.self, from: original), let session = data.session else { return }
    let tz = -TimeZone.current.secondsFromGMT() / 60
    let hasCover = locked { FileManager.default.fileExists(atPath: $0.appendingPathComponent("cover.png").path) } ?? false
    var newCover: Data?
    var coverChanged = false
    do {
      async let overviewReq: Overview? = get(session, "/api/v1/stats/overview?tz=\(tz)")
      async let booksReq: WidgetBooksPage? = allBooks(session)
      async let goalsReq: Goals? = get(session, "/api/v1/account/reading-goals?tz=\(tz)")
      let (overview, books, goals) = try await (overviewReq, booksReq, goalsReq)
      guard overview != nil || books != nil || goals != nil else { return }
      if let o = overview {
        data.stats = o.seconds >= 60
          ? "\(o.current_streak)-day streak · \(Int((o.seconds / 3600).rounded()))h read"
          : "\(o.pages_read.formatted()) pages · \(o.finished_this_year) finished this year"
        data.history_known = true
        data.history_days = ReadingMetrics.dates(history: o.history_b64, anchor: o.anchor_day)
        data.current_streak = o.current_streak
        data.longest_streak = o.longest_streak
        data.pages_read = o.pages_read
        data.finished_this_year = o.finished_this_year
        data.snapshot_day = ReadingMetrics.day(Date())
      }
      if let g = goals {
        data.goal = g.goals.first { $0.active(at: Date()) }
        data.goals = g.goals
        data.goal_supported = true
        data.recent_finished = g.recent_finished
        data.recent_finished_year = g.year
      }
      if let books {
        let current = books.items.first { $0.status == "reading" && ($0.title ?? $0.filename) != nil }
        data.label = current == nil ? "CROSSPOINT SYNC" : "CONTINUE READING"
        data.title = current?.title ?? current?.filename ?? "Nothing in progress"
        data.author = current?.author ?? ""
        data.percent = current.map { min(100, max(0, Int((($0.percentage ?? 0) * 100).rounded()))) } ?? -1
        coverChanged = current?.document != data.book_document || current?.cover_url != data.cover_url || !hasCover
        data.book_document = current?.document
        if coverChanged, let link = current?.cover_url, let url = URL(string: link),
          let (bytes, response) = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 10)),
          (response as? HTTPURLResponse)?.statusCode == 200, let image = UIImage(data: bytes) {
          newCover = coverPNG(image)
        }
        // A failed cover remains retryable on the next refresh.
        data.cover_url = current?.cover_url
      }
      if overview != nil && books != nil && goals != nil { data.updated_at = ISO8601DateFormatter().string(from: Date()) }
    } catch {
      data = ReadingData(label: "CROSSPOINT SYNC", title: "Sign in to see your reading", author: "", percent: -1, stats: "")
      coverChanged = true
    }
    locked { dir in
      let file = dir.appendingPathComponent("widget.json")
      // App changes, goal edits and logout all supersede this refresh.
      guard (try? Data(contentsOf: file)) == original else { return }
      if coverChanged {
        let cover = dir.appendingPathComponent("cover.png")
        if let newCover { try? newCover.write(to: cover, options: .atomic) }
        else { try? FileManager.default.removeItem(at: cover) }
      }
      if let bytes = try? JSONEncoder().encode(data) { try? bytes.write(to: file, options: .atomic) }
    }
  }
  private func allBooks(_ session: Session) async throws -> WidgetBooksPage? {
    var items: [WidgetBook] = []
    var seen = Set<String>()
    var path = "/api/v1/progress?limit=500&include_history=1"
    while true {
      guard let page: WidgetBooksPage = try await get(session, path) else { return nil }
      items.append(contentsOf: page.items)
      guard let next = page.next else { return WidgetBooksPage(items: items, next: nil) }
      guard seen.insert(next).inserted else { return nil }
      var query = URLComponents()
      query.queryItems = [URLQueryItem(name: "limit", value: "500"), URLQueryItem(name: "include_history", value: "1"), URLQueryItem(name: "cursor", value: next)]
      path = "/api/v1/progress?" + (query.percentEncodedQuery ?? "")
    }
  }
  private func coverPNG(_ image: UIImage) -> Data {
    let size = CGSize(width: 168, height: 252)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).pngData { _ in
      let scale = max(size.width / image.size.width, size.height / image.size.height)
      let w = image.size.width * scale, h = image.size.height * scale
      image.draw(in: CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h))
    }
  }
}

private struct Eyebrow: View {
  let text: String
  var body: some View { Text(text).font(.system(size: 10, design: .monospaced)).tracking(1).foregroundStyle(soft).lineLimit(1).minimumScaleFactor(0.75) }
}
private struct CoverView: View {
  let image: UIImage?
  var width: CGFloat = 64
  var body: some View {
    Group {
      if let image { Image(uiImage: image).resizable().fullColorInTint().aspectRatio(contentMode: .fill) }
      else { ZStack { brand.opacity(0.12); Image(systemName: "book.closed").font(.title).foregroundStyle(brand) } }
    }.frame(width: width, height: width * 1.5).clipShape(RoundedRectangle(cornerRadius: 7)).shadow(color: .black.opacity(0.12), radius: 4, y: 2)
  }
}
private struct Metric: View {
  let value: String
  let label: String
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(value).font(.system(.title2, design: .serif).weight(.semibold)).foregroundStyle(ink).minimumScaleFactor(0.7).lineLimit(1)
      Text(label).font(.system(size: 11)).foregroundStyle(soft)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
private struct ReadingProgress: View {
  let fraction: Double
  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        Capsule().fill(brand.opacity(0.15))
        Capsule().fill(brand).frame(width: geometry.size.width * min(1, max(0, fraction)))
      }
    }.frame(height: 4).accessibilityValue("\(Int(min(1, max(0, fraction)) * 100)) percent")
  }
}
private struct HistoryGrid: View {
  let data: ReadingData
  let now: Date
  var count = 35
  var body: some View {
    let known = Set(data.history_days ?? [])
    VStack(alignment: .leading, spacing: 7) {
      Eyebrow(text: "LAST \(count) DAYS")
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 5), count: 7), spacing: 5) {
        ForEach(0..<count, id: \.self) { index in
          let date = Calendar.current.date(byAdding: .day, value: index - count + 1, to: now)!
          let day = ReadingMetrics.day(date)
          let read = known.contains(day)
          RoundedRectangle(cornerRadius: 3).fill(read ? brand : soft.opacity(0.12)).frame(minHeight: 10, maxHeight: 23)
            .overlay(Text("\(Calendar.current.component(.day, from: date))").font(.system(size: 9)).foregroundStyle(read ? paper : soft))
            .accessibilityLabel("\(day): \(read ? "Read" : "No recorded reading")")
        }
      }
    }
  }
}
private struct WeekStrip: View {
  let data: ReadingData
  let now: Date
  var body: some View {
    let known = Set(data.history_days ?? [])
    HStack(spacing: 5) {
      ForEach(0..<7, id: \.self) { n in
        let date = Calendar.current.date(byAdding: .day, value: n - 6, to: now)!
        let day = ReadingMetrics.day(date)
        VStack(spacing: 5) {
          Text(date.formatted(.dateTime.weekday(.narrow))).font(.system(size: 9)).foregroundStyle(soft)
          Circle().fill(known.contains(day) ? brand : soft.opacity(0.15)).frame(maxWidth: 16, maxHeight: 16)
        }.frame(maxWidth: .infinity).accessibilityElement(children: .ignore).accessibilityLabel("\(day): \(known.contains(day) ? "Read" : "No recorded reading")")
      }
    }
  }
}
private struct Freshness: View {
  let data: ReadingData
  var body: some View {
    if let raw = data.updated_at, let date = ISO8601DateFormatter().date(from: raw) {
      Text("Last complete sync \(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))").font(.system(size: 9)).foregroundStyle(soft).lineLimit(1)
    } else { Text("Saved reading snapshot").font(.system(size: 9)).foregroundStyle(soft) }
  }
}
private enum WidgetFocus { case reading, streak, goal }

struct ReadingWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: ReadingEntry
  fileprivate var focus: WidgetFocus = .reading
  private var small: Bool { family == .systemSmall }
  private var expanded: Bool { family == .systemLarge || family == .systemExtraLarge }
  private var destination: URL? {
    guard let data = entry.data, data.session != nil else { return URL(string: "crosspointsync://widget/library") }
    if focus == .reading { return URL(string: "crosspointsync://widget/" + (data.book_document.map { "book/\($0)" } ?? "library")) }
    if focus == .goal && data.activeGoal(at: entry.date) == nil { return URL(string: "crosspointsync://widget/settings/goals") }
    return URL(string: "crosspointsync://widget/stats")
  }
  var body: some View {
    Group {
      if let data = entry.data, data.session != nil {
        switch focus {
        case .reading: reading(data)
        case .streak: streak(data)
        case .goal: goal(data)
        }
      } else {
        VStack(alignment: .leading, spacing: 10) {
          Eyebrow(text: "CROSSPOINT SYNC")
          Image(systemName: "books.vertical").font(.largeTitle).foregroundStyle(brand)
          Text("Open the app to sign in").font(.system(.headline, design: .serif)).foregroundStyle(ink)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      }
    }.widgetURL(destination).widgetBackground(paper)
  }
  private func book(_ data: ReadingData, wide: Bool) -> some View {
    VStack(alignment: .leading, spacing: wide ? 7 : 4) {
      Eyebrow(text: data.label)
      Text(data.title).font(wide ? .system(.title2, design: .serif).weight(.semibold) : .system(size: small ? 18 : 16, weight: .semibold, design: .serif)).foregroundStyle(ink).lineLimit(wide ? 4 : small ? 3 : 2).minimumScaleFactor(0.8)
      if !small && !data.author.isEmpty { Text(data.author).font(.system(size: 12)).foregroundStyle(soft).lineLimit(wide ? 2 : 1) }
      Spacer(minLength: 3)
      if data.percent >= 0 {
        if family == .systemMedium {
          HStack(spacing: 10) {
            ReadingProgress(fraction: Double(data.percent) / 100).accessibilityLabel("Book progress")
            Text("\(data.percent)%").font(.system(size: 12, weight: .semibold)).foregroundStyle(brand)
          }
        } else {
          Text("\(data.percent)%").font(.system(size: wide ? 34 : 28, weight: .semibold, design: .serif)).foregroundStyle(brand)
          ReadingProgress(fraction: Double(data.percent) / 100).accessibilityLabel("Book progress")
        }
      }
    }
  }
  @ViewBuilder private func reading(_ data: ReadingData) -> some View {
    if small { book(data, wide: false) }
    else if family == .systemExtraLarge {
      HStack(alignment: .top, spacing: 28) {
        HStack(alignment: .top, spacing: 18) { CoverView(image: entry.cover, width: 110); book(data, wide: true) }.frame(maxWidth: .infinity)
        VStack(alignment: .leading, spacing: 18) {
          readingTotals(data)
          if data.history_known == true { HistoryGrid(data: data, now: entry.date, count: 56) }
          Spacer(minLength: 0)
          Freshness(data: data)
        }.frame(maxWidth: .infinity)
      }
    } else {
      VStack(alignment: .leading, spacing: 16) {
        HStack(alignment: .top, spacing: expanded ? 20 : 14) { CoverView(image: entry.cover, width: expanded ? 90 : 56); book(data, wide: expanded) }
        if expanded {
          readingTotals(data)
          if data.history_known == true { HistoryGrid(data: data, now: entry.date, count: 21) }
          Spacer(minLength: 0)
          Freshness(data: data)
        } else { Text(data.stats).font(.caption2).foregroundStyle(soft).lineLimit(1).minimumScaleFactor(0.8) }
      }
    }
  }
  private func readingTotals(_ data: ReadingData) -> some View {
    HStack(spacing: 14) {
      if let streak = data.streak(at: entry.date) { Metric(value: "\(streak)", label: "day streak") }
      if let pages = data.pages_read { Metric(value: pages.formatted(), label: "pages read") }
      if let finished = data.finished_this_year { Metric(value: "\(finished)", label: "finished this year") }
    }
  }
  @ViewBuilder private func streak(_ data: ReadingData) -> some View {
    if let current = data.streak(at: entry.date) {
      if family == .systemExtraLarge {
        HStack(alignment: .top, spacing: 32) {
          VStack(alignment: .leading, spacing: 18) {
            Eyebrow(text: "READING STREAK")
            Text("\(current)").font(.system(size: 72, weight: .semibold, design: .serif)).foregroundStyle(brand)
            Text(current == 1 ? "consecutive reading day" : "consecutive reading days").font(.system(.title3, design: .serif)).foregroundStyle(ink)
            Metric(value: "\(data.longest_streak ?? current)", label: "longest streak")
            Spacer(minLength: 0)
            readingTotals(data)
            Freshness(data: data)
          }.frame(maxWidth: .infinity, alignment: .leading)
          HistoryGrid(data: data, now: entry.date, count: 70).frame(maxWidth: .infinity)
        }
      } else {
      VStack(alignment: .leading, spacing: small ? 8 : 14) {
        Eyebrow(text: "READING STREAK")
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text("\(current)").font(.system(size: small ? 46 : 58, weight: .semibold, design: .serif)).foregroundStyle(brand).minimumScaleFactor(0.6)
          Text(current == 1 ? "day" : "days").font(.system(.title3, design: .serif)).foregroundStyle(soft)
          if !small { Spacer(); Metric(value: "\(data.longest_streak ?? current)", label: "longest streak").frame(maxWidth: 110) }
        }
        if expanded { HistoryGrid(data: data, now: entry.date, count: family == .systemExtraLarge ? 70 : 42) }
        else { Spacer(minLength: 0); WeekStrip(data: data, now: entry.date) }
        if expanded { Spacer(minLength: 0); readingTotals(data); Freshness(data: data) }
      }
      }
    } else { empty("Your reading days", detail: "Open the app to sync your reading history.", symbol: "calendar") }
  }
  @ViewBuilder private func goal(_ data: ReadingData) -> some View {
    if let goal = data.activeGoal(at: entry.date) {
      if family == .systemExtraLarge {
        HStack(alignment: .top, spacing: 32) {
          VStack(alignment: .leading, spacing: 22) {
            Eyebrow(text: "\(String(goal.year)) READING GOAL")
            Text("\(goal.completed) of \(goal.target)").font(.system(.largeTitle, design: .serif).weight(.semibold)).foregroundStyle(ink)
            Text("books finished").font(.title3).foregroundStyle(soft)
            ReadingProgress(fraction: goal.fraction)
            Text(goal.remaining == 0 ? "Goal reached" : "\(goal.remaining) books to go").font(.system(.title2, design: .serif)).foregroundStyle(brand)
            Spacer(minLength: 0)
            Freshness(data: data)
          }.frame(maxWidth: .infinity, alignment: .leading)
          recentFinished(data, goal: goal).frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
      VStack(alignment: .leading, spacing: expanded ? 18 : small ? 6 : 9) {
        Eyebrow(text: "\(String(goal.year)) READING GOAL")
        if small {
          Text("\(goal.completed)").font(.system(size: 46, weight: .semibold, design: .serif)).foregroundStyle(brand).minimumScaleFactor(0.6)
          Text("of \(goal.target) books").font(.system(size: 16, weight: .semibold, design: .serif)).foregroundStyle(ink)
          Spacer(minLength: 0)
          ReadingProgress(fraction: goal.fraction)
        } else {
          HStack(spacing: 20) {
            ZStack {
              Circle().stroke(brand.opacity(0.12), lineWidth: 8)
              Circle().trim(from: 0, to: goal.fraction).stroke(brand, style: StrokeStyle(lineWidth: 8, lineCap: .round)).rotationEffect(.degrees(-90))
              Image(systemName: goal.remaining == 0 ? "checkmark" : "book.closed").font(expanded ? .largeTitle : .title2).foregroundStyle(brand)
            }.frame(width: expanded ? 100 : 62, height: expanded ? 100 : 62).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
              Text("\(goal.completed) of \(goal.target)").font(.system(expanded ? .largeTitle : .title, design: .serif).weight(.semibold)).foregroundStyle(ink).lineLimit(1).minimumScaleFactor(0.6)
              Text("books finished").font(.caption).foregroundStyle(soft)
            }
          }
        }
        Text(goal.remaining == 0 ? "Goal reached" : "\(goal.remaining) \(goal.remaining == 1 ? "book" : "books") to go").font(.system(size: 12)).foregroundStyle(soft)
        if expanded {
          recentFinished(data, goal: goal)
          Spacer(minLength: 0)
          Freshness(data: data)
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).accessibilityElement(children: .combine)
      }
    } else { empty("Read at your own pace", detail: "If you’d like a yearly goal, choose one in Settings.", symbol: "book.circle") }
  }
  private func recentFinished(_ data: ReadingData, goal: ReadingGoal) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      if let finished = data.recent_finished, !finished.isEmpty, data.recent_finished_year == goal.year {
        Eyebrow(text: "RECENTLY FINISHED")
        ForEach(finished.prefix(family == .systemExtraLarge ? 4 : 3)) { book in
          HStack(spacing: 10) {
            Image(systemName: "checkmark.circle").foregroundStyle(brand)
            Text(book.title).font(.system(.subheadline, design: .serif)).foregroundStyle(ink).lineLimit(2)
            Spacer(minLength: 0)
          }
        }
      } else { Text("Every finished book this year counts.").font(.subheadline).foregroundStyle(soft) }
    }
  }
  private func empty(_ title: String, detail: String, symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Eyebrow(text: focus == .goal ? "YEARLY GOAL · OPTIONAL" : "READING STREAK")
      Image(systemName: symbol).font(.title).foregroundStyle(brand)
      Text(title).font(.system(.headline, design: .serif)).foregroundStyle(ink)
      Text(detail).font(.caption).foregroundStyle(soft)
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}

extension Image {
  @ViewBuilder func fullColorInTint() -> some View {
    if #available(iOSApplicationExtension 18.0, *) { widgetAccentedRenderingMode(.fullColor) } else { self }
  }
}
extension View {
  @ViewBuilder func widgetBackground(_ color: Color) -> some View {
    if #available(iOSApplicationExtension 17.0, *) { containerBackground(color, for: .widget) } else { padding().background(color) }
  }
}
struct CrossPointWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CrossPointReading", provider: Provider()) { ReadingWidgetView(entry: $0) }
      .configurationDisplayName("Continue Reading").description("Your current book, progress, and reading activity.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}
struct StreakWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CrossPointStreak", provider: Provider()) { ReadingWidgetView(entry: $0, focus: .streak) }
      .configurationDisplayName("Reading Streak").description("Your reading days and the habit you’re building.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}
struct GoalWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CrossPointGoal", provider: Provider()) { ReadingWidgetView(entry: $0, focus: .goal) }
      .configurationDisplayName("Yearly Goal").description("Progress towards the reading goal you chose.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}
@main struct CrossPointWidgets: WidgetBundle {
  var body: some Widget { CrossPointWidget(); StreakWidget(); GoalWidget() }
}
