import UIKit
import UniformTypeIdentifiers

/// Receives file representations inside their provider callback, before iOS
/// deletes the temporary URL. The containing app need not be running.
final class ShareViewController: UIViewController {
    private let message = UILabel()
    private let done = UIButton(type: .system)
    private var started = false
    private var saved = 0
    private var failures: [String] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel()
        title.text = "CrossPoint Sync"
        title.font = .preferredFont(forTextStyle: .title2)
        message.text = "Saving files…"
        message.font = .preferredFont(forTextStyle: .body)
        message.numberOfLines = 0
        done.setTitle("Done", for: .normal)
        done.isEnabled = false
        done.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, message, done])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        receive(items.flatMap { $0.attachments ?? [] }, at: 0)
    }

    private func receive(_ providers: [NSItemProvider], at index: Int) {
        guard index < providers.count else {
            let summary = saved == 1 ? "1 file queued." : "\(saved) files queued."
            message.text = (saved > 0 ? summary + " Open CrossPoint Sync to send them to your reader." : "No files queued.") +
                (failures.isEmpty ? "" : "\n\n" + failures.joined(separator: "\n"))
            done.isEnabled = true
            return
        }
        let provider = providers[index]
        let finish: (Error?) -> Void = { error in
            DispatchQueue.main.async {
                if let error = error { self.failures.append(error.localizedDescription) }
                else { self.saved += 1 }
                self.receive(providers, at: index + 1)
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                guard let url = item as? URL else { finish(error ?? ImportFailure.unreadable); return }
                do { try ImportStore.copy(url, suggestedName: provider.suggestedName); finish(nil) }
                catch { finish(error) }
            }
            return
        }
        let supported = ["org.idpf.epub-container", "com.adobe.adept.acsm", "net.daringfireball.markdown", UTType.plainText.identifier]
        guard let type = supported.first(where: { provider.hasItemConformingToTypeIdentifier($0) }) else {
            finish(ImportFailure.unsupported); return
        }
        provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
            guard let url = url else { finish(error ?? ImportFailure.unreadable); return }
            do { try ImportStore.copy(url, suggestedName: provider.suggestedName); finish(nil) }
            catch { finish(error) }
        }
    }

    @objc private func close() { extensionContext?.completeRequest(returningItems: nil) }
}

enum ImportFailure: LocalizedError {
    case unsupported, unreadable, storage
    var errorDescription: String? {
        switch self {
        case .unsupported: return "Choose EPUB, Markdown, text or ACSM files."
        case .unreadable: return "Couldn't read the shared file."
        case .storage: return "Couldn't access CrossPoint Sync storage."
        }
    }
}

enum ImportStore {
    static func validName(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix(".") && !name.contains("/") && !name.contains("\\") &&
            name.rangeOfCharacter(from: .controlCharacters) == nil &&
            ["epub", "acsm", "md", "txt"].contains((name as NSString).pathExtension.lowercased())
    }

    static func copy(_ source: URL, suggestedName: String?) throws {
        guard source.isFileURL else { throw ImportFailure.unreadable }
        // A provider's suggested name preserves the original when its temporary
        // representation has a generated name. Never accept path components.
        let name = suggestedName.flatMap { validName($0) ? $0 : nil } ?? source.lastPathComponent
        guard validName(name) else { throw ImportFailure.unsupported }
        let manager = FileManager.default
        guard let group = manager.containerURL(forSecurityApplicationGroupIdentifier: "group.com.crosspointreader.sync") else {
            throw ImportFailure.storage
        }
        let root = group.appendingPathComponent("ImportQueue", isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        let id = UUID().uuidString
        let staging = root.appendingPathComponent("." + id, isDirectory: true)
        try manager.createDirectory(at: staging, withIntermediateDirectories: false)
        let accessed = source.startAccessingSecurityScopedResource()
        defer {
            if accessed { source.stopAccessingSecurityScopedResource() }
            try? manager.removeItem(at: staging)
        }
        // Coordinate with Files/iCloud providers while reading their document.
        var coordinationError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinationError) { readable in
            do { try manager.copyItem(at: readable, to: staging.appendingPathComponent(name)) }
            catch { copyError = error }
        }
        if let error = coordinationError { throw error }
        if let error = copyError { throw error }
        try manager.moveItem(at: staging, to: root.appendingPathComponent(id, isDirectory: true))
    }
}
