# Preview Fixes, Transport Controls & Keyframe Export System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix preview canvas centering and export-mode preview sizing, add play/pause/restart transport controls, and add a keyframe system that varies render params over time for both live preview and MP4 export.

**Architecture:** Extract the new algorithmic core (param interpolation, color lerp, export-preview sizing math, keyframe drag-clamp math) into a standalone pure module (`src/keyframes.ts`) that's unit-tested with Vitest. Wire it into `BlobTracker` via one new resolver hook and into `App.tsx`/a new `KeyframeTimeline` component for UI. CSS fixes are isolated edits to `src/index.css`.

**Tech Stack:** React 19 + TypeScript + Vite (existing). Vitest added as the project's first test runner — scoped to the new pure-logic module only. `BlobTracker`, CSS positioning, and React/canvas wiring have no existing test conventions in this repo and depend on live DOM/canvas/video APIs that aren't meaningfully unit-testable without heavy mocking infra disproportionate to this change; those tasks use explicit manual verification steps instead (dev server, described interactions, described expected visual result).

---

## File Structure

- Create `src/keyframes.ts` — pure logic: `Keyframe` type, `resolveActiveParams`, `clampExportPreviewSize`, `clampKeyframeTime`, `lerpColor` (internal).
- Create `src/keyframes.test.ts` — Vitest unit tests for the above.
- Create `src/KeyframeTimeline.tsx` — timeline UI component (markers, drag, select, delete button). Presentational + drag gesture handling only; math delegated to `keyframes.ts`.
- Modify `src/BlobTracker.ts` — add `setLiveParamsResolver()` hook, call it from `processFrame()`.
- Modify `src/index.css` — canvas centering fix, adaptive export-preview sizing support classes, transport overlay styles, keyframe timeline styles.
- Modify `src/App.tsx` — keyframe state, selection/add/delete/drag handlers, resolver wiring, RESTART button, canvas transport overlay, KEYFRAMES panel section, adaptive export-preview sizing.
- Modify `package.json` — add `vitest` dev dependency + `test` script.

---

## Task 1: Add Vitest

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install vitest**

Run: `npm install -D vitest`
Expected: adds `vitest` under `devDependencies`.

- [ ] **Step 2: Add test script**

In `package.json`, inside `"scripts"`, add:

```json
"test": "vitest run"
```

- [ ] **Step 3: Verify the runner works with no test files yet**

