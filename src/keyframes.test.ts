import { describe, it, expect } from 'vitest';
import { resolveActiveParams, clampExportPreviewSize, clampKeyframeTime, type Keyframe } from './keyframes';
import type { TrackerParams } from './BlobTracker';

const baseParams: TrackerParams = {
  diffThreshold: 19,
  minArea: 100,
  maxArea: 9000,
  maxBlobs: 100,
  lifeFrames: 18,
  jitter: 0,
  maxBlobDim: 320,
  subdivide: 1,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  gamma: 1,
  temperature: 0,
  renderMode: 'BOX_INVERT',
  neighborLinks: 3,
  strokeColor: '#FFFFFF',
  textColor: '#FFFFFF',
  strokeWidth: 1.0,
  fontSize: 10,
  fontFamily: 'monospace',
  asciiContrast: 1.2,
  showCoordinates: true,
  showId: true,
  showSize: false,
  showLabelBG: true,
};

function kf(id: string, time: number, overrides: Partial<TrackerParams>): Keyframe {
  return { id, time, params: { ...baseParams, ...overrides } };
}

describe('resolveActiveParams', () => {
  it('returns fallback when there are no keyframes', () => {
    const result = resolveActiveParams([], 5, baseParams);
    expect(result).toBe(baseParams);
  });

  it('returns the single keyframe params regardless of time', () => {
    const only = kf('a', 3, { diffThreshold: 50 });
    expect(resolveActiveParams([only], 0, baseParams).diffThreshold).toBe(50);
    expect(resolveActiveParams([only], 999, baseParams).diffThreshold).toBe(50);
  });

  it('holds the first keyframe before the track starts', () => {
    const a = kf('a', 5, { diffThreshold: 10 });
    const b = kf('b', 10, { diffThreshold: 20 });
    expect(resolveActiveParams([a, b], 0, baseParams).diffThreshold).toBe(10);
  });

  it('holds the last keyframe after the track ends', () => {
    const a = kf('a', 5, { diffThreshold: 10 });
    const b = kf('b', 10, { diffThreshold: 20 });
    expect(resolveActiveParams([a, b], 100, baseParams).diffThreshold).toBe(20);
  });

  it('holds a numeric param at its keyframe value for the whole span, not a blend', () => {
    const a = kf('a', 0, { diffThreshold: 10, fontSize: 10 });
    const b = kf('b', 10, { diffThreshold: 30, fontSize: 20 });
    const mid = resolveActiveParams([a, b], 5, baseParams);
    expect(mid.diffThreshold).toBe(10);
    expect(mid.fontSize).toBe(10);
  });

  it('holds a color param at its keyframe value, not a channel-wise blend', () => {
    const a = kf('a', 0, { strokeColor: '#000000' });
    const b = kf('b', 10, { strokeColor: '#FFFFFF' });
    const mid = resolveActiveParams([a, b], 5, baseParams);
    expect(mid.strokeColor).toBe('#000000');
  });

  it('switches every param exactly at the next keyframe\'s time, not before', () => {
    const a = kf('a', 0, { renderMode: 'BOX_INVERT', showId: true, diffThreshold: 10 });
    const b = kf('b', 10, { renderMode: 'GHOST_TRAIL', showId: false, diffThreshold: 30 });
    const justBefore = resolveActiveParams([a, b], 9.999, baseParams);
    const atExactly = resolveActiveParams([a, b], 10, baseParams);
    expect(justBefore.renderMode).toBe('BOX_INVERT');
    expect(justBefore.showId).toBe(true);
    expect(justBefore.diffThreshold).toBe(10);
    expect(atExactly.renderMode).toBe('GHOST_TRAIL');
    expect(atExactly.showId).toBe(false);
    expect(atExactly.diffThreshold).toBe(30);
  });

  it('sorts out-of-order keyframes by time before resolving', () => {
    const b = kf('b', 10, { diffThreshold: 30 });
    const a = kf('a', 0, { diffThreshold: 10 });
    const mid = resolveActiveParams([b, a], 5, baseParams);
    expect(mid.diffThreshold).toBe(10);
  });

  it('holds the most recent of three or more keyframes', () => {
    const a = kf('a', 0, { diffThreshold: 10 });
    const b = kf('b', 5, { diffThreshold: 20 });
    const c = kf('c', 10, { diffThreshold: 30 });
    expect(resolveActiveParams([a, b, c], 2, baseParams).diffThreshold).toBe(10);
    expect(resolveActiveParams([a, b, c], 5, baseParams).diffThreshold).toBe(20);
    expect(resolveActiveParams([a, b, c], 7, baseParams).diffThreshold).toBe(20);
    expect(resolveActiveParams([a, b, c], 10, baseParams).diffThreshold).toBe(30);
  });
});

