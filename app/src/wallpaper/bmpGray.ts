// Ported from crosspoint-pxc-converter by zgredex (github.com/zgredex).
import { GRAY_DISP } from './quantize';

export function encodeGrayBmp(q: Uint8Array, w: number, h: number): Uint8Array {
  const rowStride = Math.ceil(w / 2 + 3) & ~3;
  const palBytes = 4 * 4;
  const headerBytes = 14 + 40;
  const pixelOffset = headerBytes + palBytes;
  const pixelBytes = rowStride * h;
  const fileSize = pixelOffset + pixelBytes;

  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);

  buf[0] = 0x42;
  buf[1] = 0x4d;
  view.setUint32(2, fileSize, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint32(10, pixelOffset, true);

  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, -h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 4, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 3780, true);
  view.setInt32(42, 3780, true);
  view.setUint32(46, 4, true);
  view.setUint32(50, 4, true);

  const palOff = 54;
  for (let ci = 0; ci < 4; ci++) {
    const g = GRAY_DISP[ci];
    buf[palOff + ci * 4 + 0] = g;
    buf[palOff + ci * 4 + 1] = g;
    buf[palOff + ci * 4 + 2] = g;
    buf[palOff + ci * 4 + 3] = 0;
  }

  for (let row = 0; row < h; row++) {
    const rowBase = pixelOffset + row * rowStride;
    for (let col = 0; col < w; col++) {
      const idx = q[row * w + col] & 0x0f;
      const bIdx = rowBase + (col >> 1);
      if ((col & 1) === 0) buf[bIdx] = idx << 4;
      else buf[bIdx] |= idx;
    }
  }

  return buf;
}
