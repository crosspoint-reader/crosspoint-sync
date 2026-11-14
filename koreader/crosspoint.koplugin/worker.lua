local DataStorage = require("datastorage")
local JSON = require("json")
local SQ3 = require("lua-ljsqlite3/init")
local lfs = require("libs/libkoreader-lfs")
local md5 = require("ffi/sha2").md5
local plugin_dir = debug.getinfo(1, "S").source:sub(2):match("^(.*)/")
local Sync = dofile(plugin_dir .. "/sync.lua")
local Transport = dofile(plugin_dir .. "/transport.lua")
local Annotations = dofile(plugin_dir .. "/annotations.lua")

-- This function runs only in a child process; it never accesses UI or reader objects.
return function(settings, sent, annotation_sent, snapshot, automatic, checkpoint)
    local conn, looper, ok_result, error_result
    local synced = 0
    local skipped = {}
    local function acknowledged()
        checkpoint({ ok = false, result = "Sync interrupted. Retry after the next Progress sync.",
            sent = sent, annotation_sent = annotation_sent })
    end
    local ok, err = pcall(function()
        TURBO_SSL = true
        __TURBO_USE_LUASOCKET__ = true
        local turbo = require("turbo")
        Transport.install(turbo)
        looper = turbo.ioloop.IOLoop()
        looper:add_callback(function()
            local uploaded, upload_error = pcall(function()
                local client = turbo.async.HTTPClient({ verify_ca = true, ca_path = plugin_dir .. "/cacert.pem" }, looper, 4 * 1024 * 1024)
                if snapshot then
                    local previous = annotation_sent[snapshot.document] or {}
                    annotation_sent[snapshot.document] = previous
                    for _, kind in ipairs({ "clippings", "bookmarks" }) do
                        local changes, next_state = Annotations.changes(snapshot[kind], previous[kind] or {}, JSON.encode, md5, not automatic)
                        for first = 1, #changes, 50 do
                            local batch = {}
                            for i = first, math.min(first + 49, #changes) do batch[#batch + 1] = changes[i] end
                            local response = coroutine.yield(client:fetch(settings.server .. "/api/v1/" .. kind .. "/" .. snapshot.document, {
                                method = "PUT", body = JSON.encode({ items = batch }),
                                connect_timeout = 10, request_timeout = 30, allow_redirects = false,
                                on_headers = function(headers)
                                    headers:add("Content-Type", "application/json")
                                    headers:add("x-auth-user", settings.username)
                                    headers:add("x-auth-key", settings.userkey)
                                end,
                            }))
                            local decoded, result = pcall(JSON.decode, response.body or "")
                            if response.error then error(Sync.connectionError(response), 0) end
                            if response.code ~= 200 or not decoded or type(result) ~= "table" or result.accepted ~= #batch then
                                error("Could not sync " .. kind .. ". Check your account, server version and connection, then retry.", 0)
                            end
                            previous[kind] = previous[kind] or {}
                            for _, item in ipairs(batch) do previous[kind][item.id] = next_state[item.id] end
                            acknowledged()
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
                    local payload = Sync.payload(conn, book, settings.timezone)
                    conn:close()
                    conn = nil
                    if #payload.pages == 0 then error("Reading history changed during sync. Retry Sync now.", 0) end
                    local body = JSON.encode(payload)
                    local fingerprint = md5(body)
                    if not automatic or sent[book.md5] ~= fingerprint then
                        local response = coroutine.yield(client:fetch(settings.server .. "/api/v1/stats/koreader", {
                            method = "POST", body = body,
                            connect_timeout = 10, request_timeout = 30, allow_redirects = false,
                            on_headers = function(headers)
                                headers:add("Content-Type", "application/json")
                                headers:add("x-auth-user", settings.username)
                                headers:add("x-auth-key", settings.userkey)
                            end,
                        }))
                        if response.error then error(Sync.connectionError(response), 0) end
                        local decoded, result = pcall(JSON.decode, response.body or "")
                        if response.code == 409 then
                            -- Preserve legacy totals; one conflicting book must not block the library.
                            skipped[#skipped + 1] = book.title
                        elseif response.code ~= 200 then
                            local detail = decoded and type(result) == "table" and type(result.message) == "string" and result.message:sub(1, 500)
                            error(book.title .. ": " .. (detail or ("Server returned HTTP " .. tostring(response.code) .. ". Check your account and server version.")), 0)
                        else
                            if not decoded or not Sync.acknowledged(result, payload) then error("Server did not acknowledge the history. Update CrossPoint Sync and retry.", 0) end
                            sent[book.md5] = fingerprint
                            synced = synced + 1
                            acknowledged()
                        end
                    end
                end
            end)
            looper:close()
            ok_result, error_result = uploaded, upload_error
        end)
        looper:start()
    end)
    if conn then pcall(function() conn:close() end) end
    if looper then pcall(function() looper:close() end) end
    if ok then ok, err = ok_result, error_result end
    local result = ok and (tostring(synced) .. " books of history synced to CrossPoint; available annotations synced.")
        or (tostring(synced) .. " books synced before stopping.\n\n" .. tostring(err or "Upload worker stopped unexpectedly.") .. "\n\nYour history is still on this reader. Retry Sync now; already received records will not be counted twice.")
    if #skipped > 0 then
        result = result .. "\n\nSkipped history for " .. tostring(#skipped) .. " books with existing import conflicts: " .. table.concat(skipped, "; ") .. ". Their saved history is unchanged."
    end
    return { ok = ok == true, result = result, sent = sent, annotation_sent = annotation_sent }
end
