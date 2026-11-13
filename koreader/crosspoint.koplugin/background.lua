local ffiUtil = require("ffi/util")
local UIManager = require("ui/uimanager")
local JSON = require("json")
local ffi = require("ffi")
local Background = {}
local active

function Background.running()
    return active ~= nil
end

function Background.cancel(reason)
    if active and not active.cancelled then
        active.cancelled = true
        active.reason = reason
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
            -- KOReader exposes mkstemps, but not the O_EXCL open flag.
            local template = path .. ".XXXXXX"
            local name = ffi.new("char[?]", #template + 1, template)
            local fd = ffi.C.mkstemps(name, 0)
            assert(fd >= 0, "Could not create private sync checkpoint.")
            local staging = ffi.string(name)
            local written = ffiUtil.writeToFD(fd, encoded, true)
            local renamed, rename_error
            if written then renamed, rename_error = os.rename(staging, path) end
            if not renamed then
                os.remove(staging)
                error(rename_error or "Could not write sync checkpoint.")
            end
        end
        local ok, failure = pcall(function() checkpoint(work(checkpoint)) end)
        if not ok then
            -- Preserve an actionable error even if the atomic checkpoint writer failed.
            local file = io.open(path, "w")
            if file then
                file:write(JSON.encode({ ok = false, result = "Background sync failed: " .. tostring(failure) }))
                file:close()
            end
        end
    end)
    if not spawned or not pid then
        os.remove(path)
        return false, "Could not start background sync: " .. tostring(spawned and err or pid)
    end
    local job = { pid = pid, started = os.time() }
    active = job
    local function poll()
        if not ffiUtil.isSubProcessDone(pid) then
            if os.time() - job.started >= 300 then Background.cancel("Sync exceeded the five-minute limit. Retry to continue uploading.") end
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
                and type(decoded.result) == "string"
                and ((type(decoded.sent) == "table" and type(decoded.annotation_sent) == "table")
                    or (decoded.sent == nil and decoded.annotation_sent == nil)) then result = decoded end
        end
        os.remove(path)
        if job.cancelled then
            result = result or {}
            result.ok = false
            result.result = job.reason or "Sync cancelled when the reader suspended or exited. Retry after the next Progress sync."
        elseif not result then
            result = { ok = false, result = "The sync worker exited without a readable result. Check KOReader's crash.log for an error in subprocess." }
        end
        complete(result)
    end
    UIManager:scheduleIn(0.25, poll)
    return true
end

return Background
