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

local CrossPoint = WidgetContainer:extend{ name = "crosspoint" }

function CrossPoint:init()
    self.config = LuaSettings:open(DataStorage:getSettingsDir() .. "/crosspoint.lua")
    self.settings = self.config:readSetting("settings", {})
    self.ui.menu:registerToMainMenu(self)
end

function CrossPoint:addToMainMenu(menu_items)
    menu_items.crosspoint = {
        text = _("CrossPoint stats sync"),
        sub_item_table = {
            { text = _("Set up server and account"), enabled_func = function() return not self.busy end,
              callback = function() self:setup() end },
            { text = _("Sync all reading history now"), enabled_func = function() return not self.busy end,
              callback = function() self:sync() end },
            { text = _("About stats sync"), callback = function()
                UIManager:show(InfoMessage:new{ text = _("Uploads reading history for all books. Repeated uploads are deduplicated. Reading positions and highlights are not changed. Keep using Progress sync for your place in each book.\n\nHistory deleted on your reader is kept on the server. Sessions are estimated from gaps between page records.") })
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
                self.config:saveSetting("settings", self.settings)
                self.config:flush()
                UIManager:close(dialog)
            end },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

function CrossPoint:sync()
    if self.busy then return end
    if not self.settings.server or not self.settings.userkey then self:setup(); return end
    if NetworkMgr:willRerunWhenOnline(function() self:sync() end) then return end
    self.busy = true
    local message = InfoMessage:new{ text = _("Syncing reading history…") }
    UIManager:show(message)
    UIManager:initLooper()
    UIManager.looper:add_callback(function()
        local conn
        local synced = 0
        UIManager:setInputTimeout()
        local ok, err = pcall(function()
            -- Flush completed page records; do not manufacture a page turn for the open page.
            if self.ui.statistics then self.ui.statistics:insertDB() end
            local path = DataStorage:getSettingsDir() .. "/statistics.sqlite3"
            if not lfs.attributes(path, "mode") then error("No statistics database. Enable KOReader Reading statistics and read a book first.", 0) end
            conn = SQ3.open(path)
            conn:exec("PRAGMA query_only=ON;")
            local books = Sync.books(conn)
            conn:close()
            conn = nil
            if #books == 0 then error("No recorded reading history to sync.", 0) end
            local turbo = require("turbo")
            local client = turbo.async.HTTPClient({ verify_ca = true, ca_path = plugin_dir .. "/cacert.pem" }, nil, 4 * 1024 * 1024)
            for _, book in ipairs(books) do
                conn = SQ3.open(path)
                conn:exec("PRAGMA query_only=ON;")
                -- shortcut: resend each book's full history; add incremental batches if library size makes manual sync slow.
                local payload = Sync.payload(conn, book, self.settings.timezone)
                conn:close()
                conn = nil
                if #payload.pages == 0 then error("Reading history changed during sync. Retry Sync now.", 0) end
                local response = coroutine.yield(client:fetch(self.settings.server .. "/api/v1/stats/koreader", {
                    method = "POST", body = JSON.encode(payload),
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
                synced = synced + 1
            end
        end)
        if conn then pcall(function() conn:close() end) end
        UIManager:resetInputTimeout()
        UIManager:close(message)
        self.busy = false
        UIManager:show(InfoMessage:new{ text = ok and (tostring(synced) .. " books synced to CrossPoint.")
            or (tostring(synced) .. " books synced before stopping.\n\n" .. tostring(err) .. "\n\nYour history is still on this reader. Retry Sync now; already received records will not be counted twice.") })
    end)
end

return CrossPoint
