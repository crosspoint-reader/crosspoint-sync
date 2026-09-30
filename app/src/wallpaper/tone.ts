// Ported from crosspoint-pxc-converter by zgredex (github.com/zgredex).
export function lum(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function buildLuminanceBuffer(rgba: Uint8ClampedArray): Float32Array {
  const totalPixels = rgba.length / 4;
  const buffer = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    buffer[i] = lum(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return buffer;
}

export function buildToneLut(settings: {
  blackPoint: number;
  whitePoint: number;
  gammaValue: number;
  contrastValue: number;
  invert: boolean;
}): Float32Array {
  const { blackPoint, whitePoint, gammaValue, contrastValue, invert } = settings;
  const lut = new Float32Array(256);

  const bwActive = !(blackPoint <= 0 && whitePoint >= 255) && (whitePoint - blackPoint) > 0;
  const bwRange = whitePoint - blackPoint;
  const gammaActive = gammaValue !== 1.0;
  const gammaInv = 1 / gammaValue;
  const contrastActive = contrastValue !== 0;
  const contrastFactor = contrastValue >= 0 ? 1 + contrastValue * 2 / 100 : 1 + contrastValue / 100;

  for (let i = 0; i < 256; i++) {
    let v = i;

    if (bwActive) {
      v = Math.max(0, Math.min(255, (v - blackPoint) / bwRange * 255));
    }

    if (gammaActive) {
      v = Math.pow(Math.min(255, Math.max(0, v)) / 255, gammaInv) * 255;
    }

    if (contrastActive) {
      v = Math.max(0, Math.min(255, (v - 127.5) * contrastFactor + 127.5));
    }

    if (invert) {
      v = 255 - v;
    }

    lut[i] = v;
  }

  return lut;
}

export function computeAutoLevels(hist: Uint32Array, totalPixels: number): { blackPoint: number; whitePoint: number } {
  const clip = Math.max(1, Math.round(totalPixels * 0.005));
  let lo = 0;
  let loCount = 0;
  while (lo < 255 && (loCount += hist[lo]) < clip) lo++;

  let hi = 255;
  let hiCount = 0;
  while (hi > 0 && (hiCount += hist[hi]) < clip) hi--;

  if (hi - lo < 20) {
    const mid = (lo + hi) / 2;
    lo = Math.max(0, Math.round(mid - 10));
    hi = Math.min(255, Math.round(mid + 10));
  }

  return { blackPoint: lo, whitePoint: hi };
}
