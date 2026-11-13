local ffi = require("ffi")
local Transport = {}

function Transport.install(turbo)
    local prepare = turbo.async.HTTPClient._prepare_http_request
    turbo.async.HTTPClient._prepare_http_request = function(client)
        local request = prepare(client)
        if type(request) == "string" and type(client.kwargs.body) == "string" then
            local _, header_end = request:find("\r\n\r\n", 1, true)
            local body_end = header_end and header_end + #client.kwargs.body
            -- Turbo adds CRLFCRLF beyond Content-Length; strict proxies reject it.
            if body_end and #request == body_end + 4 and request:sub(body_end + 1) == "\r\n\r\n" then
                return request:sub(1, body_end)
            end
        end
        return request
    end
    -- KOReader's Turbo LuaSocket writer closes on retryable partial sends.
    -- Apply only inside the upload subprocess, leaving KOReader's client untouched.
    turbo.iostream.IOStream._handle_write_nonconst = function(self)
        local ptr = self._write_buffer:get()
        local data = ffi.string(ptr + self._write_buffer_offset, math.min(self._write_buffer_size, 128 * 1024))
        local sent, err, partial = self.socket:send(data)
        if err and err ~= "timeout" and err ~= "wantwrite" and err ~= "wantread" then
            self:close()
            return
        end
        local count = sent or partial or 0
        self._write_buffer_offset = self._write_buffer_offset + count
        self._write_buffer_size = self._write_buffer_size - count
        if self._write_buffer_size == 0 then
            self._write_buffer:clear()
            self._write_buffer_offset = 0
            if self._write_callback then
                local callback, arg = self._write_callback, self._write_callback_arg
                self._write_callback, self._write_callback_arg = nil, nil
                self:_run_callback(callback, arg)
            end
        end
    end
end

return Transport
