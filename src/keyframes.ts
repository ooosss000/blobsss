import type { TrackerParams } from './BlobTracker';

export interface Keyframe {
  id: string;
  time: number;          // seconds
  params: TrackerParams; // full snapshot
}

export const MIN_KEYFRAME_GAP = 0.05; // seconds

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

// ─── Per-parameter keyframe tracks ──────────────────────────────────────────
//
// A second, independent keyframing system layered alongside the unified
// Keyframe[] timeline above. Only these 9 fields get their own track; every
// other TrackerParams field stays governed exclusively by the unified
// timeline via resolveActiveParams, unchanged. See
// docs/superpowers/plans/2026-08-27-per-parameter-keyframe-tracks.md for the
// full design.
export const ANIMATABLE_PARAM_KEYS = [
  'brightness', 'contrast', 'saturation', 'hue', 'gamma', 'temperature',
  'strokeColor', 'strokeWidth', 'renderMode',
] as const satisfies readonly (keyof TrackerParams)[];

export type AnimatableParamKey = typeof ANIMATABLE_PARAM_KEYS[number];

export type CurveType = 'hold' | 'linear';

export interface ParamKeyframe {
  id: string;
  time: number;
  value: number | string; // number for numeric keys, string (hex or RenderMode) otherwise
  curve: CurveType; // interpolation OUT of this keyframe toward the next one on the same track
}

export type ParamTracks = Partial<Record<AnimatableParamKey, ParamKeyframe[]>>;

/**
 * Resolves a single animatable param's value at a given time from its own
 * track. Hold before the first keyframe and after the last one. Between two
 * keyframes, the earlier one's `curve` governs: 'hold' keeps its value
 * unchanged right up to (not including) the next keyframe's own time;
 * 'linear' blends numerically, or channel-wise for '#'-prefixed hex color
 * strings. Anything else (e.g. a RenderMode string erroneously marked
 * 'linear' — there's no such thing as a blend between two enum strings)
 * falls back to holding the earlier keyframe's value, defensively.
 */
export function resolveParamValue(
  track: ParamKeyframe[] | undefined,
  time: number,
  fallback: number | string,
): number | string {
  if (!track || track.length === 0) return fallback;

  const sorted = [...track].sort((a, b) => a.time - b.time);
  if (sorted.length === 1) return sorted[0].value;

  // The most recent keyframe at or before `time` is the "previous" one
  // governing this instant; before the first keyframe's own time, hold its
  // value anyway (nothing earlier to show).
  let prevIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].time <= time) prevIdx = i;
    else break;
  }
  if (prevIdx === -1) return sorted[0].value;

  const kPrev = sorted[prevIdx];
  if (prevIdx === sorted.length - 1) return kPrev.value; // after the last keyframe

  if (kPrev.curve !== 'linear') return kPrev.value; // hold segment

  const kNext = sorted[prevIdx + 1];
  const span = kNext.time - kPrev.time;
  const t = span <= 0 ? 1 : Math.max(0, Math.min(1, (time - kPrev.time) / span));

  if (typeof kPrev.value === 'number' && typeof kNext.value === 'number') {
    return kPrev.value + (kNext.value - kPrev.value) * t;
  }
  if (
    typeof kPrev.value === 'string' && typeof kNext.value === 'string' &&
    kPrev.value.startsWith('#') && kNext.value.startsWith('#')
  ) {
    return lerpColor(kPrev.value, kNext.value, t);
  }
  // Defensive fallback for a type/curve mismatch (e.g. renderMode marked linear).
  return kPrev.value;
}

/**
 * Merges the 9 animatable params' own tracks over a `base` TrackerParams
 * (typically the unified system's own resolved snapshot for this instant —
 * see resolveActiveParams). Any of the 9 keys without its own track (or an
 * empty one) simply keeps `base`'s value for that field, unchanged.
 */
export function resolveAnimatedParams(
  paramTracks: ParamTracks,
  time: number,
  base: TrackerParams,
): TrackerParams {
  const result = { ...base };
  for (const key of ANIMATABLE_PARAM_KEYS) {
    const track = paramTracks[key];
    if (track && track.length > 0) {
      (result[key] as number | string) = resolveParamValue(track, time, base[key] as number | string);
    }
  }
  return result;
}

/**
 * Resolves the active TrackerParams at a given video time, given a set of
 * keyframes. This is a "hold" step function, not an interpolation: a
 * keyframe's params apply exactly as set, unchanged, from its own time up
 * until the next keyframe's time is reached, like a hard cut — not a
 * gradual blend. (An earlier version linearly interpolated numeric/color
 * params and hard-switched discrete params at the midpoint between two
 * keyframes; removed after user feedback that a value visibly drifting
 * away from what was explicitly set — before the next keyframe's time was
 * even reached — read as broken rather than as an intentional animation.)
 * Used identically by live preview and MP4 export so both stay in sync.
 */
export function resolveActiveParams(
  keyframes: Keyframe[],
  time: number,
  fallback: TrackerParams,
): TrackerParams {
  if (keyframes.length === 0) return fallback;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // The most recent keyframe at or before `time` governs; before the first
  // keyframe's own time, hold its params anyway (nothing earlier to show).
  let active = sorted[0];
  for (const k of sorted) {
    if (k.time <= time) active = k;
    else break;
  }
  return active.params;
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

/**
 * Clamps a proposed drag time for a keyframe: keeps it within [0, duration]
 * and, where the timeline has room, at least `minGap` away from every
 * other keyframe (so interpolation never divides by near-zero). Computes
 * valid intervals directly rather than iteratively pushing away from
 * neighbors, so the result is independent of array order and never
 * re-collides with a keyframe already passed. If there isn't enough room
 * to honor the gap everywhere (more keyframes than the duration can hold
 * at this spacing), returns the closest best-effort position.
 */
export function clampKeyframeTime(
  keyframes: { id: string; time: number }[],
  id: string,
  proposedTime: number,
  duration: number,
  minGap: number = MIN_KEYFRAME_GAP,
): number {
  if (!Number.isFinite(duration) || duration <= 0 || Number.isNaN(proposedTime)) return 0;
  const proposed = Math.max(0, Math.min(duration, proposedTime));

  const times = keyframes.filter(k => k.id !== id).map(k => k.time).sort((a, b) => a - b);

  const slots: Array<[number, number]> = [];
  let lo = 0;
  for (const t of times) {
    slots.push([lo, t - minGap]);
    lo = Math.max(lo, t + minGap);
  }
  slots.push([lo, duration]);

  let best: number | null = null;
  for (const [a, b] of slots) {
    const start = Math.max(0, a);
    const end = Math.min(duration, b);
    if (start > end) continue;
    const candidate = Math.max(start, Math.min(end, proposed));
    if (best === null || Math.abs(candidate - proposed) < Math.abs(best - proposed)) best = candidate;
  }
  return best ?? proposed;
}
