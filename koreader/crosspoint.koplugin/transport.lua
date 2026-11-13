local ffi = require("ffi")
local Transport = {}

function Transport.install(turbo)
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
