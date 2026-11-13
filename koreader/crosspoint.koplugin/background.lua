local ffiUtil = require("ffi/util")
local UIManager = require("ui/uimanager")
local JSON = require("json")
local ffi = require("ffi")
local bit = require("bit")
local Background = {}
local active

function Background.running()
    return active ~= nil
end

function Background.cancel()
    if active and not active.cancelled then
        active.cancelled = true
        ffiUtil.terminateSubProcess(active.pid)
    end
end

function Background.start(work, complete)
    if active then return false, "A CrossPoint sync is already running." end
    -- os.tmpname reserves a private file; only the parent writes account settings.
    local reserved, path = pcall(os.tmpname)
    if not reserved then return false, "Could not create a sync result file." end
    local spawned, pid, err = pcall(ffiUtil.runInSubProcess, function()
        local function checkpoint(result)
            local encoded = JSON.encode(result)
            local fd = ffi.C.open(path .. ".new", bit.bor(ffi.C.O_WRONLY, ffi.C.O_CREAT, ffi.C.O_EXCL), ffi.new("int", 384))
            assert(fd >= 0, "Could not create private sync checkpoint.")
            assert(ffiUtil.writeToFD(fd, encoded, true), "Could not write sync checkpoint.")
            assert(os.rename(path .. ".new", path))
        end
        checkpoint(work(checkpoint))
    end)
    if not spawned or not pid then
        os.remove(path)
        return false, "Could not start background sync: " .. tostring(spawned and err or pid)
    end
    local job = { pid = pid, started = os.time() }
    active = job
    local function poll()
        if not ffiUtil.isSubProcessDone(pid) then
            if os.time() - job.started >= 300 then Background.cancel() end
            UIManager:scheduleIn(0.25, poll)
            return
        end
        active = nil
        local result
        local file = io.open(path, "r")
        if file then
            local contents = file:read("*a")
            file:close()
            local ok, decoded = pcall(JSON.decode, contents)
            if ok and type(decoded) == "table" and type(decoded.ok) == "boolean"
                and type(decoded.result) == "string" and type(decoded.sent) == "table"
                and type(decoded.annotation_sent) == "table" then result = decoded end
        end
        os.remove(path)
        os.remove(path .. ".new")
        if job.cancelled or not result then
            result = result or {}
            result.ok = false
            result.result = "Background sync stopped or was interrupted. Your reader data is unchanged. Retry after the next Progress sync."
        end
        complete(result)
    end
    UIManager:scheduleIn(0.25, poll)
    return true
end

return Background