Run: `npx vitest run`
Expected: `No test files found` (non-zero exit is fine at this point — confirms vitest is installed and executable; Task 2 adds the first real test).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vitest for pure-logic unit tests"
```

---

## Task 2: `keyframes.ts` — types and `resolveActiveParams`

**Files:**
- Create: `src/keyframes.ts`
- Test: `src/keyframes.test.ts`

`TrackerParams` (already defined in `src/BlobTracker.ts`) has these fields relevant here:
`diffThreshold, minArea, maxArea, maxBlobs, lifeFrames, jitter, maxBlobDim, subdivide, renderMode, neighborLinks, strokeColor, textColor, strokeWidth, fontSize, fontFamily, asciiContrast, showCoordinates, showId, showSize, showLabelBG`.

- [ ] **Step 1: Write the failing test**

Create `src/keyframes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframes.test.ts`
Expected: FAIL — `Cannot find module './keyframes'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/keyframes.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframes.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/keyframes.ts src/keyframes.test.ts
git commit -m "feat: add keyframe param interpolation core"
```

---

## Task 3: `keyframes.ts` — `clampExportPreviewSize`

**Files:**
- Modify: `src/keyframes.ts`
- Test: `src/keyframes.test.ts`

> **Note (post-implementation correction):** the first version of this task
> capped only against `viewportW`, which let portrait/tall exports overflow
> the viewport vertically (caught in code review). The version below —
> what actually shipped — caps both axes independently against
> `viewportW`/`viewportH` and applies the 240px floor to whichever edge is
> longer, so it's orientation-safe.

- [ ] **Step 1: Write the failing test**

Add to `src/keyframes.test.ts`:

```ts
import { clampExportPreviewSize } from './keyframes';

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
    expect(w).toBe(560);
    expect(h).toBe(Math.round(w * (2160 / 3840)));
  });

  it('caps a large portrait export by the height-relative viewport cap without overflowing the viewport', () => {
    const { w, h } = clampExportPreviewSize(2160, 3840, 1366, 768);
    const maxH = Math.min(560, 768 * 0.4);
    expect(h).toBeLessThanOrEqual(Math.round(maxH) + 1);
    expect(w).toBe(Math.round(h * (2160 / 3840)));
  });

  it('scales proportionally (no cap, no floor) for a mid-size export', () => {
    const { w, h } = clampExportPreviewSize(1200, 675, 1600, 900);
    expect(w).toBe(360);
    expect(h).toBe(203);
  });

  it('is capped by the viewport-relative term, not the fixed 560 ceiling, on a small viewport', () => {
    const { w } = clampExportPreviewSize(1920, 1080, 1000, 800);
    expect(w).toBeLessThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframes.test.ts`
Expected: FAIL — `clampExportPreviewSize is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/keyframes.ts`:

```ts
/**
 * Computes the on-screen display size for the export-mode preview box.
 * Bigger export resolutions shrink relatively more but never below a
 * legible floor on the longer edge; small exports stay close to natural
 * size. Each axis is capped independently against its own viewport
 * dimension, so portrait exports don't overflow a short viewport height.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/keyframes.ts src/keyframes.test.ts
git commit -m "feat: add adaptive export-preview size calculation"
```

---

## Task 4: `keyframes.ts` — `clampKeyframeTime`

**Files:**
- Modify: `src/keyframes.ts`
- Test: `src/keyframes.test.ts`

> **Note (post-implementation correction):** the first version of this task
> used a single-pass "push away from whichever neighbor is violated" loop.
> Code review proved this is order-dependent and can leave the result still
> colliding with a *different* neighbor it already passed, can produce two
> keyframes at the exact same time, and can violate the gap right at the
> `[0, duration]` boundaries. The version below — what actually shipped —
> instead computes the set of valid time intervals (gaps between existing
> keyframes, shrunk by `minGap` on each side) and snaps to the nearest
> point inside a valid interval. This is order-independent by construction
> and handles the boundaries in the same pass.

- [ ] **Step 1: Write the failing test**

Add to `src/keyframes.test.ts`:

```ts
import { clampKeyframeTime } from './keyframes';

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
    // dragging 'b' to 2.02 is within 0.05 of 'a' at time 2
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframes.test.ts`
Expected: FAIL — `clampKeyframeTime is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/keyframes.ts`:

```ts
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
  if (!Number.isFinite(duration) || duration <= 0) return 0;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframes.test.ts`
Expected: PASS — full file (16 tests) green.

- [ ] **Step 5: Commit**

```bash
git add src/keyframes.ts src/keyframes.test.ts
git commit -m "feat: add keyframe drag-time clamping"
```

---

## Task 5: Canvas centering fix

**Files:**
- Modify: `src/index.css:40-49`

- [ ] **Step 1: Edit `.main-canvas`**

In `src/index.css`, replace:

```css
.main-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  cursor: pointer;
  transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1);
  image-rendering: pixelated; /* Sharp brutalist detail */
}
```

with:

```css
.main-canvas {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  cursor: pointer;
  transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1);
  image-rendering: pixelated; /* Sharp brutalist detail */
}
```

(`width`/`height`/`object-fit` are dropped — actual on-screen size is already set in px by `BlobTracker.resize()` via `canvas.style.width/height`; `inset: 0` is what was pinning it top-left instead of centering.)

- [ ] **Step 2: Manual verification**

Run: `npm run dev`, open the app.
1. Load a landscape 16:9 video — canvas should fill/center as before (no regression).
2. Load a portrait (e.g. 9:16 Instagram-format) video — canvas should now be centered in the viewport (equal empty margins left/right), not pinned to the top-left corner.
3. Resize the browser window — canvas should stay centered.

Expected: portrait video is visually centered in both axes.

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "fix: center preview canvas for non-fullscreen-aspect video"
```

---

## Task 6: `BlobTracker` live params resolver hook

**Files:**
- Modify: `src/BlobTracker.ts`

- [ ] **Step 1: Add resolver field and setter**

In `src/BlobTracker.ts`, find the class field declarations near `width = 0; height = 0;` (line 85) and add below it:

```ts
  private liveParamsResolver: ((time: number) => TrackerParams) | null = null;
```

Then, near `public updateParams(...)` (line 103), add:

```ts
  /**
   * When set, called with the video's current time on every rendered
   * frame; the returned params replace `this.params` for that frame. Used
   * by the keyframe system so preview and export stay in sync. Pass null
   * to go back to static params driven only by updateParams().
   */
  public setLiveParamsResolver(fn: ((time: number) => TrackerParams) | null) {
    this.liveParamsResolver = fn;
  }
```

