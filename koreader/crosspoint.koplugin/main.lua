local DataStorage = require("datastorage")
local InfoMessage = require("ui/widget/infomessage")
local LuaSettings = require("luasettings")
local MultiInputDialog = require("ui/widget/multiinputdialog")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local md5 = require("ffi/sha2").md5
local _ = require("gettext")
local plugin_dir = debug.getinfo(1, "S").source:sub(2):match("^(.*)/")
local Sync = dofile(plugin_dir .. "/sync.lua")
local Annotations = dofile(plugin_dir .. "/annotations.lua")
local Background = dofile(plugin_dir .. "/background.lua")
local Worker = dofile(plugin_dir .. "/worker.lua")
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
    if Background.running() then
        if not automatic then UIManager:show(InfoMessage:new{ text = _("A CrossPoint sync is already running."), timeout = 3 }) end
        return
    end
    local captured, snapshot = pcall(function()
        -- Flush in the parent; the child opens its own read-only database connection.
        if not self.reader_closed and self.ui.statistics then self.ui.statistics:insertDB() end
        if self.annotation_error then error(self.annotation_error, 0) end
        if self.reader_closed then return self.annotation_snapshot end
        return Annotations.snapshot(self.ui, md5)
    end)
    if not captured then
        UIManager:show(InfoMessage:new{ text = tostring(snapshot), timeout = automatic and 5 or nil })
        return
    end
    self.busy = true
    local settings = self.settings
    local started, start_error = Background.start(function(checkpoint)
        return Worker(settings, self.sent, self.annotation_sent, snapshot, automatic, checkpoint)
    end, function(result)
        self.busy = false
        local config = LuaSettings:open(DataStorage:getSettingsDir() .. "/crosspoint.lua")
        local current = config:readSetting("settings", {})
        if current.server == settings.server and current.username == settings.username
            and current.userkey == settings.userkey and current.timezone == settings.timezone then
            if result.sent then
                self.sent, self.annotation_sent = result.sent, result.annotation_sent
                config:saveSetting("sent", self.sent)
                config:saveSetting("annotation_sent", self.annotation_sent)
            end
            config:saveSetting("last_sync", result.result)
            config:flush()
        end
        if not automatic then
            UIManager:show(InfoMessage:new{ text = result.result })
        elseif not result.ok then
            UIManager:show(InfoMessage:new{ text = _("Progress synced, but history or annotations could not sync. See CrossPoint stats sync → Last stats sync result. Sync will retry after the next successful Progress sync."), timeout = 5 })
        end
        if self.pending_auto then
            self.pending_auto = nil
            UIManager:nextTick(function() self:sync(true) end)
        end
    end)
    if not started then
        self.busy = false
        UIManager:show(InfoMessage:new{ text = tostring(start_error), timeout = automatic and 5 or nil })
    elseif not automatic then
        UIManager:show(InfoMessage:new{ text = _("Sync started in the background. You can keep reading."), timeout = 3 })
    end
end

function CrossPoint:onSuspend()
    self.pending_auto = nil
    Background.cancel()
end

CrossPoint.onExit = CrossPoint.onSuspend

return CrossPoint
