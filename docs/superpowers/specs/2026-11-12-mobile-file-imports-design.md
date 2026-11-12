# Mobile file imports

Accept EPUB, ACSM, Markdown and plain text through Android Share/Open and iOS Share/Open In. Copy files into owned durable storage, then show them in Send books. Keep files until successful transmission or explicit removal; failed sends and restarts retain them. Import without requiring a reader connection. Support multiple files and distinct files with identical names.

Use a native filesystem queue shared by Rust and native importers. iOS uses the existing App Group so the Share extension can write while the app is closed. Android copies content URI streams while their temporary grants are valid. Publish each file atomically in a unique directory. JavaScript lists metadata and reads bytes only when sending; existing optimization and ACSM handling remain in use. File-picker imports use the same queue.

Approaches considered: document registration alone misses the iOS Share extension; a WebView-only queue cannot receive while closed. Chosen: native receiving plus one durable queue, as authorized in chat. iOS Share confirms storage and asks the user to open the app (no unsupported extension-to-app launch). Open In opens directly. Incoming files never send automatically.

Validate extensions and names, confine reads/removals to the queue, avoid overwriting same-name files, leave failed imports unpublished, report errors, and retain originals on transfer failure. Unsupported files and plain browser links are not imported. No unrelated scheme changes are included.
