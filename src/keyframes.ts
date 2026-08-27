import type { TrackerParams } from './BlobTracker';

export interface Keyframe {
  id: string;
  time: number;          // seconds
  params: TrackerParams; // full snapshot
}

export const MIN_KEYFRAME_GAP = 0.05; // seconds

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
  keyframes: Keyframe[],
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
