-- Pure request construction and SQLite reads, kept separate from the menu/network UI.
local Sync = { MAX_PAGES = 20000 }

function Sync.server(value)
    local server = value:match("^%s*(.-)%s*$"):gsub("/+$", "")
    local scheme, authority, path = server:match("^(https?)://([^/]+)(.*)$")
    if not scheme or authority:find("[@%s?#]") or path:find("[%s?#]") then
        return nil, "Enter a server URL, without a username, query or fragment."
    end
    if scheme ~= "https" and not authority:match("^127%.0%.0%.1:?%d*$") and not authority:match("^localhost:?%d*$") then
        return nil, "Use HTTPS for your server (HTTP is only supported on localhost)."
    end
    return server
end

function Sync.books(conn)
    -- A metadata edit can create more than one book row with the same MD5.
    local rows = conn:exec([[SELECT COALESCE(lower(md5), '') AS md5, MAX(COALESCE(title, '')) AS title,
        MAX(COALESCE(authors, '')) AS authors FROM book
        WHERE EXISTS (SELECT 1 FROM page_stat_data p WHERE p.id_book = book.id AND p.total_pages > 0 AND p.duration > 0)
        GROUP BY lower(md5) ORDER BY lower(md5)]])
    local books = {}
    if rows then
        for i, hash in ipairs(rows.md5) do
            if #hash ~= 32 or not hash:match("^[0-9a-f]+$") then error("Invalid book identifier in reading statistics.") end
            books[#books + 1] = { md5 = hash, title = rows.title[i], authors = rows.authors[i] }
        end
    end
    return books
end

function Sync.payload(conn, book, timezone)
    -- hash is validated before interpolation; each event keeps its original page count.
    assert(#book.md5 == 32 and book.md5:match("^[0-9a-f]+$"), "Invalid book identifier")
    local rows = conn:exec(string.format([[SELECT p.page, p.total_pages, p.start_time, MAX(p.duration) AS duration
        FROM page_stat_data p JOIN book b ON b.id = p.id_book
        WHERE lower(b.md5) = '%s' AND p.total_pages > 0 AND p.duration > 0
        GROUP BY p.page, p.total_pages, p.start_time ORDER BY p.start_time, p.page, p.total_pages LIMIT %d]], book.md5, Sync.MAX_PAGES + 1))
    local pages = {}
    if rows then
        if #rows.page > Sync.MAX_PAGES then error("This book exceeds 20,000 page records. Use the history-file importer.") end
        for i = 1, #rows.page do
            pages[i] = { page = tonumber(rows.page[i]), total_pages = tonumber(rows.total_pages[i]),
                start_time = tonumber(rows.start_time[i]), duration = tonumber(rows.duration[i]) }
        end
    end
    return { version = 1, book = book, timezone = timezone, pages = pages }
end

function Sync.acknowledged(response, payload)
    return type(response) == "table" and response.version == 1
        and response.document == payload.book.md5 and response.accepted == #payload.pages
end

function Sync.connectionError(response)
    local failure = response.error
    local message = type(failure) == "table" and failure.message or failure
    local code = type(failure) == "table" and failure.code
    local detail = type(message) == "string" and message:gsub("[%c]", " "):sub(1, 500) or "No transport error details were returned."
    local suffix = type(code) == "number" and (" (code " .. tostring(code) .. ")") or ""
    return "Connection failed" .. suffix .. ": " .. detail
end

return Sync
