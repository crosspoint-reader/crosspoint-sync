local ffi = require("ffi")
local Transport = dofile("koreader/crosspoint.koplugin/transport.lua")
local handshakes = 0
local turbo = { crypto = { ssl_do_handshake = function(stream)
    handshakes = handshakes + 1
    if stream._ssl_options._type == 1 then assert(stream._crosspoint_sni) end
    return nil, "wantread"
end }, iostream = { IOStream = {} }, async = { HTTPClient = {
    _prepare_http_request = function(client) return client.request end,
} } }
Transport.install(turbo)
local function stream(payload, send)
    local storage = ffi.new("uint8_t[?]", #payload, payload)
    local state = {
        _write_buffer_size = #payload, _write_buffer_offset = 0,
        _write_callback_arg = "complete",
        _write_buffer = {
            get = function() return storage, #payload end,
            clear = function() end,
        },
        socket = { send = function(_, data) return send(data) end },
        close = function(self) self.closed = true end,
        _run_callback = function(_, callback, arg) callback(arg) end,
    }
    state._write_callback = function(arg)
        assert(arg == "complete")
        state.completed = (state.completed or 0) + 1
    end
    return setmetatable(state, { __index = turbo.iostream.IOStream })
end
-- Different byte patterns catch duplicate/skipped offsets, including UTF-8.
local body = string.rep("page=123; duration=45; café\n", 20000)
for _, retry in ipairs({ "timeout", "wantwrite", "wantread" }) do
    local received, calls = {}, 0
    local state = stream(body, function(data)
        calls = calls + 1
        if calls == 1 then return nil, retry, 0 end
        if calls % 2 == 0 then
            local count = math.min(713, #data)
            received[#received + 1] = data:sub(1, count)
            return nil, retry, count
        end
        received[#received + 1] = data
        return #data
    end)
    while state._write_buffer_size > 0 do
        assert(calls < 100 and not state.closed)
        state:_handle_write_nonconst()
    end
    assert(table.concat(received) == body, retry .. " lost or duplicated body bytes")
    assert(not state.closed and state.completed == 1 and state._write_buffer_offset == 0)
end
for _, failure in ipairs({ "closed", "broken pipe" }) do
    local state = stream(body, function() return nil, failure, 5 end)
    state:_handle_write_nonconst()
    assert(state.closed and not state.completed)
end
-- Small requests keep the normal success path.
local state = stream("hello", function(data) assert(data == "hello"); return #data end)
state:_handle_write_nonconst()
assert(state.completed == 1 and not state.closed)
print("Transport checks passed: large bodies, partial writes, retryable zero writes, exact bytes and fatal errors.")

-- Optional comparison with the unmodified upstream method, for reproducing the bug.
if arg[1] then
    local original = dofile(arg[1])
    local old = stream(body, function() return nil, "timeout", 713 end)
    original(old)
    assert(old.closed and not old.completed, "Expected upstream partial-send failure")
    print("Confirmed: unmodified Turbo writer closes on a recoverable partial send.")
end

-- Match Content-Length exactly, even when the actual payload ends with CRLF.
for _, body in ipairs({ "", "{}", "café", "text\r\n\r\n", string.rep("x", 500000) }) do
    local headers = "POST /test HTTP/1.1\r\nContent-Length: " .. #body .. "\r\n\r\n"
    local client = { kwargs = { body = body }, request = headers .. body .. "\r\n\r\n" }
    assert(turbo.async.HTTPClient._prepare_http_request(client) == headers .. body)
    client.request = headers .. body -- Already-correct future Turbo versions.
    assert(turbo.async.HTTPClient._prepare_http_request(client) == headers .. body)
end
assert(turbo.async.HTTPClient._prepare_http_request({kwargs={},request=-1}) == -1)
print("HTTP framing checks passed: exact Content-Length, UTF-8, trailing payload newlines and already-correct requests.")

local names = {}
local tls = { _ssl_options = { _type = 1 }, _ssl_hostname = "koreader-sync.home",
    _ssl = { sni = function(_, name) names[#names + 1] = name end } }
local ready, retry = turbo.crypto.ssl_do_handshake(tls)
assert(ready == nil and retry == "wantread")
turbo.crypto.ssl_do_handshake(tls)
assert(#names == 1 and names[1] == "koreader-sync.home" and handshakes == 2)
turbo.crypto.ssl_do_handshake({ _ssl_options = { _type = 0 } })
assert(handshakes == 3)
print("TLS SNI checks passed: hostname set before handshake, once per connection, client only.")
