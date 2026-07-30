import { describe, it, expect } from 'vitest';
import { resolveActiveParams, type Keyframe } from './keyframes';
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
