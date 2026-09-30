// Ported from crosspoint-pxc-converter by zgredex (github.com/zgredex).
import { quantize, type QuantProfile } from './quantize';
import { BLUE_NOISE_64 } from './blueNoise';

export type DitherMode = 'fs' | 'atk' | 'jjn' | 'stucki' | 'burkes' | 'bayer' | 'zhou-fang' | 'blue-noise';

export const DITHER_FILENAME_SUFFIX: Record<DitherMode, string> = {
  fs: 'fs',
  atk: 'atk',
  jjn: 'jjn',
  stucki: 'stk',
  burkes: 'bks',
  bayer: 'bay',
  'zhou-fang': 'zf',
  'blue-noise': 'bn',
};

// Zhou & Fang, "Improving mid-tone quality of variable-coefficient error
// diffusion using threshold modulation", SIGGRAPH 2003. Per-intensity FS-style
// kernel coefficients (right, below-left, below) plus an asymmetric threshold
// modulation amplitude. Key points cover 0..127 with linear interpolation,
// mirrored across 128..255.
const ZF_MOD_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.0], [44, 0.34], [64, 0.5], [85, 1.0],
  [95, 0.17], [102, 0.5], [107, 0.7], [112, 0.79], [127, 1.0],
];

const ZF_COEFF_KEYS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0,   [13, 0, 5]],
  [1,   [1300249, 0, 499250]],
  [2,   [213113, 287, 99357]],
  [3,   [351854, 0, 199965]],
  [4,   [801100, 0, 490999]],
  [10,  [704075, 297466, 303694]],
  [22,  [46613, 31917, 21469]],
  [32,  [47482, 30617, 21900]],
  [44,  [43024, 42131, 14826]],
  [64,  [36411, 43219, 20369]],
  [72,  [38477, 53843, 7678]],
  [77,  [40503, 51547, 7948]],
  [85,  [35865, 34108, 30026]],
  [95,  [34117, 36899, 28983]],
  [102, [35464, 35049, 29485]],
  [107, [16477, 18810, 14712]],
  [112, [33360, 37954, 28685]],
  [127, [35269, 36066, 28664]],
];

function buildZouFangTables(): { mod: Float32Array; coeffs: Float32Array } {
  const halfMod = new Float32Array(128);
  for (let s = 0; s < ZF_MOD_KEYS.length - 1; s++) {
    const [k0, v0] = ZF_MOD_KEYS[s];
    const [k1, v1] = ZF_MOD_KEYS[s + 1];
    const last = s === ZF_MOD_KEYS.length - 2;
    const num = k1 - k0 + (last ? 1 : 0);
    for (let j = 0; j < num; j++) {
      const t = last ? j / (num - 1) : j / num;
      halfMod[k0 + j] = v0 + t * (v1 - v0);
    }
  }

  const halfCoeffs: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(128), new Float32Array(128), new Float32Array(128),
  ];
  for (let s = 0; s < ZF_COEFF_KEYS.length - 1; s++) {
    const [k0, v0] = ZF_COEFF_KEYS[s];
    const [k1, v1] = ZF_COEFF_KEYS[s + 1];
    const last = s === ZF_COEFF_KEYS.length - 2;
    const num = k1 - k0 + (last ? 1 : 0);
    for (let j = 0; j < num; j++) {
      const t = last ? j / (num - 1) : j / num;
      for (let c = 0; c < 3; c++) halfCoeffs[c][k0 + j] = v0[c] + t * (v1[c] - v0[c]);
    }
  }

  const mod = new Float32Array(256);
  const coeffs = new Float32Array(256 * 3);
  for (let i = 0; i < 128; i++) {
    mod[i] = halfMod[i];
    mod[255 - i] = halfMod[i];

    const sum = halfCoeffs[0][i] + halfCoeffs[1][i] + halfCoeffs[2][i];
    const a = halfCoeffs[0][i] / sum;
    const b = halfCoeffs[1][i] / sum;
    const c = halfCoeffs[2][i] / sum;
    coeffs[i * 3] = a;
    coeffs[i * 3 + 1] = b;
    coeffs[i * 3 + 2] = c;
    coeffs[(255 - i) * 3] = a;
    coeffs[(255 - i) * 3 + 1] = b;
    coeffs[(255 - i) * 3 + 2] = c;
  }
  return { mod, coeffs };
}

const { mod: ZF_MOD, coeffs: ZF_COEFFS } = buildZouFangTables();

