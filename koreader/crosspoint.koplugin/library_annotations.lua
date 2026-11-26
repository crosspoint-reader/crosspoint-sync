local DataStorage = require("datastorage")
local DocSettings = require("docsettings")
local lfs = require("libs/libkoreader-lfs")
local plugin_dir = debug.getinfo(1, "S").source:sub(2):match("^(.*)/")
local Annotations = dofile(plugin_dir .. "/annotations.lua")
local Library = {}

-- Do not use ReadHistory:reload or DocSettings:open: they can remove invalid files.
local function readTable(path)
    local chunk, err
    if setfenv then
        chunk, err = loadfile(path)
        if chunk then setfenv(chunk, {}) end
    else
        chunk, err = loadfile(path, "t", {})
    end
    assert(chunk, err)
    local data = chunk()
    assert(type(data) == "table", "Invalid saved metadata")
    return data
end

function Library.each(current, hash, upload, skipped)
    local history_path = DataStorage:getDataDir() .. "/history.lua"
    if not lfs.attributes(history_path, "mode") then return end
    local history = readTable(history_path)
    local seen = current and { [current.document] = true } or {}
    local paths = {}
    for _, entry in ipairs(history) do
        local path = entry.file
        if type(path) == "string" and not paths[path] then
            paths[path] = true
            local ok, snapshot = pcall(function()
                -- History keeps deleted books; that is normal, not a skip worth reporting.
                if lfs.attributes(path, "mode") ~= "file" then return end
                -- No metadata file means KOReader has no saved annotations for this book.
                local sidecar = DocSettings:findSidecarFile(path)
                if not sidecar then return end
                local data = readTable(sidecar)
                if type(data.partial_md5_checksum) == "string" and seen[data.partial_md5_checksum:lower()] then return end
                return Annotations.fromSaved(data.partial_md5_checksum, data.annotations, data.doc_pages, hash)
            end)
            if not ok then
                skipped[#skipped + 1] = path:match("[^/]+$") .. ": " .. tostring(snapshot)
            elseif snapshot then
                seen[snapshot.document] = true
                upload(snapshot, true)
            end
        end
    end
end

return Library
