local Sync = dofile("koreader/crosspoint.koplugin/sync.lua")
local hash = string.rep("a", 32)
assert(Sync.server(" https://example.com/reading/ ") == "https://example.com/reading")
assert(Sync.server("http://localhost:1422") == "http://localhost:1422")
for _, url in ipairs({ "http://example.com", "https://name:secret@example.com", "https://example.com?q=1", "https://example.com/#token", "ftp://example.com", "https://example.com/a b" }) do
    assert(not Sync.server(url), url)
end
local books = { md5 = { hash }, title = { "A book" }, authors = { "Author" } }
local pages = { page = { 10, 40 }, total_pages = { 100, 200 }, start_time = { 1762041600, 1762045200 }, duration = { 30, 60 } }
local conn = { exec = function(_, sql)
    if sql:find("MAX%(COALESCE") then return books end
    if sql:find("MAX%(p.duration%)") then return pages end
end }
local book = Sync.books(conn)[1]
local payload = Sync.payload(conn, book, "UTC")
assert(payload.pages[1].total_pages == 100 and payload.pages[2].total_pages == 200)
assert(payload.pages[2].duration == 60 and payload.book.md5 == hash)
assert(Sync.acknowledged({ version = 1, document = hash, accepted = 2 }, payload))
assert(not Sync.acknowledged({ version = 1, document = hash, accepted = 1 }, payload))
assert(not Sync.acknowledged({ version = 1, document = "other", accepted = 2 }, payload))
local saved_page = pages.page
pages.page = {}; for i = 1, Sync.MAX_PAGES + 1 do pages.page[i] = 1 end
assert(not pcall(Sync.payload, conn, book, "UTC"))
pages.page = saved_page
assert(not pcall(Sync.payload, conn, { md5 = "'; DROP TABLE book;--" }, "UTC"))

-- Drive the real plugin through mocked KOReader APIs and yielded HTTP requests.
local queued, shown, posted, closed, timeout, settings, encoded, encoded_body, next_tick, online, saved, wifi_requests
local function reset()
    queued, shown, posted, closed, timeout = nil, {}, {}, false, false
    next_tick, online, saved, wifi_requests = nil, true, {}, 0
    settings = { server = "https://example.com/reading", username = "reader", userkey = hash, timezone = "UTC" }
