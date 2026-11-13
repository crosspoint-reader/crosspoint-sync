-- Real OS processes exercise the production scheduler. KOReader's FFI process
-- adapter and JSON codec are replaced; fork/wait/kill and elapsed time are real.
local ffi = require("ffi")
ffi.cdef[[
int fork(void); int getpid(void); int setpgid(int, int);
int waitpid(int, int *, int); int kill(int, int);
int usleep(unsigned int); void _exit(int);
struct timeval { long tv_sec; int tv_usec; };
int gettimeofday(struct timeval *, void *);
int mkstemps(char *, int); int close(int);
long write(int, const void *, unsigned long);
]]
-- Do not invent constants absent from KOReader's ffi/posix_h.lua.
assert(not pcall(function() return ffi.C.O_EXCL end))
local C = ffi.C
local function now()
    local tv = ffi.new("struct timeval[1]")
    assert(C.gettimeofday(tv, nil) == 0)
    return tonumber(tv[0].tv_sec) + tonumber(tv[0].tv_usec) / 1000000
end
local processes, tasks, paths = {}, {}, {}
local process_api = {
    writeToFD = function(fd, data, close_fd)
        local written = C.write(fd, data, #data)
        if close_fd then C.close(fd) end
        return written == #data
    end,
    runInSubProcess = function(work)
        local pid = C.fork()
        if pid == 0 then
            C.setpgid(0, 0)
            local ok = pcall(work)
            C._exit(ok and 0 or 1)
        end
        assert(pid > 0)
        processes[#processes + 1] = pid
        return pid
    end,
    isSubProcessDone = function(pid, wait)
        assert(not wait, "UI must never block waiting for a worker")
        return C.waitpid(pid, nil, 1) ~= 0 -- WNOHANG on Linux and macOS
    end,
    terminateSubProcess = function(pid) C.kill(pid, 9) end,
}
package.preload["ffi/util"] = function() return process_api end
package.preload["ui/uimanager"] = function() return {
    scheduleIn = function(_, delay, callback)
        tasks[#tasks + 1] = { at = now() + delay, callback = callback }
    end,
} end
package.preload["json"] = function() return {
    encode = function(result)
        if result.result and result.result:find("Background sync failed:", 1, true) then return "error:" .. result.result end
        return result.ok and "complete" or "checkpoint"
    end,
    decode = function(value)
        if value:sub(1, 6) == "error:" then return { ok = false, result = value:sub(7) } end
        assert(value == "complete" or value == "checkpoint", "invalid result")
        return { ok = value == "complete", result = value, sent = { acknowledged = true }, annotation_sent = {} }
    end,
} end
local original_tmpname = os.tmpname
os.tmpname = function()
    local path = original_tmpname()
    paths[#paths + 1] = path
    return path
end
local Background = dofile("koreader/crosspoint.koplugin/background.lua")
local function pump(until_done)
    local heartbeat, deadline = 0, now() + 5
    while not until_done() do
        assert(now() < deadline, "Worker never completed")
        heartbeat = heartbeat + 1 -- Simulated page-turn/input handler on the parent.
        local pending = tasks
        tasks = {}
        for _, task in ipairs(pending) do
            if now() >= task.at then task.callback() else tasks[#tasks + 1] = task end
        end
        C.usleep(10000)
    end
    return heartbeat
end
local result
local started = now()
assert(Background.start(function(checkpoint)
    checkpoint({ ok = false })
    C.usleep(600000) -- A genuinely blocking delayed response in the child.
    return { ok = true }
end, function(value) result = value end))
assert(now() - started < 0.2, "Sync blocked the UI while starting")
assert(Background.running() and not result)
assert(not Background.start(function() error("duplicate worker") end, function() end))
local beats = pump(function() return result ~= nil end)
assert(beats >= 30 and result.ok and result.sent.acknowledged and not Background.running())

-- Suspending cancels a blocked request, preserving previously acknowledged work.
result = nil
assert(Background.start(function(checkpoint)
    checkpoint({ ok = false })
    C.usleep(3000000)
    return { ok = true }
end, function(value) result = value end))
C.usleep(150000)
Background.cancel()
pump(function() return result ~= nil end)
assert(not result.ok and result.sent.acknowledged and not Background.running())

-- An unexpected child exit must not wedge the menu or accept an empty result.
result = nil
assert(Background.start(function() error("simulated worker crash") end, function(value) result = value end))
pump(function() return result ~= nil end)
assert(not result.ok and not result.sent and not Background.running())
assert(result.result:find("simulated worker crash", 1, true))

-- A hung worker is killed at the whole-job deadline without blocking the parent.
result = nil
local original_time = os.time
local fake_time = original_time()
os.time = function() return fake_time end
assert(Background.start(function() C.usleep(3000000); return { ok = true } end,
    function(value) result = value end))
fake_time = fake_time + 301
pump(function() return result ~= nil end)
os.time = original_time
assert(not result.ok and not Background.running())

-- Reporting a checkpoint failure must not depend on that same broken writer.
result = nil
local original_write = process_api.writeToFD
process_api.writeToFD = function(fd) C.close(fd); return false end
assert(Background.start(function() return { ok = true } end, function(value) result = value end))
pump(function() return result ~= nil end)
assert(not result.ok and result.result:find("Could not write sync checkpoint", 1, true))
process_api.writeToFD = original_write

process_api.runInSubProcess = function() return false, "fork unavailable" end
assert(not Background.start(function() end, function() end))
assert(not Background.running())
for _, pid in ipairs(processes) do
    assert(C.waitpid(pid, nil, 1) == -1, "Unreaped child process")
end
for _, path in ipairs(paths) do
    assert(io.open(path, "r") == nil and io.open(path .. ".new", "r") == nil, "Leaked result file")
end
print("Background process checks passed: delayed worker, UI heartbeat, overlap, cancellation, checkpoints, crash, deadline and cleanup.")
