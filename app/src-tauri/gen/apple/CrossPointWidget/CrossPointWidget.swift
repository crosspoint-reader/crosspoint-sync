import SwiftUI
import WidgetKit

// Home screen widget: the current book and reading totals. The app writes
// widget.json + cover.png into the shared App Group container (Rust
// `update_widget`), including the session, and the widget refreshes them from
// the sync server on each timeline reload.

private let appGroup = "group.com.crosspointreader.sync"
// Light and dark (the app's dark theme), following the system appearance.
private func hex(_ v: UInt32) -> UIColor {
  UIColor(red: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}
private func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
  Color(UIColor { $0.userInterfaceStyle == .dark ? hex(dark) : hex(light) })
}
private let paper = adaptive(0xFAFAF9, 0x121110)
private let ink = adaptive(0x1C1917, 0xF3F0ED)
private let soft = adaptive(0x78716C, 0xA09993)
private let brand = adaptive(0x4A7A62, 0x8FB9A6)

struct Session: Codable {
  let server: String
  let username: String
  let key: String
}

struct ReadingData: Codable {
  var label: String
  var title: String
  var author: String
  var percent: Int
  var stats: String
  // The book whose cover is saved, so a refresh only downloads a new one.
  var cover_url: String?
  // Set by the app while signed in; the widget fetches with it on its own.
  var session: Session?
}

struct ReadingEntry: TimelineEntry {
  let date: Date
  let data: ReadingData?
  let cover: UIImage?
}

private struct Book: Decodable {
  let title: String?
  let filename: String?
  let author: String?
  let percentage: Double
  let status: String?
  let cover_url: String?
}
private struct Books: Decodable { let items: [Book] }
private struct Overview: Decodable {
  let current_streak: Int
  let seconds: Double
  let pages_read: Int
  let finished_this_year: Int
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> ReadingEntry {
    ReadingEntry(
      date: Date(),
      data: ReadingData(label: "CONTINUE READING", title: "Foundryside", author: "Robert Jackson Bennett", percent: 62, stats: "1,923 pages · 4 finished this year"),
      cover: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (ReadingEntry) -> Void) {
    completion(load() ?? placeholder(in: context))
  }

  // Fetches from the sync server itself, so the widget moves without the app being opened.
  // iOS decides when the timeline actually reloads (roughly every 15-60 minutes).
  func getTimeline(in context: Context, completion: @escaping (Timeline<ReadingEntry>) -> Void) {
    Task {
      await refresh()
      let entry = load() ?? ReadingEntry(date: Date(), data: nil, cover: nil)
      completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
  }

  private var dir: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) }

  private func load() -> ReadingEntry? {
    guard let dir, let json = try? Data(contentsOf: dir.appendingPathComponent("widget.json")),
      let data = try? JSONDecoder().decode(ReadingData.self, from: json)
    else { return nil }
    let cover = UIImage(contentsOfFile: dir.appendingPathComponent("cover.png").path)
    return ReadingEntry(date: Date(), data: data, cover: cover)
  }

  private func get<T: Decodable>(_ s: Session, _ path: String) async -> T? {
    guard let url = URL(string: s.server + path) else { return nil }
    var req = URLRequest(url: url, timeoutInterval: 15)
    req.setValue(s.username, forHTTPHeaderField: "x-auth-user")
    req.setValue(s.key, forHTTPHeaderField: "x-auth-key")
    req.setValue("application/json", forHTTPHeaderField: "accept")
    guard let (body, res) = try? await URLSession.shared.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return try? JSONDecoder().decode(T.self, from: body)
  }

