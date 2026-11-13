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
        assert(url == settings.server .. "/api/v1/stats/koreader")
        assert(request.allow_redirects == false and request.request_timeout == 30)
        assert(request.method == "POST" and request.body == encoded_body)
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
    assert(result == "http-await" and timeout)
    return plugin, thread
end
local plugin, thread = start()
assert(coroutine.resume(thread, { code = 200, body = { version = 1, document = hash, accepted = 2 } }))
assert(coroutine.status(thread) == "dead" and closed and not timeout and not plugin.busy)
assert(shown[#shown].text == "1 books synced to CrossPoint.")

reset()
plugin, thread = start()
assert(coroutine.resume(thread, { code = 409, body = { message = "Re-import the original history." } }))
assert(closed and not timeout and not plugin.busy)
assert(shown[#shown].text:find("Re%-import") and shown[#shown].text:find("Retry"))

reset()
plugin, thread = start()
assert(coroutine.resume(thread, { error = { message = "untrusted certificate" } }))
assert(closed and not plugin.busy and shown[#shown].text:find("Connection failed"))

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
