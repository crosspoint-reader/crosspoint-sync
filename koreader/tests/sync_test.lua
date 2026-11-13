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
local queued, shown, posted, closed, timeout, settings, encoded
local function reset()
    queued, shown, posted, closed, timeout = nil, {}, {}, false, false
    settings = { server = "https://example.com/reading", username = "reader", userkey = hash, timezone = "UTC" }
end
reset()
local UI = {
    show = function(_, message) shown[#shown + 1] = message end,
    close = function() end,
    initLooper = function() end,
    setInputTimeout = function() timeout = true end,
    resetInputTimeout = function() timeout = false end,
    looper = { add_callback = function(_, callback) queued = callback end },
}
local widget = {}
function widget:extend(fields) return setmetatable(fields, { __index = self }) end
function widget:new(fields) return setmetatable(fields or {}, { __index = self }) end
package.preload["datastorage"] = function() return { getSettingsDir = function() return "/settings" end } end
package.preload["ui/widget/infomessage"] = function() return widget end
package.preload["luasettings"] = function() return { open = function() return { readSetting = function() return settings end } end } end
package.preload["ui/widget/multiinputdialog"] = function() return widget end
package.preload["ui/network/manager"] = function() return { willRerunWhenOnline = function() return false end } end
package.preload["ui/uimanager"] = function() return UI end
package.preload["ui/widget/container/widgetcontainer"] = function() return widget end
package.preload["json"] = function() return { encode = function(value) encoded = value; return "encoded" end, decode = function(value) return value end } end
package.preload["lua-ljsqlite3/init"] = function() return { open = function() return conn end } end
package.preload["libs/libkoreader-lfs"] = function() return { attributes = function() return "file" end } end
package.preload["ffi/sha2"] = function() return { md5 = function() return hash end } end
package.preload["gettext"] = function() return function(s) return s end end
package.preload["turbo"] = function() return { async = { HTTPClient = function(options)
    assert(options.verify_ca == true and options.ca_path:match("cacert.pem$"))
    return { fetch = function(_, url, request)
        assert(url == settings.server .. "/api/v1/stats/koreader")
        assert(request.allow_redirects == false and request.request_timeout == 30)
        assert(request.method == "POST" and request.body == "encoded")
        local headers = { add = function(self, key, value) self[key] = value end }
        request.on_headers(headers)
        assert(headers["x-auth-user"] == "reader" and headers["x-auth-key"] == hash)
        posted[#posted + 1] = encoded
        return "http-await"
    end }
end } } end
conn.close = function() closed = true end
local Plugin = dofile("koreader/crosspoint.koplugin/main.lua")
local function start()
    local plugin = Plugin:new{ ui = { menu = { registerToMainMenu = function() end }, statistics = { insertDB = function() end } } }
    plugin:init()
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
print("KOReader plugin checks passed: requests, page layouts, limits, TLS settings, retries and cleanup.")
