local Annotations = {}

local function position(value)
    if type(value) == "string" or type(value) == "number" then return tostring(value) end
    if type(value) == "table" then
        return table.concat({ tostring(value.page), tostring(value.x), tostring(value.y) }, ":")
    end
    return ""
end

function Annotations.snapshot(ui, hash)
    if not ui.doc_settings or not ui.annotation or type(ui.annotation.annotations) ~= "table" then return end
    local document = ui.doc_settings:readSetting("partial_md5_checksum")
    if type(document) ~= "string" or #document ~= 32 or not document:match("^[%x]+$") then
        error("Missing book checksum. Run Progress sync before syncing annotations.")
    end
    local result = { document = document:lower(), clippings = {}, bookmarks = {} }
    local page_count = ui.document:getPageCount()
    for _, a in ipairs(ui.annotation.annotations or {}) do
        local highlight = a.drawer ~= nil
        local kind = highlight and "clippings" or "bookmarks"
        -- Text and notes can change; creation time and anchors identify the annotation.
        local identity = table.concat({ kind, a.datetime or "", position(a.page), position(a.pos0), position(a.pos1) }, "\0")
        local id = "ko-" .. hash(identity)
        local item = { id = id }
        if highlight then
            assert(type(a.text) == "string" and #a.text > 0 and #a.text <= 4096, "Highlight must contain 1–4096 bytes of text.")
            assert(not a.note or #a.note <= 4096, "Highlight note exceeds 4096 bytes.")
            item.spine = 0
            item.text, item.note, item.color, item.chapter = a.text, a.note or "", a.color or "", a.chapter
            -- shortcut: KOReader page/word coordinates differ from firmware; upload text without invented layout anchors.
        else
            item.xpath = position(a.page)
            assert(#item.xpath > 0 and #item.xpath <= 512, "Bookmark location is missing or too long.")
            local page = a.pageno or (type(a.page) == "number" and a.page)
            if type(a.page) == "string" then page = ui.document:getPageFromXPointer(a.page) end
            assert(type(page) == "number" and page_count > 0, "Cannot resolve bookmark page.")
            item.percentage = math.max(0, math.min(1, page / page_count))
            item.summary = a.note or a.text or a.chapter or ""
        end
        result[kind][id] = item
    end
    return result
end

function Annotations.changes(items, previous, encode, hash, force)
    local changes, next_state = {}, {}
    for id, item in pairs(items) do
        local fingerprint = hash(encode(item))
        next_state[id] = fingerprint
        if force or previous[id] ~= fingerprint then changes[#changes + 1] = item end
    end
    for id in pairs(previous) do
        if not items[id] then changes[#changes + 1] = { id = id, deleted = 1 } end
    end
    table.sort(changes, function(a, b) return a.id < b.id end)
    return changes, next_state
end

return Annotations
