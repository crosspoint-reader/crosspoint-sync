local DataStorage = require("datastorage")
local InfoMessage = require("ui/widget/infomessage")
local LuaSettings = require("luasettings")
local MultiInputDialog = require("ui/widget/multiinputdialog")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local JSON = require("json")
local SQ3 = require("lua-ljsqlite3/init")
local lfs = require("libs/libkoreader-lfs")
local md5 = require("ffi/sha2").md5
local _ = require("gettext")
local plugin_dir = debug.getinfo(1, "S").source:sub(2):match("^(.*)/")
local Sync = dofile(plugin_dir .. "/sync.lua")
local Annotations = dofile(plugin_dir .. "/annotations.lua")
local ProgressHook = dofile(plugin_dir .. "/progress_hook.lua")

local CrossPoint = WidgetContainer:extend{ name = "crosspoint" }

function CrossPoint:init()
    self.config = LuaSettings:open(DataStorage:getSettingsDir() .. "/crosspoint.lua")
    self.settings = self.config:readSetting("settings", {})
    self.sent = self.config:readSetting("sent", {})
    self.annotation_sent = self.config:readSetting("annotation_sent", {})
    self.ui.menu:registerToMainMenu(self)
    self:hookProgressSync()
end

function CrossPoint:hookProgressSync()
    local ok, client = pcall(require, "KOSyncClient")
    if not ok then return end
    ProgressHook.attach(client, function(server, username, key)
        if not server or not self.settings.timezone then return end
        if Sync.server(server) ~= self.settings.server or username ~= self.settings.username or key ~= self.settings.userkey then return end
        -- Let the progress callback (including any Wi-Fi shutdown) finish first.
        UIManager:nextTick(function() self:sync(true) end)
    end)
end

function CrossPoint:onReaderReady()
    self.reader_closed = false
    self.annotation_snapshot, self.annotation_error = nil, nil
    self:hookProgressSync()
end

function CrossPoint:onCloseDocument()
    -- Preserve the live annotation list before KOReader disposes of the document.
    local ok, snapshot = pcall(Annotations.snapshot, self.ui, md5)
    self.annotation_snapshot = ok and snapshot or nil
    self.annotation_error = not ok and snapshot or nil
    self.reader_closed = true
end

function CrossPoint:addToMainMenu(menu_items)
    menu_items.crosspoint = {
        text = _("CrossPoint stats sync"),
        sub_item_table = {
            { text = _("Set up server and account"), enabled_func = function() return not self.busy end,
              callback = function() self:setup() end },
            { text = _("Sync all reading history now"), enabled_func = function() return not self.busy end,
              callback = function() self:sync() end },
            { text = _("Last stats sync result"), callback = function()
                UIManager:show(InfoMessage:new{ text = LuaSettings:open(DataStorage:getSettingsDir() .. "/crosspoint.lua"):readSetting("last_sync", _("No stats sync yet.")) })
              end },
            { text = _("About stats sync"), callback = function()
                UIManager:show(InfoMessage:new{ text = _("Automatically uploads changed reading history after a successful Progress sync to the same server and account. Use Sync all reading history now for a full backfill. Repeated uploads are deduplicated. Also uploads highlights, notes and bookmarks for the open book, including edits and deletions. Annotations are uploaded only; they are not downloaded to KOReader. Keep using Progress sync for your place in each book.\n\nHistory deleted on your reader is kept on the server. Sessions are estimated from gaps between page records.") })
              end },
        },
    }
end