describe('clampExportPreviewSize', () => {
  it('never goes below the 240px legible floor (landscape)', () => {
    const { w, h } = clampExportPreviewSize(400, 300, 1440, 900);
    expect(Math.max(w, h)).toBe(240);
    expect(h).toBe(Math.round(w * (300 / 400)));
  });

  it('never goes below the 240px legible floor (portrait)', () => {
    const { w, h } = clampExportPreviewSize(300, 400, 1440, 900);
    expect(Math.max(w, h)).toBe(240);
    expect(w).toBe(Math.round(h * (300 / 400)));
  });

  it('caps a large landscape export by the width-relative viewport cap', () => {
    const { w, h } = clampExportPreviewSize(3840, 2160, 1440, 900);
    // maxW = min(560, 1440*0.4=576) = 560; scale = 560/1152; h follows aspect
    expect(w).toBe(560);
    expect(h).toBe(Math.round(w * (2160 / 3840)));
  });

  it('caps a large portrait export by the height-relative viewport cap without overflowing the viewport', () => {
    const { w, h } = clampExportPreviewSize(2160, 3840, 1366, 768);
    const maxH = Math.min(560, 768 * 0.4); // 307.2
    expect(h).toBeLessThanOrEqual(Math.round(maxH) + 1); // rounding tolerance
    expect(w).toBe(Math.round(h * (2160 / 3840)));
  });

  it('scales proportionally (no cap, no floor) for a mid-size export', () => {
    const { w, h } = clampExportPreviewSize(1200, 675, 1600, 900);
    // rawW = 360, rawH = 202.5; maxW = min(560,640)=560, maxH = min(560,360)=360 -> scale = min(560/360, 360/202.5, 1) = 1
    expect(w).toBe(360);
    expect(h).toBe(203);
  });

  it('is capped by the viewport-relative term, not the fixed 560 ceiling, on a small viewport', () => {
    const { w } = clampExportPreviewSize(1920, 1080, 1000, 800);
    // maxW = min(560, 400) = 400
    expect(w).toBeLessThanOrEqual(400);
  });
});

describe('clampKeyframeTime', () => {
  const kfs: Keyframe[] = [
    kf('a', 2, {}),
    kf('b', 5, {}),
    kf('c', 8, {}),
  ];

  it('clamps to [0, duration]', () => {
    expect(clampKeyframeTime(kfs, 'b', -3, 10)).toBe(0);
    expect(clampKeyframeTime(kfs, 'b', 999, 10)).toBe(10);
  });

  it('allows free movement when not near another keyframe', () => {
    expect(clampKeyframeTime(kfs, 'b', 6, 10)).toBe(6);
  });

  it('pushes away from a neighbor within the minimum gap', () => {
    const result = clampKeyframeTime(kfs, 'b', 2.02, 10);
    expect(result).toBeCloseTo(2.05, 5);
  });

  it('pushes left when the proposed time is below the neighbor', () => {
    expect(clampKeyframeTime(kfs, 'b', 1.99, 10)).toBeCloseTo(1.95, 5);
  });

  it('ignores the keyframe being dragged itself when checking neighbors', () => {
    expect(clampKeyframeTime(kfs, 'b', 5, 10)).toBe(5);
  });

  it('stays clear of every neighbor when dragged between two close ones', () => {
    const close: Keyframe[] = [kf('x', 2, {}), kf('y', 2.08, {}), kf('d', 5, {})];
    const r = clampKeyframeTime(close, 'd', 2.03, 10);
    expect(Math.abs(r - 2)).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(Math.abs(r - 2.08)).toBeGreaterThanOrEqual(0.05 - 1e-9);
  });

  it('is independent of array order', () => {
    const asc: Keyframe[] = [kf('y', 1.0, {}), kf('x', 1.05, {}), kf('d', 5, {})];
    const desc: Keyframe[] = [kf('x', 1.05, {}), kf('y', 1.0, {}), kf('d', 5, {})];
    expect(clampKeyframeTime(asc, 'd', 1.02, 10)).toBeCloseTo(clampKeyframeTime(desc, 'd', 1.02, 10), 9);
  });

  it('keeps the gap at the duration boundary', () => {
    const near: Keyframe[] = [kf('x', 9.99, {}), kf('d', 5, {})];
    expect(clampKeyframeTime(near, 'd', 10, 10)).toBeLessThanOrEqual(9.94 + 1e-9);
  });

  it('keeps the gap at the zero boundary', () => {
    const near: Keyframe[] = [kf('x', 0.01, {}), kf('d', 5, {})];
    expect(clampKeyframeTime(near, 'd', 0, 10)).toBeGreaterThanOrEqual(0.06 - 1e-9);
  });

  it('honours a custom minGap', () => {
    expect(clampKeyframeTime(kfs, 'b', 2.1, 10, 0.5)).toBeCloseTo(2.5, 5);
  });

  it('returns 0 for a non-finite or non-positive duration instead of NaN', () => {
    expect(clampKeyframeTime(kfs, 'b', 5, NaN)).toBe(0);
    expect(clampKeyframeTime(kfs, 'b', 5, 0)).toBe(0);
  });

  it('returns 0 for a non-finite proposedTime', () => {
    expect(clampKeyframeTime(kfs, 'b', NaN, 10)).toBe(0);
    expect(clampKeyframeTime(kfs, 'b', Infinity, 10)).toBe(10);
  });
});
