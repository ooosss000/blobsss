import type { TrackerParams } from './BlobTracker';

export interface Keyframe {
  id: string;
  time: number;          // seconds
  params: TrackerParams; // full snapshot
}

export const MIN_KEYFRAME_GAP = 0.05; // seconds

const NUMERIC_KEYS = [
  'diffThreshold', 'minArea', 'maxArea', 'maxBlobs', 'lifeFrames',
  'jitter', 'maxBlobDim', 'strokeWidth', 'fontSize', 'asciiContrast',
] as const satisfies readonly (keyof TrackerParams)[];

const COLOR_KEYS = ['strokeColor', 'textColor'] as const satisfies readonly (keyof TrackerParams)[];

const DISCRETE_KEYS = [
  'subdivide', 'renderMode', 'neighborLinks', 'fontFamily',
  'showCoordinates', 'showId', 'showSize', 'showLabelBG',
] as const satisfies readonly (keyof TrackerParams)[];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  return rgbToHex(
    pa.r + (pb.r - pa.r) * t,
    pa.g + (pb.g - pa.g) * t,
    pa.b + (pb.b - pa.b) * t,
  );
}

/**
 * Resolves the active TrackerParams at a given video time, given a set of
 * keyframes. Used identically by live preview and MP4 export so both stay
 * in sync.
 */
export function resolveActiveParams(
  keyframes: Keyframe[],
  time: number,
  fallback: TrackerParams,
): TrackerParams {
  if (keyframes.length === 0) return fallback;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (sorted.length === 1) return sorted[0].params;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (time <= first.time) return first.params;
  if (time >= last.time) return last.params;

  let prevIdx = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].time <= time && time <= sorted[i + 1].time) {
      prevIdx = i;
      break;
    }
  }
  const kPrev = sorted[prevIdx];
  const kNext = sorted[prevIdx + 1];
  const span = kNext.time - kPrev.time;
  const t = span > 0 ? (time - kPrev.time) / span : 0;

  const result = { ...kPrev.params } as TrackerParams;

  for (const key of NUMERIC_KEYS) {
    const a = kPrev.params[key] as number;
    const b = kNext.params[key] as number;
    (result[key] as number) = a + (b - a) * t;
  }
  for (const key of COLOR_KEYS) {
    (result[key] as string) = lerpColor(kPrev.params[key] as string, kNext.params[key] as string, t);
  }
  for (const key of DISCRETE_KEYS) {
    (result[key] as unknown) = t < 0.5 ? kPrev.params[key] : kNext.params[key];
  }

  return result;
}

/**
 * Computes the on-screen display size for the export-mode preview box.
 * Bigger export resolutions shrink relatively more but never below a
 * legible floor; small exports stay close to natural size. Capped by a
 * fraction of the viewport so it never dominates the screen. Both axes
 * are capped independently, and the 240px floor applies to the longer edge.
 */
export function clampExportPreviewSize(
  exportW: number,
  exportH: number,
  viewportW: number,
  viewportH: number,
): { w: number; h: number } {
  const maxW = Math.min(560, viewportW * 0.4);
  const maxH = Math.min(560, viewportH * 0.4);
  const rawW = exportW * 0.3;
  const rawH = exportH * 0.3;
  const scale = Math.min(maxW / rawW, maxH / rawH, 1);
  let w = rawW * scale;
  let h = rawH * scale;
  const longEdge = Math.max(w, h);
  if (longEdge < 240) {
    const boost = 240 / longEdge;
    w *= boost;
    h *= boost;
  }
  return { w: Math.round(w), h: Math.round(h) };
}
