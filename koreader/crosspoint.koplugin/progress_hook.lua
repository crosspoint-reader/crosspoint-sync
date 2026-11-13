-- KOSync exposes a completion callback but no progress-uploaded event.
local Hook = {}
local unpack = table.unpack or unpack

function Hook.attach(client, listener)
    client.crosspoint_stats_listener = listener
    if client.crosspoint_stats_original then return end
    local original = client.update_progress
    if type(original) ~= "function" then return end
    client.crosspoint_stats_original = original
    client.update_progress = function(instance, ...)
        local args, count = { ... }, select("#", ...)
        local callback = args[count]
        local notify = client.crosspoint_stats_listener
        if type(callback) == "function" and notify then
            local server, username, key = instance.custom_url, args[1], args[2]
            -- The callback is last in both older and newer (metadata-aware) clients.
            args[count] = function(ok, ...)
                callback(ok, ...)
                if ok then
                    -- A stats failure must never turn a successful progress push into a failure.
                    pcall(notify, server, username, key)
                end
            end
        end
        return original(instance, unpack(args, 1, count))
    end
end

return Hook