function CrossPoint:setup()
    local dialog
    dialog = MultiInputDialog:new{
        title = _("CrossPoint stats sync"),
        fields = {
            { text = self.settings.server or "https://sync.crosspointreader.com", hint = _("Server URL") },
            { text = self.settings.username or "", hint = _("Sync username") },
            { hint = self.settings.userkey and _("Password (blank to keep saved password)") or _("Sync password"), text_type = "password" },
            { text = self.settings.timezone or "", hint = _("Reading time zone, e.g. America/New_York or UTC") },
        },
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            { text = _("Save"), callback = function()
                local fields = dialog:getFields()
                local server, err = Sync.server(fields[1])
                local username = fields[2]:match("^%s*(.-)%s*$")
                local timezone = fields[4]:match("^%s*(.-)%s*$")
                local key = fields[3] ~= "" and md5(fields[3]) or self.settings.userkey
                if not server or not username:match("^[%w%._@%+%-]+$") or #username > 64 or not key or timezone == "" then
                    UIManager:show(InfoMessage:new{ text = err or _("Enter your sync username, password and reading time zone.") })
                    return
                end
                -- A saved password belongs to its original server/account only.
                if fields[3] == "" and (server ~= self.settings.server or username ~= self.settings.username) then
                    UIManager:show(InfoMessage:new{ text = _("Enter the password when changing server or username.") })
                    return
                end
                self.settings = { server = server, username = username, userkey = key, timezone = timezone }
                self.sent = {}
                self.annotation_sent = {}
                self.config:saveSetting("annotation_sent", self.annotation_sent)
                self.config:saveSetting("sent", self.sent)
                self.config:saveSetting("settings", self.settings)
                self.config:flush()
                UIManager:close(dialog)
            end },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

function CrossPoint:sync(automatic)
    if self.busy then
        if automatic then self.pending_auto = true end
        return
    end
    if not self.settings.server or not self.settings.userkey then
        if not automatic then self:setup() end
        return
    end
    if automatic then
        if not NetworkMgr:isOnline() then return end
    elseif NetworkMgr:willRerunWhenOnline(function() self:sync() end) then return end
    self.busy = true
    local message
    if not automatic then
        message = InfoMessage:new{ text = _("Syncing history and annotations…") }
        UIManager:show(message)
    end
    local looper, private_loop
    local initialized, init_error = pcall(function()
        UIManager:initLooper()
        looper = UIManager.looper
        if not looper then
            -- Match KOReader's Turbo setup without changing its UI loop preference.
            TURBO_SSL = true
            __TURBO_USE_LUASOCKET__ = true
            looper = require("turbo").ioloop.IOLoop()
            private_loop = true
        end
    end)
    if not initialized then
        self.busy = false
        if message then UIManager:close(message) end
        UIManager:show(InfoMessage:new{ text = _("Could not start CrossPoint networking: ") .. tostring(init_error) })
        return
    end
    looper:add_callback(function()
        local conn
        local synced = 0
        if not private_loop then UIManager:setInputTimeout() end
        local ok, err = pcall(function()
            -- Flush completed page records; do not manufacture a page turn for the open page.
            if not self.reader_closed and self.ui.statistics then self.ui.statistics:insertDB() end
            local snapshot = self.annotation_snapshot
            if self.annotation_error then error(self.annotation_error, 0) end
            if not self.reader_closed then snapshot = Annotations.snapshot(self.ui, md5) end
            local turbo = require("turbo")
            local client = turbo.async.HTTPClient({ verify_ca = true, ca_path = plugin_dir .. "/cacert.pem" }, looper, 4 * 1024 * 1024)
            if snapshot then
                local previous = self.annotation_sent[snapshot.document] or {}
                self.annotation_sent[snapshot.document] = previous
                for _, kind in ipairs({ "clippings", "bookmarks" }) do
                    local changes, next_state = Annotations.changes(snapshot[kind], previous[kind] or {}, JSON.encode, md5, not automatic)
                    for first = 1, #changes, 50 do
                        local batch = {}
                        for i = first, math.min(first + 49, #changes) do batch[#batch + 1] = changes[i] end
                        local response = coroutine.yield(client:fetch(self.settings.server .. "/api/v1/" .. kind .. "/" .. snapshot.document, {
                            method = "PUT", body = JSON.encode({ items = batch }),
                            connect_timeout = 10, request_timeout = 30, allow_redirects = false,
                            on_headers = function(headers)
                                headers:add("Content-Type", "application/json")
                                headers:add("x-auth-user", self.settings.username)
                                headers:add("x-auth-key", self.settings.userkey)
                            end,
                        }))
                        local decoded, result = pcall(JSON.decode, response.body or "")
                        if response.error or response.code ~= 200 or not decoded or type(result) ~= "table" or result.accepted ~= #batch then
                            error("Could not sync " .. kind .. ". Check your account, server version and connection, then retry.", 0)
                        end
                        previous[kind] = previous[kind] or {}
                        for _, item in ipairs(batch) do previous[kind][item.id] = next_state[item.id] end
                    end
                end
            end
            local path = DataStorage:getSettingsDir() .. "/statistics.sqlite3"
            if not lfs.attributes(path, "mode") then
                if snapshot then return end
                error("No statistics database. Enable KOReader Reading statistics and read a book first.", 0)
            end
            conn = SQ3.open(path)
            conn:exec("PRAGMA query_only=ON;")
            local books = Sync.books(conn)
            conn:close()
            conn = nil
            if #books == 0 then
                if automatic or snapshot then return end
                error("No recorded reading history to sync.", 0)
            end
            for _, book in ipairs(books) do
                conn = SQ3.open(path)
                conn:exec("PRAGMA query_only=ON;")
                -- shortcut: read whole books to detect changes; add incremental batches if large libraries make this slow.
                local payload = Sync.payload(conn, book, self.settings.timezone)
                conn:close()
                conn = nil
                if #payload.pages == 0 then error("Reading history changed during sync. Retry Sync now.", 0) end
                local body = JSON.encode(payload)
                local fingerprint = md5(body)
                if not automatic or self.sent[book.md5] ~= fingerprint then
                    local response = coroutine.yield(client:fetch(self.settings.server .. "/api/v1/stats/koreader", {
                        method = "POST", body = body,
                        connect_timeout = 10, request_timeout = 30, allow_redirects = false,
                        on_headers = function(headers)
                            headers:add("Content-Type", "application/json")
                            headers:add("x-auth-user", self.settings.username)
                            headers:add("x-auth-key", self.settings.userkey)
                        end,
                    }))
                    if response.error then error("Connection failed. Check your server, network and device clock, then retry.", 0) end
                    local decoded, result = pcall(JSON.decode, response.body or "")
                    if response.code ~= 200 then
                        local detail = decoded and type(result) == "table" and type(result.message) == "string" and result.message:sub(1, 500)
                        error(book.title .. ": " .. (detail or ("Server returned HTTP " .. tostring(response.code) .. ". Check your account and server version.")), 0)
                    end
                    if not decoded or not Sync.acknowledged(result, payload) then error("Server did not acknowledge the history. Update CrossPoint Sync and retry.", 0) end
                    self.sent[book.md5] = fingerprint
                    synced = synced + 1
                end
            end
        end)
        if conn then pcall(function() conn:close() end) end
        if private_loop then looper:close() else UIManager:resetInputTimeout() end
        if message then UIManager:close(message) end
        self.busy = false
        local result = ok and (tostring(synced) .. " books of history synced to CrossPoint; available annotations synced.")
            or (tostring(synced) .. " books synced before stopping.\n\n" .. tostring(err) .. "\n\nYour history is still on this reader. Retry Sync now; already received records will not be counted twice.")
        -- A closed reader can finish after another instance changes the configured account.
        local config = LuaSettings:open(DataStorage:getSettingsDir() .. "/crosspoint.lua")
        local current = config:readSetting("settings", {})
        if current.server == self.settings.server and current.username == self.settings.username
            and current.userkey == self.settings.userkey and current.timezone == self.settings.timezone then
            config:saveSetting("sent", self.sent)
            config:saveSetting("annotation_sent", self.annotation_sent)
            config:saveSetting("last_sync", result)
            config:flush()
        end
        if not automatic then
            UIManager:show(InfoMessage:new{ text = result })
        elseif not ok then
            UIManager:show(InfoMessage:new{ text = _("Progress synced, but history or annotations could not sync. See CrossPoint stats sync → Last stats sync result. Sync will retry after the next successful Progress sync."), timeout = 5 })
        end
        if self.pending_auto then
            self.pending_auto = nil
            UIManager:nextTick(function() self:sync(true) end)
        end
    end)
    if private_loop then
        local started, start_error = pcall(function() looper:start() end)
        if not started then
            looper:close()
            self.busy = false
            if message then UIManager:close(message) end
            UIManager:show(InfoMessage:new{ text = _("CrossPoint networking failed: ") .. tostring(start_error) })
        end
    end
end

return CrossPoint
