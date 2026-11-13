local ffi = require("ffi")
local Transport = dofile("koreader/crosspoint.koplugin/transport.lua")
local turbo = { iostream = { IOStream = {} } }
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
