import Foundation

func check(_ condition: @autoclosure () throws -> Bool, _ message: String) rethrows {
  if try !condition() { fatalError(message) }
}
let json = #"{"account":"account-a","books":{"savedAt":200000,"items":[{"document":"a","title":"One","author":"Writer","status":"finished","percentage":1,"timestamp":100},{"document":"b","title":"Two","author":"Other","status":"reading","percentage":0.4,"timestamp":110}]},"clippings":{"items":[{"document":"a","id":"1","text":"A passage","note":"Remember","chapter":"Chapter 1","created_at":50,"cachedAt":200000},{"document":"b","id":"1","text":"Another passage","created_at":75,"cachedAt":210000}]}}"#
let store = try ShortcutsSnapshot.decode(Data(json.utf8))
try check(try store.findBooks(status: "finished", text: nil).map(\.document) == ["a"], "status filter")
try check(try store.findBooks(status: nil, text: "writer").map(\.document) == ["a"], "author search")
try check(try store.findBooks(status: nil, text: nil).map(\.document) == ["b", "a"], "last-sync ordering")
try check(try store.findClippings(document: "a", text: "remember", since: Date(timeIntervalSince1970: 40)).map(\.id) == ["1"], "clipping filters")
try check(try store.findClippings(document: nil, text: nil, since: Date(timeIntervalSince1970: 60)).map(\.document) == ["b"], "date filter")
check(store.bookID("a") != store.clippingID(document: "a", id: "1"), "entity IDs")
var other = store
other.account = "account-b"
check(store.bookID("a") != other.bookID("a"), "account isolation")
check(store.books?.cachedAt == Date(timeIntervalSince1970: 200), "millisecond cache timestamp")
let empty = try ShortcutsSnapshot.decode(Data(#"{"account":"a","books":{"savedAt":null,"items":[]},"clippings":null}"#.utf8))
try check(try empty.findBooks(status: nil, text: nil).isEmpty, "cached empty library")
do {
  _ = try empty.findClippings(document: nil, text: nil, since: nil)
  fatalError("missing clippings should give an actionable error")
} catch { check(error.localizedDescription.contains("Clippings"), "missing data guidance") }
let privateRoot = URL(fileURLWithPath: "/sandbox/Library/Application Support")
check(ShortcutsSnapshot.cacheDirectory(in: privateRoot, bundleIdentifier: "com.crosspointreader.sync").path == "/sandbox/Library/Application Support/com.crosspointreader.sync/Shortcuts", "private cache path")
let testDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: testDir, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: testDir) }
try Data(json.utf8).write(to: testDir.appendingPathComponent("shortcuts.json"))
try check(try ShortcutsSnapshot.load(from: testDir).account == "account-a", "load private cache without App Group")
print("Shortcuts store: 12 checks passed")
