import { describe, it, expect } from 'vitest';
import { resolveActiveParams, clampExportPreviewSize, type Keyframe } from './keyframes';
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

  it('linearly interpolates numeric params between two keyframes', () => {
    const a = kf('a', 0, { diffThreshold: 10, fontSize: 10 });
    const b = kf('b', 10, { diffThreshold: 30, fontSize: 20 });
    const mid = resolveActiveParams([a, b], 5, baseParams);
    expect(mid.diffThreshold).toBe(20);
    expect(mid.fontSize).toBe(15);
  });

  it('interpolates colors channel-wise', () => {
    const a = kf('a', 0, { strokeColor: '#000000' });
    const b = kf('b', 10, { strokeColor: '#FFFFFF' });
    const mid = resolveActiveParams([a, b], 5, baseParams);
    expect(mid.strokeColor).toBe('#808080');
  });

  it('hard-switches discrete params at the midpoint', () => {
    const a = kf('a', 0, { renderMode: 'BOX_INVERT', showId: true });
    const b = kf('b', 10, { renderMode: 'GHOST_TRAIL', showId: false });
    const before = resolveActiveParams([a, b], 4, baseParams);
    const after = resolveActiveParams([a, b], 6, baseParams);
    expect(before.renderMode).toBe('BOX_INVERT');
    expect(before.showId).toBe(true);
    expect(after.renderMode).toBe('GHOST_TRAIL');
    expect(after.showId).toBe(false);
  });

  it('sorts out-of-order keyframes by time before resolving', () => {
    const b = kf('b', 10, { diffThreshold: 30 });
    const a = kf('a', 0, { diffThreshold: 10 });
    const mid = resolveActiveParams([b, a], 5, baseParams);
    expect(mid.diffThreshold).toBe(20);
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