- [ ] **Step 2: Call the resolver in `processFrame()`**

In `src/BlobTracker.ts`, find `private processFrame() {` (line 278) and its first line `if (!this.width || !this.height) return;`. Add immediately after it:

```ts
    if (this.liveParamsResolver) {
      this.params = this.liveParamsResolver(this.video.currentTime);
    }
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. With no keyframes wired up yet (App.tsx isn't calling `setLiveParamsResolver` until Task 8), behavior must be unchanged — confirm the app still loads and tracks video exactly as before (no regression from this hook existing but unused).

Expected: identical behavior to pre-change app; `setLiveParamsResolver` is inert until something calls it.

- [ ] **Step 4: Commit**

```bash
git add src/BlobTracker.ts
git commit -m "feat: add live params resolver hook to BlobTracker"
```

---

## Task 7: `KeyframeTimeline` component

**Files:**
- Create: `src/KeyframeTimeline.tsx`

- [ ] **Step 1: Write the component**

> **Note (post-implementation correction):** the first version below had two
> bugs caught in code review: (1) pointer capture retargets the `click`
> event to the marker on release, so every drag also fired a click that
> deselected the keyframe being dragged; (2) `draggingId` was only cleared
> on `pointerup`, so a cancelled gesture (interrupted touch, lost capture)
> left the track silently retiming a keyframe on every subsequent hover.
> The version below — what actually shipped — adds a `draggedRef` guard on
> the click handler and `pointercancel`/`lostpointercapture` handling.

Create `src/KeyframeTimeline.tsx`:

```tsx
import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Keyframe } from './keyframes';
import { clampKeyframeTime } from './keyframes';

interface KeyframeTimelineProps {
  keyframes: Keyframe[];
  selectedId: string | null;
  currentTime: number;
  duration: number;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onRetime: (id: string, time: number) => void;
}