  // The same text the app writes (app/src/widget.js). A failed fetch keeps the last snapshot.
  private func refresh() async {
    guard let dir, var data = load()?.data, let s = data.session else { return }
    let tz = -TimeZone.current.secondsFromGMT() / 60
    async let booksReq: Books? = get(s, "/api/v1/progress?limit=500")
    async let overviewReq: Overview? = get(s, "/api/v1/stats/overview?tz=\(tz)")
    guard let books = await booksReq else { return }
    if let o = await overviewReq {
      data.stats = o.seconds > 0
        ? "\(o.current_streak)-day streak · \(Int((o.seconds / 3600).rounded()))h read"
        : "\(NumberFormatter.localizedString(from: NSNumber(value: o.pages_read), number: .decimal)) pages · \(o.finished_this_year) finished this year"
    }
    let current = books.items.first { $0.status == "reading" && ($0.title ?? $0.filename) != nil }
    if let b = current {
      data.label = "CONTINUE READING"
      data.title = b.title ?? b.filename ?? ""
      data.author = b.author ?? ""
      data.percent = Int((b.percentage * 100).rounded())
    } else {
      data.label = "CROSSPOINT SYNC"
      data.title = "Nothing in progress"
      data.author = ""
      data.percent = -1
    }
    let coverFile = dir.appendingPathComponent("cover.png")
    if current?.cover_url != data.cover_url {
      try? FileManager.default.removeItem(at: coverFile)
      if let link = current?.cover_url, let url = URL(string: link),
        let (bytes, _) = try? await URLSession.shared.data(from: url), let image = UIImage(data: bytes) {
        try? coverPNG(image).write(to: coverFile)
      }
      data.cover_url = current?.cover_url
    }
    if let json = try? JSONEncoder().encode(data) { try? json.write(to: dir.appendingPathComponent("widget.json")) }
  }

  // Widget-sized (168x252, cropped to fill like the app does): widget images must stay small.
  private func coverPNG(_ image: UIImage) -> Data {
    let size = CGSize(width: 168, height: 252)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).pngData { _ in
      let s = max(size.width / image.size.width, size.height / image.size.height)
      let w = image.size.width * s, h = image.size.height * s
      image.draw(in: CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h))
    }
  }
}

struct CoverView: View {
  let image: UIImage?
  var body: some View {
    if let image {
      Image(uiImage: image).resizable().fullColorInTint().aspectRatio(2 / 3, contentMode: .fill)
        .frame(width: 56, height: 84).clipShape(RoundedRectangle(cornerRadius: 6))
        .shadow(color: .black.opacity(0.15), radius: 3, y: 2)
    }
  }
}

struct ReadingWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: ReadingEntry

  var body: some View {
    Group {
      if let data = entry.data {
        if family == .systemSmall {
          VStack(alignment: .leading, spacing: 4) {
            Text(data.label).font(.system(size: 9, design: .monospaced)).foregroundColor(soft)
            Text(data.title).font(.system(.headline, design: .serif)).foregroundColor(ink).lineLimit(3)
            Spacer(minLength: 0)
            if data.percent >= 0 {
              Text("\(data.percent)%").font(.system(size: 22, weight: .semibold, design: .serif)).foregroundColor(brand)
              ProgressView(value: Double(data.percent), total: 100).tint(brand)
            }
          }
        } else {
          HStack(spacing: 14) {
            CoverView(image: entry.cover)
            VStack(alignment: .leading, spacing: 3) {
              Text(data.label).font(.system(size: 10, design: .monospaced)).foregroundColor(soft)
              Text(data.title).font(.system(.headline, design: .serif)).foregroundColor(ink).lineLimit(2)
              if !data.author.isEmpty {
                Text(data.author).font(.caption).foregroundColor(soft).lineLimit(1)
              }
              if data.percent >= 0 {
                HStack(spacing: 8) {
                  ProgressView(value: Double(data.percent), total: 100).tint(brand)
                  Text("\(data.percent)%").font(.caption.bold()).foregroundColor(brand)
                }.padding(.top, 4)
              }
              Text(data.stats).font(.caption2).foregroundColor(soft).lineLimit(1).padding(.top, 2)
            }
            Spacer(minLength: 0)
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 4) {
          Text("CROSSPOINT SYNC").font(.system(size: 10, design: .monospaced)).foregroundColor(soft)
          Text("Open the app to sign in").font(.system(.headline, design: .serif)).foregroundColor(ink)
        }
      }
    }
    .widgetBackground(paper)
  }
}

extension Image {
  // Clear/tinted home screens otherwise flatten the cover into a white silhouette.
  @ViewBuilder func fullColorInTint() -> some View {
    if #available(iOSApplicationExtension 18.0, *) {
      widgetAccentedRenderingMode(.fullColor)
    } else {
      self
    }
  }
}

extension View {
  // iOS 17 requires containerBackground; earlier versions just pad and fill.
  @ViewBuilder func widgetBackground(_ color: Color) -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(color, for: .widget)
    } else {
      padding().background(color)
    }
  }
}

@main
struct CrossPointWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CrossPointReading", provider: Provider()) { entry in
      ReadingWidgetView(entry: entry)
    }
    .configurationDisplayName("Currently reading")
    .description("Your current book and reading totals.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
