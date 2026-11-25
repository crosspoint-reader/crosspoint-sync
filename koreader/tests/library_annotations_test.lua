local root = os.tmpname()
os.remove(root)
assert(os.execute('mkdir "' .. root .. '"'))
local function write(name, contents)
    local f = assert(io.open(root .. "/" .. name, "w"))
    f:write(contents); f:close()
end
local function exists(path)
    local f = io.open(path, "r")
    if f then f:close(); return "file" end
end
local files = {}
local function fixture(name, metadata)
    write(name, "book")
    write(name .. ".lua", metadata)
    files[#files + 1] = name; files[#files + 1] = name .. ".lua"
end
package.preload["datastorage"] = function() return { getDataDir = function() return root end } end
package.preload["docsettings"] = function() return {
    findSidecarFile = function(_, path) if exists(path .. ".lua") then return path .. ".lua" end end,
    open = function() error("Must not open or rewrite KOReader settings") end,
} end
package.preload["libs/libkoreader-lfs"] = function() return { attributes = exists } end
local Library = dofile("koreader/crosspoint.koplugin/library_annotations.lua")
local Annotations = dofile("koreader/crosspoint.koplugin/annotations.lua")
local hash = string.rep("a", 32)
local digest = function(value) return value end
local metadata = 'return {partial_md5_checksum="' .. hash .. '",doc_pages=100,annotations={' ..
    '{datetime="date",drawer="lighten",page="/a",pos0="/a.0",pos1="/a.1",text="Quote"},' ..
    '{datetime="bookmark",page="/b",pageno=25,text="Bookmark"}}}'
fixture("valid.epub", metadata)
fixture("duplicate.epub", metadata)
fixture("broken.epub", "this is not lua")
fixture("legacy.epub", 'return {bookmarks={}}')
fixture("no-page.epub", 'return {partial_md5_checksum="' .. string.rep("b",32) .. '",annotations={{page="/b"}}}')
fixture("unsafe.epub", 'os.remove("' .. root .. '/valid.epub"); return {}')
local history = {}
for _, name in ipairs({"valid.epub", "duplicate.epub", "missing.epub", "broken.epub", "legacy.epub", "no-page.epub", "unsafe.epub"}) do
    history[#history + 1] = '{file="' .. root .. '/' .. name .. '"}'
end
write("history.lua", 'return {' .. table.concat(history, ',') .. '}')
local uploads, skipped = {}, {}
Library.each(nil, digest, function(snapshot, keep_missing)
    assert(keep_missing)
    uploads[#uploads + 1] = snapshot
end, skipped)
assert(#uploads == 1 and #skipped == 4)
for _, line in ipairs(skipped) do assert(not line:find("missing.epub", 1, true), "Deleted books are not errors") end
local snapshot = uploads[1]
local _, bookmark = next(snapshot.bookmarks)
assert(bookmark.percentage == .25 and bookmark.xpath == "/b")
local live = Annotations.snapshot({doc_settings={readSetting=function() return hash end},
    annotation={annotations={{datetime="date",drawer="lighten",page="/a",pos0="/a.0",pos1="/a.1",text="Quote"}}},
    document={getPageCount=function() return 100 end}}, digest)
assert(next(snapshot.clippings) == next(live.clippings))
local n = 0
Library.each(live, digest, function() n = n + 1 end, {})
assert(n == 0, "Do not upload stale disk annotations over the live book")
assert(exists(root .. '/valid.epub') and exists(root .. '/broken.epub.lua'))
local changes = Annotations.changes({}, {old="saved"}, function() return "" end, digest, false, true)
assert(#changes == 0, "Missing annotations must not become deletions")
-- PDF bookmark locations need no document renderer.
local pdf = Annotations.fromSaved(hash, {{page=10}}, 40, digest)
assert(select(2,next(pdf.bookmarks)).percentage == .25)
os.remove(root .. '/history.lua')
Library.each(nil, digest, function() error("No history to scan") end, {})
for _, name in ipairs(files) do os.remove(root .. '/' .. name) end
assert(os.execute('rmdir "' .. root .. '"'))
print("Saved annotation checks passed: EPUB/PDF, stable IDs, current-book precedence, duplicate hashes, corrupt/missing/legacy files and read-only loading.")
