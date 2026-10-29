import AppIntents
import Foundation

// Keep the iOS 16 floor. These actions run locally without opening the WebView.
@available(iOS 16.0, macOS 13.0, *)
enum ReadingStatus: String, AppEnum {
  case reading, paused, finished, dnf
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Reading Status"
  static var caseDisplayRepresentations: [ReadingStatus: DisplayRepresentation] = [
    .reading: "Reading", .paused: "Paused", .finished: "Finished", .dnf: "Did Not Finish",
  ]
}

@available(iOS 16.0, macOS 13.0, *)
struct BookEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Book"
  static var defaultQuery = BookQuery()
  var id: String
  @Property(title: "Title") var title: String
  @Property(title: "Author") var author: String
  @Property(title: "Reading Status") var status: ReadingStatus?
  @Property(title: "Progress (%)") var progress: Double
  @Property(title: "Last Sync") var lastSync: Date?
  @Property(title: "Cached At") var cachedAt: Date?
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: "\(author)")
  }

  init(_ book: CachedBook, in snapshot: ShortcutsSnapshot) {
    id = snapshot.bookID(book.document)
    title = book.title
    author = book.author ?? ""
    status = ReadingStatus(rawValue: book.status)
    progress = min(100, max(0, book.percentage * 100))
    lastSync = book.timestamp.map { Date(timeIntervalSince1970: $0) }
    cachedAt = snapshot.books?.cachedAt
  }
}

@available(iOS 16.0, macOS 13.0, *)
struct BookQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [BookEntity] {
    let snapshot = try ShortcutsSnapshot.load()
    let books = try snapshot.findBooks(status: nil, text: nil).map { BookEntity($0, in: snapshot) }
    // Never reconstruct an entity from the identifier alone: it may belong to an old account.
    return identifiers.compactMap { id in books.first { $0.id == id } }
  }
  func entities(matching string: String) async throws -> [BookEntity] {
    let snapshot = try ShortcutsSnapshot.load()
    return try snapshot.findBooks(status: nil, text: string).map { BookEntity($0, in: snapshot) }
  }
  func suggestedEntities() async throws -> [BookEntity] {
    let snapshot = try ShortcutsSnapshot.load()
    return try snapshot.findBooks(status: nil, text: nil).map { BookEntity($0, in: snapshot) }
  }
}

@available(iOS 16.0, macOS 13.0, *)
struct ClippingEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Clipping"
  static var defaultQuery = ClippingQuery()
  var id: String
  @Property(title: "Text") var text: String
  @Property(title: "Note") var note: String
  @Property(title: "Chapter") var chapter: String
  @Property(title: "Created At") var createdAt: Date
  @Property(title: "Book") var book: BookEntity?
  @Property(title: "Cached At") var cachedAt: Date?
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(String(text.prefix(100)))", subtitle: "\(book?.title ?? "")")
  }

  init(_ clipping: CachedClipping, in snapshot: ShortcutsSnapshot) {
    id = snapshot.clippingID(document: clipping.document, id: clipping.id)
    text = clipping.text
    note = clipping.note ?? ""
    chapter = clipping.chapter ?? ""
    createdAt = Date(timeIntervalSince1970: clipping.created_at)
    book = snapshot.books?.items.first { $0.document == clipping.document }.map { BookEntity($0, in: snapshot) }
    cachedAt = clipping.cachedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
  }
}

@available(iOS 16.0, macOS 13.0, *)
struct ClippingQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [ClippingEntity] {
    let snapshot = try ShortcutsSnapshot.load()
    let clips = try snapshot.findClippings(document: nil, text: nil, since: nil).map { ClippingEntity($0, in: snapshot) }
    return identifiers.compactMap { id in clips.first { $0.id == id } }
  }
  func entities(matching string: String) async throws -> [ClippingEntity] {
    let snapshot = try ShortcutsSnapshot.load()
    return try snapshot.findClippings(document: nil, text: string, since: nil).map { ClippingEntity($0, in: snapshot) }
  }
  func suggestedEntities() async throws -> [ClippingEntity] {
    let snapshot = try ShortcutsSnapshot.load()
    return try snapshot.findClippings(document: nil, text: nil, since: nil).prefix(20).map { ClippingEntity($0, in: snapshot) }
  }
}

@available(iOS 16.0, macOS 13.0, *)
struct FindBooksIntent: AppIntent {
  static var title: LocalizedStringResource = "Find Books"
  static var description = IntentDescription("Find books in your saved CrossPoint Sync library, even offline. Results are ordered by last sync, newest first. Open the app to refresh the cache.")
  static var openAppWhenRun = false
  @Parameter(title: "Reading Status") var status: ReadingStatus?
  @Parameter(title: "Title or Author Contains") var text: String?
  static var parameterSummary: some ParameterSummary {
    Summary("Find books") { \.$status; \.$text }
  }
  func perform() async throws -> some IntentResult & ReturnsValue<[BookEntity]> {
    let snapshot = try ShortcutsSnapshot.load()
    return .result(value: try snapshot.findBooks(status: status?.rawValue, text: text).map { BookEntity($0, in: snapshot) })
  }
}

@available(iOS 16.0, macOS 13.0, *)
struct GetBookIntent: AppIntent {
  static var title: LocalizedStringResource = "Get Book"
  static var description = IntentDescription("Get a book's saved progress, last sync and cache time without a network request.")
  static var openAppWhenRun = false
  @Parameter(title: "Book") var book: BookEntity
  static var parameterSummary: some ParameterSummary { Summary("Get \(\.$book)") }
  func perform() async throws -> some IntentResult & ReturnsValue<BookEntity> {
    let snapshot = try ShortcutsSnapshot.load()
    guard let current = try snapshot.findBooks(status: nil, text: nil).first(where: { snapshot.bookID($0.document) == book.id })
    else { throw ShortcutsDataError.bookMissing }
    return .result(value: BookEntity(current, in: snapshot))
  }
}

@available(iOS 16.0, macOS 13.0, *)
struct FindClippingsIntent: AppIntent {
  static var title: LocalizedStringResource = "Find Clippings"
  static var description = IntentDescription("Find saved clippings by book, passage, note, chapter or creation date. Open Clippings or individual books in the app to save passages. The all-book list is limited to the newest 5,000. Results are newest first.")
  static var openAppWhenRun = false
  @Parameter(title: "Book") var book: BookEntity?
  @Parameter(title: "Text Contains") var text: String?
  @Parameter(title: "Created On or After") var since: Date?
  static var parameterSummary: some ParameterSummary {
    Summary("Find clippings") { \.$book; \.$text; \.$since }
  }
  func perform() async throws -> some IntentResult & ReturnsValue<[ClippingEntity]> {
    let snapshot = try ShortcutsSnapshot.load()
    var document: String?
    if let book {
      guard let current = try snapshot.findBooks(status: nil, text: nil).first(where: { snapshot.bookID($0.document) == book.id })
      else { throw ShortcutsDataError.bookMissing }
      document = current.document
    }
    return .result(value: try snapshot.findClippings(document: document, text: text, since: since).map { ClippingEntity($0, in: snapshot) })
  }
}
