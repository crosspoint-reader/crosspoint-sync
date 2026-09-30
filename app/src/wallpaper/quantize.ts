// Ported from crosspoint-pxc-converter by zgredex (github.com/zgredex).
export const GRAY_DISP = [0, 85, 170, 255] as const;

export type QuantPreset = 'pr1614' | 'master';

export type QuantThresholds = readonly [number, number, number];

export const DEFAULT_QUANT_PRESET: QuantPreset = 'pr1614';

export const QUANT_PRESET_LABELS: Record<QuantPreset, string> = {
  pr1614: 'PR1614 (default)',
  master: 'crosspoint master',
};

// Browser-side shade selection; BMP exports always store the native GRAY_DISP palette.
// PR1614 uses uniform midpoint thresholds. The alternate `master` key is retained for
// saved preferences and matches CrossPoint 1.6.5's legacy quantizer calibration:
// BitmapHelpers.cpp:quantizeSimple and BitmapHelpers.h:AtkinsonDitherer/FloydSteinbergDitherer.
// Source: https://github.com/crosspoint-reader/crosspoint-reader/tree/1.6.5/lib/GfxRenderer
export type QuantLevels = readonly [number, number, number, number];

export type QuantProfile = {
  thresholds: QuantThresholds;
  ditherThresholds: QuantThresholds;
  ditherLevels: QuantLevels;
};

const PROFILES: Record<QuantPreset, QuantProfile> = {
  pr1614: { thresholds: [43, 128, 213], ditherThresholds: [43, 128, 213], ditherLevels: GRAY_DISP },
  master: { thresholds: [45, 70, 140], ditherThresholds: [30, 55, 150], ditherLevels: [15, 35, 90, 210] },
};

export function getQuantProfile(p: QuantPreset): QuantProfile {
  return PROFILES[p];
}

export function getQuantThresholds(p: QuantPreset): QuantThresholds {
  return PROFILES[p].thresholds;
}

// Threshold triple the conversion actually bins with: error diffusion (and, approximately, the
// ordered modes) selects bins via ditherThresholds; with dithering off, quantize() uses the hard
// triple. The histogram zones/markers must match whichever path is active.
export function getActiveQuantThresholds(p: QuantPreset, ditherEnabled: boolean): QuantThresholds {
  const profile = PROFILES[p];
  return ditherEnabled ? profile.ditherThresholds : profile.thresholds;
}

export function quantize(v: number, t: QuantThresholds): 0 | 1 | 2 | 3 {
  if (v < t[0]) return 0;
  if (v < t[1]) return 1;
  if (v < t[2]) return 2;
  return 3;
}
