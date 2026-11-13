-- Opt-in integration probe using real Turbo/LuaSocket/LuaSec, no credentials or user data.
-- Usage: luajit koreader/tests/live_transport_test.lua https://HOST/api/v1/stats/koreader CA_BUNDLE
assert(arg[1] and arg[2], "Provide an HTTPS stats endpoint and CA bundle")
assert(arg[1]:match("^https://") and not arg[1]:find("@"), "Use an HTTPS URL without credentials")
TURBO_SSL = true
__TURBO_USE_LUASOCKET__ = true
local turbo = require("turbo")
dofile("koreader/crosspoint.koplugin/transport.lua").install(turbo)
local loop = turbo.ioloop.IOLoop()
local passed, failure
loop:add_callback(function()
    passed, failure = pcall(function()
        local client = turbo.async.HTTPClient({ verify_ca = true, ca_path = arg[2] }, loop, 4 * 1024 * 1024)
        for _, size in ipairs({ 100, 100000, 500000 }) do
            local response = coroutine.yield(client:fetch(arg[1], {
                method = "POST", body = string.rep("x", size),
                connect_timeout = 10, request_timeout = 15, allow_redirects = false,
                on_headers = function(headers) headers:add("Content-Type", "application/json") end,
            }))
            assert(not response.error, response.error and response.error.message)
            assert(response.code == 401, "Expected authentication rejection, got " .. tostring(response.code))
            assert(response.body and response.body:find("Unauthorized", 1, true), "Missing application response")
            print(size .. " bytes: reached application authentication (401), no proxy framing error")
        end
    end)
    loop:close()
end)
loop:start()
assert(passed, failure)
