import Foundation

// Exercise the actual extension activation predicate, rather than inspecting
// its text: a CPFONT-only provider must activate without public.file-url.
let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "src-tauri/gen/apple/CrossPointShare/Info.plist"
let data = try Data(contentsOf: URL(fileURLWithPath: path))
let info = try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: Any]
let ext = info["NSExtension"] as! [String: Any]
let attrs = ext["NSExtensionAttributes"] as! [String: Any]
let rule = NSPredicate(format: attrs["NSExtensionActivationRule"] as! String)
for type in ["com.crosspointreader.cpfont", "public.png", "public.jpeg", "public.truetype-ttf-font", "public.opentype-font"] {
    let input: [String: Any] = ["extensionItems": [["attachments": [["registeredTypeIdentifiers": [type]]]]]]
    if !rule.evaluate(with: input) {
        fputs("Share extension must accept \(type)\n", stderr)
        exit(1)
    }
}
print("Share activation checks passed")