export function ditherToIndexedGray(
  source: Float32Array,
  width: number,
  height: number,
  enabled: boolean,
  mode: DitherMode,
  profile: QuantProfile,
): Uint8Array {
  const q = new Uint8Array(width * height);
  const buf = new Float32Array(source);

  if (!enabled) {
    for (let i = 0; i < width * height; i++) {
      q[i] = quantize(Math.max(0, Math.min(255, buf[i])), profile.thresholds);
    }
    return q;
  }

  if (mode === 'bayer' || mode === 'blue-noise') {
    const levels = profile.ditherLevels;
    const threshold =
      mode === 'bayer'
        ? (_x: number, y: number, x: number) => ([0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5][(y & 3) * 4 + (x & 3)] + 0.5) / 16
        : (_x: number, y: number, x: number) => (BLUE_NOISE_64[((y & 63) << 6) | (x & 63)] + 0.5) / 256;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const v = Math.max(0, Math.min(255, buf[i]));
        const t = threshold(i, y, x);
        let lo = 0;
        for (let k = 2; k >= 0; k--) {
          if (v >= levels[k]) {
            lo = k;
            break;
          }
        }
        const hi = Math.min(lo + 1, 3);
        const frac = lo === hi ? 1 : (v - levels[lo]) / (levels[hi] - levels[lo] || 1);
        q[i] = frac > t ? hi : lo;
      }
    }
    return q;
  }

  if (mode === 'zhou-fang') {
    const levels = profile.ditherLevels;
    for (let y = 0; y < height; y++) {
      const ltr = (y & 1) === 0;
      const d = ltr ? 1 : -1;
      for (let xi = 0; xi < width; xi++) {
        const x = ltr ? xi : width - 1 - xi;
        const i = y * width + x;
        const v = Math.max(0, Math.min(255, buf[i]));
        const idx = Math.min(255, Math.floor(v));

        let lo = 0;
        for (let k = 2; k >= 0; k--) {
          if (v >= levels[k]) {
            lo = k;
            break;
          }
        }
        const hi = Math.min(lo + 1, 3);
        const span = levels[hi] - levels[lo] || 1;
        const frac = (v - levels[lo]) / span;

        const r = Math.random();
        const thr = 0.5 + (r % 0.5) * ZF_MOD[idx];
        const qv = frac >= thr ? hi : lo;
        q[i] = qv;

        const e = v - levels[qv];
        const cBase = idx * 3;
        const cR = ZF_COEFFS[cBase];
        const cBL = ZF_COEFFS[cBase + 1];
        const cB = ZF_COEFFS[cBase + 2];

        if (x + d >= 0 && x + d < width) buf[i + d] += e * cR;
        if (y + 1 < height) {
          if (x - d >= 0 && x - d < width) buf[i + width - d] += e * cBL;
          buf[i + width] += e * cB;
        }
      }
    }
    return q;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = Math.max(0, Math.min(255, buf[i]));
      const qv = quantize(v, profile.ditherThresholds);
      q[i] = qv;
      const e = v - profile.ditherLevels[qv];

      switch (mode) {
        case 'atk': {
          const k = e / 8;
          if (x + 1 < width) buf[i + 1] += k;
          if (x + 2 < width) buf[i + 2] += k;
          if (y + 1 < height) {
            if (x > 0) buf[i + width - 1] += k;
            buf[i + width] += k;
            if (x + 1 < width) buf[i + width + 1] += k;
          }
          if (y + 2 < height) buf[i + width * 2] += k;
          break;
        }
        case 'jjn': {
          const k = e / 48;
          if (x + 1 < width) buf[i + 1] += 7 * k;
          if (x + 2 < width) buf[i + 2] += 5 * k;
          if (y + 1 < height) {
            if (x > 1) buf[i + width - 2] += 3 * k;
            if (x > 0) buf[i + width - 1] += 5 * k;
            buf[i + width] += 7 * k;
            if (x + 1 < width) buf[i + width + 1] += 5 * k;
            if (x + 2 < width) buf[i + width + 2] += 3 * k;
          }
          if (y + 2 < height) {
            if (x > 1) buf[i + width * 2 - 2] += k;
            if (x > 0) buf[i + width * 2 - 1] += 3 * k;
            buf[i + width * 2] += 5 * k;
            if (x + 1 < width) buf[i + width * 2 + 1] += 3 * k;
            if (x + 2 < width) buf[i + width * 2 + 2] += k;
          }
          break;
        }
        case 'stucki': {
          const k = e / 42;
          if (x + 1 < width) buf[i + 1] += 8 * k;
          if (x + 2 < width) buf[i + 2] += 4 * k;
          if (y + 1 < height) {
            if (x > 1) buf[i + width - 2] += 2 * k;
            if (x > 0) buf[i + width - 1] += 4 * k;
            buf[i + width] += 8 * k;
            if (x + 1 < width) buf[i + width + 1] += 4 * k;
            if (x + 2 < width) buf[i + width + 2] += 2 * k;
          }
          if (y + 2 < height) {
            if (x > 1) buf[i + width * 2 - 2] += k;
            if (x > 0) buf[i + width * 2 - 1] += 2 * k;
            buf[i + width * 2] += 4 * k;
            if (x + 1 < width) buf[i + width * 2 + 1] += 2 * k;
            if (x + 2 < width) buf[i + width * 2 + 2] += k;
          }
          break;
        }
        case 'burkes': {
          const k = e / 32;
          if (x + 1 < width) buf[i + 1] += 8 * k;
          if (x + 2 < width) buf[i + 2] += 4 * k;
          if (y + 1 < height) {
            if (x > 1) buf[i + width - 2] += 2 * k;
            if (x > 0) buf[i + width - 1] += 4 * k;
            buf[i + width] += 8 * k;
            if (x + 1 < width) buf[i + width + 1] += 4 * k;
            if (x + 2 < width) buf[i + width + 2] += 2 * k;
          }
          break;
        }
        default:
          if (x + 1 < width) buf[i + 1] += e * 7 / 16;
          if (y + 1 < height) {
            if (x > 0) buf[i + width - 1] += e * 3 / 16;
            buf[i + width] += e * 5 / 16;
            if (x + 1 < width) buf[i + width + 1] += e * 1 / 16;
          }
          break;
      }
    }
  }

  return q;
}