end
reset()
local UI = {
    show = function(_, message) shown[#shown + 1] = message end,
    close = function() end,
    initLooper = function() end,
    nextTick = function(_, callback) next_tick = callback end,
    setInputTimeout = function() timeout = true end,
    resetInputTimeout = function() timeout = false end,
    looper = { add_callback = function(_, callback) queued = callback end },
}
local widget = {}
function widget:extend(fields) return setmetatable(fields, { __index = self }) end
function widget:new(fields) return setmetatable(fields or {}, { __index = self }) end
package.preload["datastorage"] = function() return { getSettingsDir = function() return "/settings" end } end
package.preload["ui/widget/infomessage"] = function() return widget end
package.preload["luasettings"] = function() return { open = function() return {
    readSetting = function(_, key, default) if key == "settings" then return settings end; return saved[key] or default end,
    saveSetting = function(_, key, value) saved[key] = value end,
    flush = function() end,
} end } end
package.preload["ui/widget/multiinputdialog"] = function() return widget end
package.preload["ui/network/manager"] = function() return {
    willRerunWhenOnline = function() wifi_requests = wifi_requests + 1; return false end,
    isOnline = function() return online end,
} end
package.preload["ui/uimanager"] = function() return UI end
package.preload["ui/widget/container/widgetcontainer"] = function() return widget end
package.preload["json"] = function() return { encode = function(value)
    encoded = value
    if value.id then return (value.text or "") .. (value.note or "") .. (value.xpath or "") end
    if value.items then encoded_body = "annotation-batch"; return encoded_body end
    encoded_body = value.book.md5 .. ":" .. value.timezone .. ":" .. tostring(value.pages[1].duration)
    return encoded_body
end, decode = function(value) return value end } end
package.preload["lua-ljsqlite3/init"] = function() return { open = function() return conn end } end
package.preload["libs/libkoreader-lfs"] = function() return { attributes = function() return "file" end } end
package.preload["ffi/sha2"] = function() return { md5 = function(value) return value end } end
package.preload["gettext"] = function() return function(s) return s end end
package.preload["turbo"] = function() return { async = { HTTPClient = function(options)
    assert(options.verify_ca == true and options.ca_path:match("cacert.pem$"))
    return { fetch = function(_, url, request)
        local annotation = url:find("/api/v1/clippings/") or url:find("/api/v1/bookmarks/")
        assert(annotation or url == settings.server .. "/api/v1/stats/koreader")
        assert(request.allow_redirects == false and request.request_timeout == 30)
        assert(request.method == (annotation and "PUT" or "POST") and request.body == encoded_body)
        local headers = { add = function(self, key, value) self[key] = value end }
        request.on_headers(headers)
        assert(headers["x-auth-user"] == "reader" and headers["x-auth-key"] == hash)
        posted[#posted + 1] = encoded
        return "http-await"
    end }
end } } end
local progress_calls = 0
local ProgressClient = { update_progress = function(_, ...)
    local args = { ... }
    local callback = args[select("#", ...)]
    progress_calls = progress_calls + 1
    callback(args[5] ~= "fail", 200, "original body")
    return "original return"
end }
package.preload["KOSyncClient"] = function() return ProgressClient end
conn.close = function() closed = true end
-- Transport/state tests drive the worker coroutine deterministically.
-- Real fork and delayed-worker responsiveness are covered in background_test.lua.
local in_worker, active_worker = false, false
local background = {
    running = function() return active_worker end,
    start = function(work, complete)
        active_worker = true
        queued = function()
            in_worker = true
            local result = work(function() end)
            in_worker, active_worker = false, false
            complete(result)
        end
        return true
    end,
    cancel = function() active_worker = false end,
}
local real_dofile = dofile
dofile = function(path)
    if path:match("/background.lua$") then return background end
    if path:match("/transport.lua$") then return { install = function() assert(in_worker) end } end
    return real_dofile(path)
end
require("turbo").ioloop = { IOLoop = function()
    assert(in_worker, "Network loop started on UI thread")
    local callback
    return {
        add_callback = function(_, fn) callback = fn end,
        start = function() callback() end,
        close = function() end,
    }
end }
UI.initLooper = function() error("Plugin must not start the UI network loop") end
UI.setInputTimeout = function() error("Plugin must not change UI input timeouts") end
local Plugin = dofile("koreader/crosspoint.koplugin/main.lua")
local function instance()
    local plugin = Plugin:new{ ui = { menu = { registerToMainMenu = function() end }, statistics = { insertDB = function() end } } }
    plugin:init()
    return plugin
end
local function start()
    local plugin = instance()
    plugin:sync()
    assert(plugin.busy and queued)
    local thread = coroutine.create(queued)
    local ok, result = coroutine.resume(thread)
    assert(ok, result)
    assert(result == "http-await" and not timeout)
    return plugin, thread
end
local plugin, thread = start()
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
assert(coroutine.status(thread) == "dead" and closed and not timeout and not plugin.busy)
assert(shown[#shown].text == "1 books of history synced to CrossPoint; available annotations synced.")

reset()
plugin, thread = start()
assert(coroutine.resume(thread, { code = 409, body = { message = "Re-import the original history." } }))
assert(closed and not timeout and not plugin.busy)
assert(shown[#shown].text:find("Skipped history for 1 books", 1, true))
assert(not shown[#shown].text:find("before stopping", 1, true) and not plugin.sent[hash])

-- A conflict skips only that book, acknowledges later books, and retries the skipped book next time.
reset()
local second_hash = string.rep("b", 32)
books.md5[2], books.title[2], books.authors[2] = second_hash, "Second book", "Author"
plugin, thread = start()
local continued, awaiting = coroutine.resume(thread, { code = 409, body = {} })
assert(continued and awaiting == "http-await" and #posted == 2)
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = second_hash, accepted = 2 } }))
assert(not plugin.busy and not plugin.sent[hash] and plugin.sent[second_hash])
assert(shown[#shown].text:find("1 books of history synced", 1, true))
assert(shown[#shown].text:find("A book", 1, true))
local shown_before = #shown
plugin:sync(true)
thread = coroutine.create(queued)
assert(coroutine.resume(thread))
assert(posted[#posted].book.md5 == hash)
assert(coroutine.resume(thread, { code = 409, body = {} }))
assert(coroutine.status(thread) == "dead" and #shown == shown_before)
assert(saved.last_sync:find("Skipped history for 1 books", 1, true))
books.md5[2], books.title[2], books.authors[2] = nil, nil, nil

reset()
plugin, thread = start()
assert(coroutine.resume(thread, { error = { message = "untrusted certificate" } }))
assert(closed and not plugin.busy and shown[#shown].text:find("Connection failed"))
assert(shown[#shown].text:find("untrusted certificate", 1, true))

reset()
plugin, thread = start()
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 1 } }))
assert(closed and not plugin.busy and shown[#shown].text:find("did not acknowledge"))
reset()
books.md5[2], books.title[2], books.authors[2] = string.rep("b", 32), "Second book", "Author"
plugin, thread = start()
local resumed, awaited = coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } })
assert(resumed and awaited == "http-await" and #posted == 2)
assert(coroutine.resume(thread, { code = 500, body = {} }))
assert(closed and not plugin.busy and shown[#shown].text:find("1 books synced before stopping"))


-- Normal KOSync success starts background stats without replacing its callback.
reset()
books.md5[2], books.title[2], books.authors[2] = nil, nil, nil
plugin = instance()
local function progress(ok, server, username, key)
    local called = false
    local result = ProgressClient.update_progress({ custom_url = server or settings.server },
        username or settings.username, key or settings.userkey, hash, nil, ok and "/body/p[1]" or "fail", .2, "reader", "id",
        function(success, status, body)
            called = true
            assert(success == ok and status == 200 and body == "original body")
        end)
    assert(called and result == "original return")
end
progress(false)
assert(not next_tick and not queued)
progress(true, "https://other.example")
assert(not next_tick)
progress(true, nil, "another-user")
assert(not next_tick)
progress(true, nil, nil, "other-key")
assert(not next_tick)
progress(true)
assert(next_tick and not queued and #shown == 0)
next_tick(); next_tick = nil
thread = coroutine.create(queued); queued = nil
local ok, waiting = coroutine.resume(thread)
assert(ok and waiting == "http-await" and #posted == 1 and #shown == 0 and wifi_requests == 0)
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
assert(not plugin.busy and #shown == 0 and saved.sent[hash])
-- A new plugin instance keeps acknowledgments; unchanged books are not sent again.
plugin = instance()
progress(true)
next_tick(); next_tick = nil
thread = coroutine.create(queued); queued = nil
assert(coroutine.resume(thread))
assert(coroutine.status(thread) == "dead" and #posted == 1)
-- Changed history is retried after a failed upload; only acknowledgments update the cache.
pages.duration[1] = 45
progress(true)
next_tick(); next_tick = nil
thread = coroutine.create(queued); queued = nil
assert(coroutine.resume(thread))
assert(coroutine.resume(thread, { error = { message = "offline" } }))
assert(#posted == 2 and #shown == 1 and shown[1].timeout == 5)
assert(saved.last_sync:find("Connection failed"))
progress(true)
next_tick(); next_tick = nil
thread = coroutine.create(queued); queued = nil
assert(coroutine.resume(thread))
-- Another normal progress push while uploading is coalesced into one follow-up.
progress(true)
next_tick(); next_tick = nil
assert(plugin.pending_auto and not queued)
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
assert(next_tick and #posted == 3)
next_tick(); next_tick = nil
thread = coroutine.create(queued); queued = nil
assert(coroutine.resume(thread))
assert(coroutine.status(thread) == "dead" and #posted == 3)
-- Never turn Wi-Fi back on after a suspend/disconnect progress push.
online = false
progress(true)
next_tick(); next_tick = nil
assert(not queued and wifi_requests == 0)

-- An in-flight sync from a closed reader cannot overwrite a newly configured account.
reset()
plugin, thread = start()
settings = { server = "https://different.example", username = "different", userkey = "different", timezone = "UTC" }
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
assert(not saved.sent and not saved.last_sync)
settings = plugin.settings

-- A listener failure cannot interfere with KOSync or stack another wrapper.
local Hook = dofile("koreader/crosspoint.koplugin/progress_hook.lua")
local wrapper = ProgressClient.update_progress
Hook.attach(ProgressClient, function() error("stats unavailable") end)
assert(ProgressClient.update_progress == wrapper)
local before = progress_calls
progress(true)
assert(progress_calls == before + 1)
-- Older clients omit metadata; their last-argument callback is still wrapped.
local notified = false
Hook.attach(ProgressClient, function() notified = true end)
ProgressClient.update_progress({ custom_url = settings.server }, settings.username, settings.userkey, hash, "/body", .2, "reader", "id", function() end)
assert(notified)
print("KOReader plugin checks passed: manual and automatic sync, callbacks, retries, unchanged books, offline handling and cleanup.")

-- Annotation uploads run through the same authenticated coroutine, in batches,
-- and only acknowledged batches are remembered.
local Annotations = dofile("koreader/crosspoint.koplugin/annotations.lua")
local function annotation_ui(entries)
    return {
        doc_settings = { readSetting = function() return hash end },
        annotation = { annotations = entries },
        document = {
            getPageCount = function() return 100 end,
            getPageFromXPointer = function() return 25 end,
        },
    }
end
local entries = {
    { datetime = "2026-11-13 12:00:00", drawer = "lighten", page = "/p/1", pos0 = "/p/1.0", pos1 = "/p/1.9", text = "A quotation", note = "A note" },
    { datetime = "2026-11-13 12:01:00", page = "/p/2", text = "Bookmark" },
}
local ui = annotation_ui(entries)
local snapshot = Annotations.snapshot(ui, function(value) return value end)
local clipping_id, clipping = next(snapshot.clippings)
local bookmark_id, bookmark = next(snapshot.bookmarks)
assert(clipping.text == "A quotation" and clipping.note == "A note")
assert(bookmark.xpath == "/p/2" and bookmark.percentage == .25)
entries[1].text, entries[1].note = "Edited quotation", "Edited note"
local edited = Annotations.snapshot(ui, function(value) return value end)
assert(edited.clippings[clipping_id].text == "Edited quotation")
local encode = function(item) return (item.text or "") .. (item.note or "") .. (item.xpath or "") end
local identity_hash = function(value) return value end
local changes, previous = Annotations.changes(snapshot.clippings, {}, encode, identity_hash)
assert(#changes == 1)
changes = Annotations.changes(snapshot.clippings, previous, encode, identity_hash)
assert(#changes == 0)
changes = Annotations.changes(edited.clippings, previous, encode, identity_hash)
assert(#changes == 1)
changes = Annotations.changes({}, previous, encode, identity_hash)
assert(#changes == 1 and changes[1].deleted == 1 and changes[1].id == clipping_id)
entries[1].text = string.rep("x", 4097)
assert(not pcall(Annotations.snapshot, ui, identity_hash))
assert(Annotations.snapshot({ doc_settings = ui.doc_settings, annotation = {} }, identity_hash) == nil)

reset()
plugin = instance()
ui = annotation_ui({})
for key, value in pairs(ui) do plugin.ui[key] = value end
for i = 1, 51 do
    plugin.ui.annotation.annotations[i] = { datetime = tostring(i), page = "/p/" .. i }
end
plugin:sync(true)
thread = coroutine.create(queued)
assert(coroutine.resume(thread))
assert(#posted[1].items == 50)
assert(coroutine.resume(thread, { code = 200, body = { accepted = 50 } }))
assert(#posted[2].items == 1)
assert(coroutine.resume(thread, { code = 503, body = {} }))
local count = 0
for _ in pairs(saved.annotation_sent[hash].bookmarks) do count = count + 1 end
assert(count == 50 and not plugin.busy)
plugin:sync(true)
thread = coroutine.create(queued)
assert(coroutine.resume(thread))
assert(#posted[3].items == 1)
assert(coroutine.resume(thread, { code = 200, body = { accepted = 1 } }))
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
assert(coroutine.status(thread) == "dead")
plugin.ui.annotation.annotations = {}
plugin:sync(true)
thread = coroutine.create(queued)
assert(coroutine.resume(thread))
assert(#posted[5].items == 50 and posted[5].items[1].deleted == 1)
assert(coroutine.resume(thread, { code = 200, body = { accepted = 50 } }))
assert(coroutine.resume(thread, { code = 200, body = { accepted = 1 } }))
assert(next(saved.annotation_sent[hash].bookmarks) == nil)
assert(coroutine.status(thread) == "dead")
print("KOReader annotation checks passed: stable IDs, edits, deletions, batching, acknowledgments and retries.")

entries[1].text, entries[1].note = "Short text", nil
local cleared = Annotations.snapshot(annotation_ui(entries), identity_hash)
assert(cleared.clippings[clipping_id].note == "")
reset()
plugin = instance()
for key, value in pairs(annotation_ui(entries)) do plugin.ui[key] = value end
plugin:onCloseDocument()
assert(plugin.annotation_snapshot.bookmarks[bookmark_id])
plugin.ui.document = nil
plugin:sync(true)
thread = coroutine.create(queued)
assert(coroutine.resume(thread))
assert(posted[1].items[1].text == "Short text")
assert(coroutine.resume(thread, { code = 200, body = { accepted = 1 } }))
assert(posted[2].items[1].xpath == "/p/2")
assert(coroutine.resume(thread, { code = 200, body = { accepted = 1 } }))
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
assert(coroutine.status(thread) == "dead")


-- Returning from sync must not run the network worker, with or without a UI loop.
for _, enabled in ipairs({ false, true }) do
    reset()
    UI.looper = enabled and {} or nil
    plugin = instance()
    plugin:sync(true)
    assert(plugin.busy and queued and #posted == 0 and not in_worker)
    local heartbeat = 0
    for _ = 1, 10 do heartbeat = heartbeat + 1 end
    assert(heartbeat == 10)
    thread = coroutine.create(queued)
    assert(coroutine.resume(thread))
    assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
    assert(not plugin.busy)
end
print("KOReader scheduling checks passed: sync returns before network work with Turbo on/off.")

assert(Sync.connectionError({error={code=-5,message="TLS failed\ncertificate verify failed"}}) == "Connection failed (code -5): TLS failed certificate verify failed")
assert(Sync.connectionError({error={code=-3,message="DNS lookup timed out"}}):find("DNS lookup timed out", 1, true))
assert(Sync.connectionError({error=true}):find("No transport error details", 1, true))