export function KeyframeTimeline({
  keyframes, selectedId, currentTime, duration, onSelect, onDelete, onRetime,
}: KeyframeTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggedRef = useRef(false);

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  const clientXToTime = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const handlePointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setDraggingId(id);
    draggedRef.current = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingId) return;
    draggedRef.current = true;
    const proposed = clientXToTime(e.clientX);
    onRetime(draggingId, clampKeyframeTime(keyframes, draggingId, proposed, duration));
  };

  const handlePointerUp = () => setDraggingId(null);
  const handlePointerCancel = () => setDraggingId(null);

  return (
    <div className="kf-timeline">
      <div
        className="kf-track"
        ref={trackRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <div className="kf-playhead" style={{ left: `${pct(currentTime)}%` }} />
        {keyframes.map(k => (
          <div
            key={k.id}
            className={`kf-marker${k.id === selectedId ? ' selected' : ''}`}
            style={{ left: `${pct(k.time)}%` }}
            onPointerDown={handlePointerDown(k.id)}
            onLostPointerCapture={handlePointerUp}
            onClick={e => {
              e.stopPropagation();
              if (draggedRef.current) { draggedRef.current = false; return; }
              onSelect(k.id === selectedId ? null : k.id);
            }}
            title={`${k.time.toFixed(2)}s`}
          />
        ))}
      </div>
      {selectedId && (
        <button className="btn-brut kf-delete-btn" onClick={() => onDelete(selectedId)}>
          <X size={12} />
          <span>DELETE KEYFRAME</span>
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Manual verification**

This component isn't wired into `App.tsx` until Task 8 — nothing to run yet. Verify it compiles:

Run: `npx tsc -b --noEmit`
Expected: no new type errors from `src/KeyframeTimeline.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/KeyframeTimeline.tsx
git commit -m "feat: add KeyframeTimeline component"
```

---

## Task 8: Wire keyframes into `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Imports and new state**

In `src/App.tsx`, update the top imports:

```tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { Video, Camera, Upload, Play, Pause, Loader2, RotateCcw, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BlobTracker } from './BlobTracker';
import type { TrackerParams, RenderMode } from './BlobTracker';
import { resolveActiveParams, clampExportPreviewSize } from './keyframes';
import type { Keyframe } from './keyframes';
import { KeyframeTimeline } from './KeyframeTimeline';
import './index.css';
```

Inside `App()`, after the existing `isEncoding` state (around line 53), add:

```tsx
  // Keyframe state
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
```

- [ ] **Step 2: Track `currentTime`/`duration`, keep `selectedKeyframeId` valid**

In the "Video lifecycle" `useEffect` (around line 70-91), extend `onMeta` and add a `timeupdate` listener:

```tsx
    const onMeta  = () => {
      if (vid.videoWidth && vid.videoHeight) {
        setExportRes({ w: vid.videoWidth, h: vid.videoHeight });
      }
      setDuration(vid.duration || 0);
      trackerRef.current?.stop();
      trackerRef.current = new BlobTracker(vid, cv, params);
    };
    const onPlay  = () => { trackerRef.current?.start(); setIsPaused(false); };
    const onPause = () => { trackerRef.current?.stop();  setIsPaused(true);  };
    const onTime  = () => setCurrentTime(vid.currentTime);
    vid.addEventListener('loadedmetadata', onMeta);
    vid.addEventListener('play',  onPlay);
    vid.addEventListener('pause', onPause);
    vid.addEventListener('timeupdate', onTime);
    return () => {
      vid.removeEventListener('loadedmetadata', onMeta);
      vid.removeEventListener('play',  onPlay);
      vid.removeEventListener('pause', onPause);
      vid.removeEventListener('timeupdate', onTime);
    };
```

Add a new effect below the existing `useEffect(() => { trackerRef.current?.updateParams(params); }, [params]);` (line 102) that keeps the selection valid and wires the resolver:

```tsx
  // Keep selection valid when keyframes are deleted; auto-select newest on add
  useEffect(() => {
    if (keyframes.length === 0) { setSelectedKeyframeId(null); return; }
    if (!keyframes.some(k => k.id === selectedKeyframeId)) {
      const sorted = [...keyframes].sort((a, b) => a.time - b.time);
      setSelectedKeyframeId(sorted[sorted.length - 1].id);
    }
  }, [keyframes, selectedKeyframeId]);

  // Drive live preview + export from keyframes (or fall back to static params)
  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    if (keyframes.length === 0) {
      tracker.setLiveParamsResolver(null);
    } else {
      tracker.setLiveParamsResolver((t) => resolveActiveParams(keyframes, t, params));
    }
  }, [keyframes, params, videoSrc]);
```

- [ ] **Step 3: `displayParams` — what the panel edits**

Right after `const setParam = ...` (line 104-105), add:

```tsx
  const displayParams: TrackerParams = selectedKeyframeId
    ? (keyframes.find(k => k.id === selectedKeyframeId)?.params ?? params)
    : params;

  const setDisplayParam = (k: keyof TrackerParams, v: any) => {
    const coerced = typeof v === 'string' && !isNaN(+v) ? +v : v;
    if (selectedKeyframeId) {
      setKeyframes(kfs => kfs.map(kf =>
        kf.id === selectedKeyframeId ? { ...kf, params: { ...kf.params, [k]: coerced } } : kf
      ));
    } else {
      setParam(k, v);
    }
  };
```

- [ ] **Step 4: Add/select/delete/retime handlers**

Add below `setDisplayParam`:

```tsx
  const addKeyframe = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const activeParams = keyframes.length > 0
      ? resolveActiveParams(keyframes, vid.currentTime, params)
      : params;
    const newKf: Keyframe = {
      id: `kf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      time: vid.currentTime,
      params: activeParams,
    };
    setKeyframes(kfs => [...kfs, newKf]);
    setSelectedKeyframeId(newKf.id);
  };

  const deleteKeyframe = (id: string) => {
    setKeyframes(kfs => kfs.filter(k => k.id !== id));
  };

  const retimeKeyframe = (id: string, time: number) => {
    setKeyframes(kfs => kfs.map(k => (k.id === id ? { ...k, time } : k)));
  };

  const restart = () => {
    if (videoRef.current) videoRef.current.currentTime = 0;
  };
```

- [ ] **Step 5: Replace `params.` references in JSX with `displayParams.`/`setDisplayParam`**

In the JSX (RENDER MODE, MOTION DETECTION, DENSITY, VISUAL, LABELS sections, roughly lines 310-364), replace every `params.<field>` with `displayParams.<field>` and every `setParam(` with `setDisplayParam(`. Do **not** change the EXPORT section (`exportRes`, `snapshot`, `exportSVG`, `toggleRecord` — those stay driven by global state, not per-keyframe) or the SOURCE section.

Example (RENDER MODE section, was):

```tsx
                <Section label="RENDER MODE">
                  <div className="mode-grid">
                    {MODES.map(m => (
                      <button key={m.id} className={`mode-btn${params.renderMode === m.id ? ' active' : ''}`}
                        onClick={() => setParam('renderMode', m.id)}>{m.label}</button>
                    ))}
                  </div>
                  {params.renderMode === 'ASCII_BOX' && (
                    <BrutSlider label="ASCII CONTRAST" value={params.asciiContrast} min={0.3} max={4} step={0.1} onChange={v => setParam('asciiContrast', v)} />
                  )}
                </Section>
```

becomes:

```tsx
                <Section label="RENDER MODE">
                  <div className="mode-grid">
                    {MODES.map(m => (
                      <button key={m.id} className={`mode-btn${displayParams.renderMode === m.id ? ' active' : ''}`}
                        onClick={() => setDisplayParam('renderMode', m.id)}>{m.label}</button>
                    ))}
                  </div>
                  {displayParams.renderMode === 'ASCII_BOX' && (
                    <BrutSlider label="ASCII CONTRAST" value={displayParams.asciiContrast} min={0.3} max={4} step={0.1} onChange={v => setDisplayParam('asciiContrast', v)} />
                  )}
                </Section>
```

Apply the same mechanical substitution through MOTION DETECTION, DENSITY, VISUAL, and LABELS sections (every `params.X` → `displayParams.X`, every `setParam(` → `setDisplayParam(`).

- [ ] **Step 6: Add the KEYFRAMES panel section**

Immediately after the LABELS `</Section>` and before the `{/* ── EXPORT ── */}` comment, add:

```tsx
                <Section label="KEYFRAMES">
                  <KeyframeTimeline
                    keyframes={keyframes}
                    selectedId={selectedKeyframeId}
                    currentTime={currentTime}
                    duration={duration}
                    onSelect={setSelectedKeyframeId}
                    onDelete={deleteKeyframe}
                    onRetime={retimeKeyframe}
                  />
                  <button className="btn-brut flex-1 mt-8" onClick={addKeyframe}>
                    <Plus size={13} />
                    <span>ADD KEYFRAME AT {fmtTime(Math.floor(currentTime))}</span>
                  </button>
                  <div className="hint-text">
                    {keyframes.length === 0
                      ? 'No keyframes — export uses the static settings above.'
                      : `${keyframes.length} keyframe${keyframes.length > 1 ? 's' : ''} — play/pause to position, drag markers to retime.`}
                  </div>
                </Section>
```

- [ ] **Step 7: RESTART button in SOURCE section**

In the SOURCE section (around line 293-306), update:

```tsx
            <Section label="SOURCE">
              <div className="row gap-8">
                <label className="btn-brut flex-1">
                  <Upload size={13} />
                  <span>{videoSrc ? 'CHANGE VIDEO' : 'LOAD VIDEO'}</span>
                  <input type="file" accept="video/*" style={{ display: 'none' }} onChange={handleUpload} />
                </label>
                {videoSrc && (
                  <button className="btn-brut icon-btn" onClick={togglePlay}>
                    {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
                  </button>
                )}
                {videoSrc && (
                  <button className="btn-brut icon-btn" onClick={restart} title="Restart">
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            </Section>
```

- [ ] **Step 8: Canvas transport overlay**

In the RENDER section, right after the `<canvas ... />` element (around line 273-277), add an overlay bar that's independent of `showUI`:

```tsx
      <canvas
        ref={canvasRef}
        className={`main-canvas ${isRecording ? 'recording' : ''}`}
        onClick={togglePlay}
      />

      {videoSrc && !isRecording && !isEncoding && (
        <div className="transport-overlay">
          <button className="btn-brut icon-btn" onClick={togglePlay}>
            {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
          </button>
          <button className="btn-brut icon-btn" onClick={restart} title="Restart">
            <RotateCcw size={14} />
          </button>
        </div>
      )}
```

- [ ] **Step 9: Adaptive export-preview sizing**

Size is currently driven purely by the `.recording` CSS class (fixed 320px). Switch to an inline style computed from `exportRes` while recording (CSS-side fixed size is removed in Task 9). Before `return (` (line 270), add:

```tsx
  const previewSize = isRecording ? clampExportPreviewSize(exportRes.w, exportRes.h, window.innerWidth, window.innerHeight) : null;
```

Update the canvas element from Step 8 to:

```tsx
      <canvas
        ref={canvasRef}
        className={`main-canvas ${isRecording ? 'recording' : ''}`}
        style={previewSize ? { width: previewSize.w, height: previewSize.h } : undefined}
        onClick={togglePlay}
      />
```

- [ ] **Step 10: Type-check**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire keyframes, transport controls, and adaptive export preview into App"
```

---

## Task 9: CSS for transport overlay, keyframe timeline, and export preview

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Update `.main-canvas.recording`**

Replace the fixed size in `.main-canvas.recording` (drop the hardcoded `width`/`height` since Task 8 now sets them inline; keep everything else):

```css
.main-canvas.recording {
  height: auto !important;
  position: fixed !important;
  bottom: 20px !important;
  right: 20px !important;
  left: auto !important;
  top: auto !important;
  transform: none !important;
  border: 4px solid var(--accent);
  box-shadow: 0 10px 40px rgba(0,0,0,0.8);
  z-index: 10000;
  pointer-events: none; /* Don't block UI */
}
```

- [ ] **Step 2: Add transport overlay styles**

Append:

```css
/* ─── TRANSPORT OVERLAY ─────────────────────────────────────────────────── */
.transport-overlay {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  z-index: 100;
}
```

- [ ] **Step 3: Add keyframe timeline styles**

Append:

```css
/* ─── KEYFRAME TIMELINE ─────────────────────────────────────────────────── */
.kf-timeline { display: flex; flex-direction: column; gap: 6px; }
.kf-track {
  position: relative;
  height: 28px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  cursor: default;
}
.kf-playhead {
  position: absolute;
  top: 0; bottom: 0;
  width: 2px;
  background: var(--text-mid);
  pointer-events: none;
}
.kf-marker {
  position: absolute;
  top: 50%; left: 0;
  width: 10px; height: 10px;
  transform: translate(-50%, -50%) rotate(45deg);
  background: var(--text-hi);
  border: 1px solid var(--bg);
  cursor: grab;
}
.kf-marker.selected { background: var(--accent); }
.kf-marker:active { cursor: grabbing; }
.kf-delete-btn { color: var(--accent); border-color: var(--accent); }
```

- [ ] **Step 4: Manual verification**

Run: `npm run dev`.
1. Load a video. Confirm play/pause + restart icons appear centered under the canvas (transport overlay), and clicking restart jumps back to frame 0.
2. Open the panel, scroll to KEYFRAMES section. Click "ADD KEYFRAME" a couple times at different playback positions (play, pause, add) — confirm diamond markers appear at proportional positions on the timeline track.
3. Click a marker — confirm it highlights (accent color) and the sliders above (RENDER MODE, MOTION DETECTION, etc.) update to show that keyframe's stored values; edit a slider and confirm only that keyframe's marker's stored value changes (re-select another keyframe to confirm its values are untouched).
4. Drag a marker along the track — confirm it moves and doesn't cross closer than the minimum gap to its neighbor.
5. With 2+ keyframes at different render modes/colors, hit play — confirm the on-screen render visually morphs (interpolated colors/sliders) and hard-cuts render mode partway between the two keyframe timestamps.
6. Click DELETE KEYFRAME on the selected marker — confirm it's removed and selection falls back to another keyframe (or panel returns to global editing if none remain).
7. Start an MP4 export (RECORD MP4) with 2+ keyframes set — confirm the on-screen preview box is reasonably sized (not a tiny 320px square, not covering the whole screen) and, after export finishes, play the downloaded MP4 and confirm it shows the same interpolated look as the live preview did.

Expected: all of the above behave as described, no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.css
git commit -m "style: add transport overlay and keyframe timeline styles"
```

---

## Task 10: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Build check**

Run: `npm run build`
Expected: TypeScript + Vite build succeed with no errors.

- [ ] **Step 2: Lint check**

Run: `npm run lint`
Expected: no new lint errors introduced by this change (pre-existing warnings, if any, are out of scope).

- [ ] **Step 3: Full unit test suite**

Run: `npx vitest run`
Expected: all `keyframes.test.ts` tests pass (16 tests from Tasks 2-4).

- [ ] **Step 4: Manual regression — zero-keyframe path unchanged**

Run: `npm run dev`. Load a video, do **not** add any keyframes. Confirm every existing control (render mode, sliders, colors, toggles, PNG/SVG export, MP4 record) behaves exactly as before this change — this is the critical regression check, since `displayParams`/`setDisplayParam` must be transparent pass-throughs to `params`/`setParam` when `keyframes.length === 0`.

Expected: identical to pre-change behavior.

- [ ] **Step 5: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "chore: final regression fixes for keyframe export system"
```

(Skip this commit if Steps 1-4 required no changes.)
