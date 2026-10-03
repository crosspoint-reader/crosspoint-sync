import SwiftUI
import WidgetKit

// Home screen widget: the current book and reading totals. The app writes
// widget.json + cover.png into the shared App Group container (Rust
// `update_widget`); the widget re-reads them on each timeline refresh.

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

struct ReadingData: Codable {
  let label: String
  let title: String
  let author: String
  let percent: Int
  let stats: String
}

struct ReadingEntry: TimelineEntry {
  let date: Date
  let data: ReadingData?
  let cover: UIImage?
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

  func getTimeline(in context: Context, completion: @escaping (Timeline<ReadingEntry>) -> Void) {
    let entry = load() ?? ReadingEntry(date: Date(), data: nil, cover: nil)
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
  }

  private func load() -> ReadingEntry? {
    guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
      let json = try? Data(contentsOf: dir.appendingPathComponent("widget.json")),
      let data = try? JSONDecoder().decode(ReadingData.self, from: json)
    else { return nil }
    let cover = UIImage(contentsOfFile: dir.appendingPathComponent("cover.png").path)
    return ReadingEntry(date: Date(), data: data, cover: cover)
  }
}

struct CoverView: View {
  let image: UIImage?
  var body: some View {
    if let image {
      Image(uiImage: image).resizable().aspectRatio(2 / 3, contentMode: .fill)
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
