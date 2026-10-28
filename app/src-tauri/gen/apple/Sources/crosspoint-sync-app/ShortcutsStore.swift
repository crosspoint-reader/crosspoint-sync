import Foundation

// Schema written by api.js from the existing offline cache. Dates from the
// server are seconds; savedAt/cachedAt are JavaScript milliseconds.
struct CachedBook: Decodable {
  let document: String
  let title: String
  let author: String?
  let status: String
  let percentage: Double
  let timestamp: Double?
}

struct CachedClipping: Decodable {
  let document: String
  let id: String
  let text: String
  let note: String?
  let chapter: String?
  let created_at: Double
  let cachedAt: Double?
}

struct SavedBooks: Decodable {
  let savedAt: Double?
  let items: [CachedBook]
  var cachedAt: Date? { savedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct SavedClippings: Decodable {
  let items: [CachedClipping]
}

enum ShortcutsDataError: LocalizedError {
  case unavailable, booksMissing, clippingsMissing, bookMissing
  var errorDescription: String? {
    switch self {
    case .unavailable: return "Open CrossPoint Sync and sign in to make your offline data available to Shortcuts."
    case .booksMissing: return "Open the Library in CrossPoint Sync to save books for offline Shortcuts."
    case .clippingsMissing: return "Open Clippings in CrossPoint Sync to save clippings for offline Shortcuts."
    case .bookMissing: return "This book is no longer in the saved library. Select it again in Shortcuts."
    }
  }
}

struct ShortcutsSnapshot: Decodable {
  var account: String
  let books: SavedBooks?
  let clippings: SavedClippings?

  static func decode(_ data: Data) throws -> Self {
    try JSONDecoder().decode(Self.self, from: data)
  }

  // Matches Tauri's app_data_dir(): Application Support/<bundle identifier>.
  // Intents live in the main app target, so no shared App Group is needed.
  static func cacheDirectory(in support: URL, bundleIdentifier: String) -> URL {
    support.appendingPathComponent(bundleIdentifier, isDirectory: true)
      .appendingPathComponent("Shortcuts", isDirectory: true)
  }

  static func load(from directory: URL? = nil) throws -> Self {
    let dir: URL
    if let directory {
      dir = directory
    } else {
      guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
        let identifier = Bundle.main.bundleIdentifier
      else { throw ShortcutsDataError.unavailable }
      dir = cacheDirectory(in: support, bundleIdentifier: identifier)
    }
    do {
      return try decode(Data(contentsOf: dir.appendingPathComponent("shortcuts.json")))
    } catch { throw ShortcutsDataError.unavailable }
  }

  func bookID(_ document: String) -> String { "\(account):book:\(document)" }
  func clippingID(document: String, id: String) -> String { "\(account):clipping:\(document):\(id)" }

  func findBooks(status: String?, text: String?) throws -> [CachedBook] {
    guard let books else { throw ShortcutsDataError.booksMissing }
    return books.items.filter { book in
      (status == nil || book.status == status) && matches(text, [book.title, book.author ?? ""])
    }.sorted {
      if $0.timestamp == $1.timestamp { return $0.document < $1.document }
      return ($0.timestamp ?? 0) > ($1.timestamp ?? 0)
    }
  }

  func findClippings(document: String?, text: String?, since: Date?) throws -> [CachedClipping] {
    guard let clippings else { throw ShortcutsDataError.clippingsMissing }
    let visible = Set(try findBooks(status: nil, text: nil).map(\.document))
    return clippings.items.filter { clipping in
      visible.contains(clipping.document) &&
        (document == nil || clipping.document == document) &&
        (since == nil || clipping.created_at >= since!.timeIntervalSince1970) &&
        matches(text, [clipping.text, clipping.note ?? "", clipping.chapter ?? ""])
    }.sorted {
      if $0.created_at == $1.created_at {
        return clippingID(document: $0.document, id: $0.id) < clippingID(document: $1.document, id: $1.id)
      }
      return $0.created_at > $1.created_at
    }
  }

  private func matches(_ text: String?, _ fields: [String]) -> Bool {
    guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
    return fields.contains { $0.localizedStandardContains(text) }
  }
}
