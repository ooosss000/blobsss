# Color Grading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a color-grading control section (brightness, contrast, saturation, hue, gamma, temperature) that changes how the loaded video looks on screen, with an "apply to export" toggle, without ever affecting motion-detection accuracy.

**Architecture:** Six new numeric `TrackerParams` fields plus one boolean, so grading is keyframable for free through the existing interpolation system (`src/keyframes.ts`) with zero new plumbing beyond categorizing the fields. Applied entirely via `ctx.filter` on the main canvas draw (`BlobTracker.drawVideoFrame()`) — brightness/contrast/saturation/hue map to native CSS filter functions; gamma and temperature (not native CSS filter primitives) use two small SVG filters (`feComponentTransfer`/`feColorMatrix`) defined once in `App.tsx`'s JSX and referenced via `url(#id)` in the same filter string, with their attributes updated imperatively by `BlobTracker` each frame. The separate low-res proxy canvas that motion detection reads is never touched, so grading can never change what gets tracked.

**Tech Stack:** React + TypeScript + Vite, Canvas 2D `ctx.filter` + inline SVG filter primitives (no WebGL, no per-pixel JS loops).

---

## Task 1: Add grading fields to `TrackerParams` and the keyframe system

**Files:**
- Modify: `src/BlobTracker.ts` (`TrackerParams` interface)
- Modify: `src/App.tsx` (`DEFAULT_PARAMS`)
- Modify: `src/keyframes.ts` (`NUMERIC_KEYS`/`DISCRETE_KEYS`)
- Test: `src/keyframes.test.ts`

- [ ] **Step 1: Add the 7 new fields to `TrackerParams`**

In `src/BlobTracker.ts`, find:

```ts
export interface TrackerParams {
  // Motion detection
  diffThreshold: number;
  minArea: number;
  maxArea: number;
  maxBlobs: number;
  lifeFrames: number;
  jitter: number;
  maxBlobDim: number;     // Max width OR height of a blob in proxy-pixels (caps blob size)
  // Density
  subdivide: number;       // split each detected blob into NxN sub-boxes (1=off, 2=4 boxes, 3=9, etc.)
  // Visual
  renderMode: RenderMode;
  neighborLinks: number;
  strokeColor: string;
  textColor: string;
  strokeWidth: number;
  fontSize: number;
  fontFamily: string;
```

Replace with:

```ts
export interface TrackerParams {
  // Motion detection
  diffThreshold: number;
  minArea: number;
  maxArea: number;
  maxBlobs: number;
  lifeFrames: number;
  jitter: number;
  maxBlobDim: number;     // Max width OR height of a blob in proxy-pixels (caps blob size)
  // Density
  subdivide: number;       // split each detected blob into NxN sub-boxes (1=off, 2=4 boxes, 3=9, etc.)
  // Color grading — visual only, never affects the motion-detection proxy
  brightness: number;      // CSS brightness() multiplier, 1 = neutral
  contrast: number;        // CSS contrast() multiplier, 1 = neutral
  saturation: number;      // CSS saturate() multiplier, 1 = neutral
  hue: number;             // CSS hue-rotate() degrees, 0 = neutral
  gamma: number;           // SVG feComponentTransfer gamma, 1 = neutral (exponent = 1/gamma)
  temperature: number;     // warm(+)/cool(-) R/B channel shift via SVG feColorMatrix, 0 = neutral
  gradeExport: boolean;    // if false, MP4 export ignores grading regardless of preview
  // Visual
  renderMode: RenderMode;
  neighborLinks: number;
  strokeColor: string;
  textColor: string;
  strokeWidth: number;
  fontSize: number;
  fontFamily: string;
```

- [ ] **Step 2: Add defaults**

In `src/App.tsx`, find:

```ts
const DEFAULT_PARAMS: TrackerParams = {
  diffThreshold: 19, // Sensitivity 62 on the inverted UI scale
  minArea: 100,
  maxArea: 9000,
  maxBlobs: 100,
  lifeFrames: 18,
  jitter: 0,
  maxBlobDim: 320,
  subdivide: 1,
  renderMode: 'BOX_INVERT',
```

Replace with:

```ts
const DEFAULT_PARAMS: TrackerParams = {
  diffThreshold: 19, // Sensitivity 62 on the inverted UI scale
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
  gradeExport: false,
  renderMode: 'BOX_INVERT',
```

- [ ] **Step 3: Write the failing tests**

Add to `src/keyframes.test.ts`, inside the existing `baseParams` object literal near the top of the file (find it — it's a `TrackerParams` object used by the `kf()` helper), add the 7 new fields so it still satisfies the `TrackerParams` type. Find:

```ts
  jitter: 0,
  maxBlobDim: 320,
  subdivide: 1,
  renderMode: 'BOX_INVERT',
```

Replace with:

```ts
  jitter: 0,
  maxBlobDim: 320,
  subdivide: 1,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  gamma: 1,
  temperature: 0,
  gradeExport: false,
  renderMode: 'BOX_INVERT',
```

Then add a new test at the end of the `describe('resolveActiveParams', ...)` block (find its closing `});` and add before it):

```ts

  it('interpolates the new color-grading numeric fields and hard-switches gradeExport', () => {
    const a = kf('a', 0, { brightness: 1, gamma: 1, temperature: 0, gradeExport: false });
    const b = kf('b', 10, { brightness: 1.5, gamma: 2, temperature: 1, gradeExport: true });
    const before = resolveActiveParams([a, b], 4, baseParams);
    const after = resolveActiveParams([a, b], 6, baseParams);
    expect(resolveActiveParams([a, b], 5, baseParams).brightness).toBeCloseTo(1.25, 5);
    expect(resolveActiveParams([a, b], 5, baseParams).gamma).toBeCloseTo(1.5, 5);
    expect(resolveActiveParams([a, b], 5, baseParams).temperature).toBeCloseTo(0.5, 5);
    expect(before.gradeExport).toBe(false);
    expect(after.gradeExport).toBe(true);
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/keyframes.test.ts`
Expected: FAIL — the new fields aren't categorized in `NUMERIC_KEYS`/`DISCRETE_KEYS` yet, so `brightness`/`gamma`/`temperature` won't interpolate (they'll just hold `kPrev`'s value) and the `toBeCloseTo` assertions will fail.

- [ ] **Step 5: Categorize the new fields**

In `src/keyframes.ts`, find:

```ts
const NUMERIC_KEYS = [
  'diffThreshold', 'minArea', 'maxArea', 'maxBlobs', 'lifeFrames',
  'jitter', 'maxBlobDim', 'strokeWidth', 'fontSize', 'asciiContrast',
] as const satisfies readonly (keyof TrackerParams)[];

const COLOR_KEYS = ['strokeColor', 'textColor'] as const satisfies readonly (keyof TrackerParams)[];

const DISCRETE_KEYS = [
  'subdivide', 'renderMode', 'neighborLinks', 'fontFamily',
  'showCoordinates', 'showId', 'showSize', 'showLabelBG',
] as const satisfies readonly (keyof TrackerParams)[];
```

Replace with:

```ts
const NUMERIC_KEYS = [
  'diffThreshold', 'minArea', 'maxArea', 'maxBlobs', 'lifeFrames',
  'jitter', 'maxBlobDim', 'strokeWidth', 'fontSize', 'asciiContrast',
  'brightness', 'contrast', 'saturation', 'hue', 'gamma', 'temperature',
] as const satisfies readonly (keyof TrackerParams)[];

const COLOR_KEYS = ['strokeColor', 'textColor'] as const satisfies readonly (keyof TrackerParams)[];

const DISCRETE_KEYS = [
  'subdivide', 'renderMode', 'neighborLinks', 'fontFamily',
  'showCoordinates', 'showId', 'showSize', 'showLabelBG', 'gradeExport',
] as const satisfies readonly (keyof TrackerParams)[];
```

- [ ] **Step 5a: Add a compile-time exhaustiveness guard**

`as const satisfies readonly (keyof TrackerParams)[]` only checks that listed
keys are *valid* — it does not catch a `TrackerParams` field that's missing
from all three arrays (which would then silently never interpolate/switch,
with no test or compile failure). Add a guard so this can't regress, in this
task or any future param addition. Right after the three const declarations
above, add:

```ts
type _UncategorizedParamKeys = Exclude<
  keyof TrackerParams,
  typeof NUMERIC_KEYS[number] | typeof COLOR_KEYS[number] | typeof DISCRETE_KEYS[number]
>;
// If this errors, a TrackerParams field exists that isn't in any of the
// three categorization arrays above — it would silently fail to
// interpolate/hard-switch. Add it to the correct array.
const _exhaustiveParamCheck: _UncategorizedParamKeys extends never ? true : ['uncategorized TrackerParams keys:', _UncategorizedParamKeys] = true;
void _exhaustiveParamCheck;
```

Sanity-check both directions once (don't leave the broken state committed):
temporarily remove one key (e.g. `'contrast'`) from `NUMERIC_KEYS`, run
`npx tsc -b --noEmit`, confirm it now errors naming that key as
uncategorized, then put it back and confirm `tsc` is clean again.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/keyframes.test.ts`
Expected: PASS — full file green (27 tests: 26 existing + 1 new).

- [ ] **Step 7: Verify it compiles and builds**

Run: `npx tsc -b --noEmit`
Expected: no errors (every other `TrackerParams` object literal in the codebase — `DEFAULT_PARAMS`, the test file's `baseParams`, and any place that constructs a full params object — must have all fields; if `tsc` reports a missing-property error anywhere, that call site needs the same 7 fields added).

Run: `npm run build`
Expected: clean build, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/BlobTracker.ts src/App.tsx src/keyframes.ts src/keyframes.test.ts
git commit -m "feat: add color-grading fields to TrackerParams and keyframe system"
```

---

## Task 2: SVG filter defs, `BlobTracker` wiring, and export gating

**Files:**
- Modify: `src/App.tsx` (hidden SVG filter defs in JSX, wire `isRecording` → `setExporting`)
- Modify: `src/BlobTracker.ts` (constructor wiring, `buildGradingFilter()` method, `isExporting` field + setter)

**Why SVG filters for gamma/temperature specifically:** CSS `ctx.filter` natively supports `brightness()`/`contrast()`/`saturate()`/`hue-rotate()`, but has no native gamma or channel-tint (temperature) primitive. Rather than a per-pixel JS loop (`getImageData`/`putImageData`, which would be a real per-frame cost, especially at 4K export resolution), this uses two tiny SVG filters referenced via `url(#id)` inside the same `ctx.filter` string — still fully GPU-composited by the browser, no JS pixel math. The SVG filter defs are owned by `App.tsx` (mounted once, permanently, never recreated) rather than by `BlobTracker` itself, because a new `BlobTracker` instance is constructed every time a video loads (`onMeta` in `App.tsx`) — if the SVG elements were created inside `BlobTracker`'s constructor, every video load would leak another copy into the DOM.

- [ ] **Step 1: Add the hidden SVG filter defs**

In `src/App.tsx`, find:

```tsx
  return (
    <div className="app-root">
      <video ref={videoRef} src={videoSrc || undefined} loop playsInline style={{ display: 'none' }} />
      <canvas
```

Replace with:

```tsx
  return (
    <div className="app-root">
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <filter id="bs-gamma-filter" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncR id="bs-gamma-r" type="gamma" amplitude="1" exponent="1" offset="0" />
              <feFuncG id="bs-gamma-g" type="gamma" amplitude="1" exponent="1" offset="0" />
              <feFuncB id="bs-gamma-b" type="gamma" amplitude="1" exponent="1" offset="0" />
            </feComponentTransfer>
          </filter>
          <filter id="bs-temp-filter" colorInterpolationFilters="sRGB">
            <feColorMatrix id="bs-temp-matrix" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
          </filter>
        </defs>
      </svg>
      <video ref={videoRef} src={videoSrc || undefined} loop playsInline style={{ display: 'none' }} />
      <canvas
```

- [ ] **Step 2: Add private fields and wiring in `BlobTracker`'s constructor**

In `src/BlobTracker.ts`, find the constructor (search for `constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, params: TrackerParams) {`) and find these lines near its start:

```ts
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
```

Replace with:

```ts
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.gammaFuncR = document.getElementById('bs-gamma-r') as SVGFEFuncRElement | null;
    this.gammaFuncG = document.getElementById('bs-gamma-g') as SVGFEFuncGElement | null;
    this.gammaFuncB = document.getElementById('bs-gamma-b') as SVGFEFuncBElement | null;
    this.tempMatrix = document.getElementById('bs-temp-matrix') as SVGFEColorMatrixElement | null;
    if (!this.gammaFuncR || !this.gammaFuncG || !this.gammaFuncB || !this.tempMatrix) {
      console.warn('BlobTracker: color-grading SVG filter elements not found in DOM — gamma/temperature grading will be unavailable.');
    }
```

Then, find the class field declarations near `private lastFrameTime = 0;` and add below it:

```ts
  private lastFrameTime = 0;
  private gammaFuncR: SVGFEFuncRElement | null;
  private gammaFuncG: SVGFEFuncGElement | null;
  private gammaFuncB: SVGFEFuncBElement | null;
  private tempMatrix: SVGFEColorMatrixElement | null;
```

(Only the `private lastFrameTime = 0;` line already exists — add the 4 new lines after it. The fields are nullable because `getElementById` can theoretically return `null`; every use of them below is null-safe via `?.`.)

- [ ] **Step 3: Add the `isExporting` field and public setter**

In `src/BlobTracker.ts`, find `public setLiveParamsResolver(fn: ((time: number) => TrackerParams) | null) {` and its closing `}`:

```ts
  public setLiveParamsResolver(fn: ((time: number) => TrackerParams) | null) {
    this.liveParamsResolver = fn;
    if (!fn) this.params = this.baseParams;
  }
```

Add a new method right after it:

```ts
  public setLiveParamsResolver(fn: ((time: number) => TrackerParams) | null) {
    this.liveParamsResolver = fn;
    if (!fn) this.params = this.baseParams;
  }

  /**
   * Marks whether the current frame is being captured for MP4 export.
   * Used only to decide whether color grading applies (see `gradeExport`
   * param) — export always uses the same canvas/resolution pipeline as
   * preview regardless of this flag.
   */
  public setExporting(exporting: boolean) {
    this.isExporting = exporting;
  }
```

Then find the private field `private liveParamsResolver: ((time: number) => TrackerParams) | null = null;` and add below it:

```ts
  private liveParamsResolver: ((time: number) => TrackerParams) | null = null;
  private isExporting = false;
```

- [ ] **Step 4: Add the `buildGradingFilter()` method and wire it into `drawVideoFrame()`**

In `src/BlobTracker.ts`, find `private drawVideoFrame() {` and the method's closing `}` right before `private processFrame() {`:

```ts
  private drawVideoFrame() {
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    const isMonoMode = (this.params.renderMode === 'TRAIL_PATH' || this.params.renderMode === 'ASCII_BOX');
    this.ctx.filter = isMonoMode ? 'grayscale(100%) brightness(1.0) contrast(1.5)' : 'none';
    this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    this.ctx.filter = 'none';

    // Set smoothing to false for sharp brutalist graphics/text
    this.ctx.imageSmoothingEnabled = false;
  }

  private processFrame() {
```

Replace with:

```ts
  /**
   * Composes the ctx.filter string for color grading (brightness/contrast/
   * saturation/hue via native CSS filter functions, gamma/temperature via
   * the SVG filters defined in App.tsx's JSX, referenced by url(#id)).
   * Updates the SVG filter primitives' attributes imperatively so this
   * stays in sync with per-frame keyframe-resolved params, not just
   * React's render cycle. Visual only — never applied to the proxy canvas
   * that motion detection reads.
   */
  private buildGradingFilter(): string {
    const p = this.params;
    const parts: string[] = [];
    if (p.brightness !== 1) parts.push(`brightness(${p.brightness})`);
    if (p.contrast !== 1) parts.push(`contrast(${p.contrast})`);
    if (p.saturation !== 1) parts.push(`saturate(${p.saturation})`);
    if (p.hue !== 0) parts.push(`hue-rotate(${p.hue}deg)`);
    if (p.gamma !== 1 && this.gammaFuncR && this.gammaFuncG && this.gammaFuncB) {
      const gammaExponent = String(1 / Math.max(0.01, p.gamma));
      this.gammaFuncR.setAttribute('exponent', gammaExponent);
      this.gammaFuncG.setAttribute('exponent', gammaExponent);
      this.gammaFuncB.setAttribute('exponent', gammaExponent);
      parts.push('url(#bs-gamma-filter)');
    }
    if (p.temperature !== 0 && this.tempMatrix) {
      const k = 0.3;
      const rGain = (1 + p.temperature * k).toFixed(3);
      const bGain = (1 - p.temperature * k).toFixed(3);
      this.tempMatrix.setAttribute('values', `${rGain} 0 0 0 0  0 1 0 0 0  0 0 ${bGain} 0 0  0 0 0 1 0`);
      parts.push('url(#bs-temp-filter)');
    }
    return parts.join(' ');
  }

  private drawVideoFrame() {
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    // Mono modes (TRAIL_PATH/ASCII_BOX) intentionally force grayscale AFTER
    // grading, so hue/saturation/temperature are flattened away in those
    // modes by design — brightness/contrast/gamma still meaningfully affect
    // the resulting mono look. This is deliberate, not a bug to "fix" later.
    const isMonoMode = (this.params.renderMode === 'TRAIL_PATH' || this.params.renderMode === 'ASCII_BOX');
    const grading = (this.isExporting && !this.params.gradeExport) ? '' : this.buildGradingFilter();
    const mono = isMonoMode ? 'grayscale(100%) brightness(1.0) contrast(1.5)' : '';
    this.ctx.filter = [grading, mono].filter(Boolean).join(' ') || 'none';
    this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    this.ctx.filter = 'none';

    // Set smoothing to false for sharp brutalist graphics/text
    this.ctx.imageSmoothingEnabled = false;
  }

  private processFrame() {
```

- [ ] **Step 5: Call `setExporting()` synchronously in `startRecording`/`stopRecording`**

**Not a React effect** — a React effect watching `isRecording` has a real timing gap: passive-effect flushing isn't guaranteed to land before the capture loop's first `requestAnimationFrame`, so with the default `gradeExport: false` the first 1-3 encoded frames of every recording could carry grading anyway (a brief graded flash at the head of the exported MP4), and symmetrically at the end the flag would flip before the canvas is actually resized back. Instead, call `setExporting()` synchronously, adjacent to the `resize()` calls that already bracket the export.

In `src/App.tsx`, find in `startRecording`:

```tsx
    // Resize canvas to export resolution
    tracker.resize(exportRes.w, exportRes.h, true);
```

Replace with:

```tsx
    // Resize canvas to export resolution
    tracker.setExporting(true);
    tracker.resize(exportRes.w, exportRes.h, true);
```

In `stopRecording`, find:

```tsx
    encoderRef.current = null;
    muxerRef.current = null;
    frameCountRef.current = 0;
    setIsRecording(false);
    setIsEncoding(false);
```

Replace with:

```tsx
    encoderRef.current = null;
    muxerRef.current = null;
    frameCountRef.current = 0;
    trackerRef.current?.setExporting(false);
    setIsRecording(false);
    setIsEncoding(false);
```

- [ ] **Step 6: Verify it compiles and builds**

Run: `npx tsc -b --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: clean build.

Run: `npx vitest run`
Expected: 27/27 `keyframes.test.ts` tests pass (unaffected by this task, just a regression check).

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/BlobTracker.ts
git commit -m "feat: apply color grading via canvas filter, gated on export toggle"
```

---

## Task 3: COLOR GRADE panel section

**Files:**
- Modify: `src/App.tsx` (new panel section)

- [ ] **Step 1: Add the section**

In `src/App.tsx`, find the end of the `VISUAL` section and the start of `LABELS`:

```tsx
                    </select>
                  </div>
                </Section>

                <Section label="LABELS">
```

Replace with:

```tsx
                    </select>
                  </div>
                </Section>

                <Section label="COLOR GRADE">
                  <Row2>
                    <BrutSlider label="BRIGHTNESS" value={displayParams.brightness} min={0} max={2} step={0.05} onChange={v => setDisplayParam('brightness', v)} />
                    <BrutSlider label="CONTRAST" value={displayParams.contrast} min={0} max={2} step={0.05} onChange={v => setDisplayParam('contrast', v)} />
                  </Row2>
                  <Row2>
                    <BrutSlider label="SATURATION" value={displayParams.saturation} min={0} max={2} step={0.05} onChange={v => setDisplayParam('saturation', v)} />
                    <BrutSlider label="HUE" value={displayParams.hue} min={-180} max={180} step={1} onChange={v => setDisplayParam('hue', v)} />
                  </Row2>
                  <Row2>
                    <BrutSlider label="GAMMA" value={displayParams.gamma} min={0.2} max={3} step={0.05} onChange={v => setDisplayParam('gamma', v)} />
                    <BrutSlider label="TEMPERATURE" value={displayParams.temperature} min={-1} max={1} step={0.05} onChange={v => setDisplayParam('temperature', v)} />
                  </Row2>
                  <div className="toggle-row"><span>APPLY TO EXPORT</span><BrutToggle value={displayParams.gradeExport} onChange={v => setDisplayParam('gradeExport', v)} /></div>
                </Section>

                <Section label="LABELS">
```

- [ ] **Step 2: Verify it compiles and builds**

Run: `npx tsc -b --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add COLOR GRADE panel section"
```

---

## Task 4: Regression pass

**Files:** none (verification only)

- [ ] **Step 1: Build check**

Run: `npm run build`
Expected: clean.

- [ ] **Step 2: Lint check**

Run: `npx eslint src/App.tsx src/BlobTracker.ts src/keyframes.ts 2>&1 | tail -30`
Expected: no new errors beyond the pre-existing baseline (19 errors as of the last feature branch — compare against that; flag only genuinely new ones).

- [ ] **Step 3: Unit test suite**

Run: `npx vitest run`
Expected: 27/27 `keyframes.test.ts` tests pass.

- [ ] **Step 4: Static/code-level regression check (no browser automation)**

1. Confirm every `TrackerParams` object literal in the codebase (grep for `renderMode:` as a proxy for "this is a full params object") has all 7 new fields — `tsc` should already catch any miss, but double-check by reading.
2. Confirm `drawVideoFrame()`'s grading filter is applied ONLY there — grep for `getContext\('2d'\)` and any other `drawImage(this.video` call in the file to confirm the proxy-canvas draw (used for motion detection) does NOT call `buildGradingFilter()` or set `ctx.filter` to anything grading-related.
3. Confirm the SVG filter defs render with `width="0" height="0"` and `position: absolute` so they never affect layout.
4. Grep for TODO/FIXME/console.log introduced by this branch's commits.
5. Confirm `git diff main...HEAD --stat` shows only the expected files (`src/App.tsx`, `src/BlobTracker.ts`, `src/keyframes.ts`, `src/keyframes.test.ts`).

- [ ] **Step 5: Manual visual verification (requires a human — no browser automation in this environment)**

Run `npm run dev`, load a video, and check:
1. Open the new COLOR GRADE section — confirm all 6 sliders and the toggle appear, in the panel between VISUAL and LABELS.
2. Move BRIGHTNESS/CONTRAST/SATURATION/HUE — confirm the video visibly changes.
3. Move GAMMA and TEMPERATURE — confirm the video visibly changes (a shift in midtone brightness for gamma, a warm/cool tint for temperature). This is the part most likely to have a real-world browser-compat gap — if these two sliders do nothing while the other four work, that's the SVG `url()` filter reference not being supported in the current browser; note which browser you tested in.
4. Confirm blob tracking behavior (what gets detected/boxed) does NOT change as you move any grading slider — load a clip, note how many blobs are tracked, crank contrast/brightness to extremes, confirm the same blobs are still tracked the same way.
5. Turn APPLY GRADE TO MP4 off, record a short MP4 with grading dialed to an extreme (e.g. very high contrast + strong hue shift) — confirm the exported file looks like the UNGRADED video, not what the live preview showed.
6. Turn APPLY GRADE TO MP4 on (the default), record again with the same extreme grading — confirm the exported file now matches what the live preview showed.
7. **Corrected in final review — PNG and SVG behave differently, not identically:** PNG (Export PNG) always bakes in whatever grading is currently on screen, since it's a direct `canvas.toDataURL()` snapshot and the export flag is never active during a snapshot. SVG (Export SVG) never includes the video raster at all — it's pure vector blob overlays — so grading is structurally inapplicable to it, not "unwired." Confirm both match this description; if PNG behaves any other way, that's a real bug worth reporting.
8. **Known limitation, found in Task 2's code review, not fixed on this branch:** since one canvas serves both MP4 capture and the on-screen preview, the live preview also loses grading while `APPLY GRADE TO MP4` is off and a recording is in progress. This is now a genuinely opt-in cost rather than the default experience (`gradeExport` now defaults to `true`, fixed in the final holistic review), but confirm the toggle behaves this way and decide if it needs a bigger fix (e.g. splitting preview/capture into separate canvases) later.
9. **Known limitation, found in Task 2's code review, not fixed on this branch:** if a new video is loaded mid-session, the fresh `BlobTracker` instance starts with `isExporting = false` regardless of what it was before — benign today since a new tracker can only be constructed on `loadedmetadata`, which can't fire mid-recording, but worth knowing if this pattern (each piece of tracker state re-applied by its own independently-triggered effect) gets extended further.
10. **Known limitation, found in Task 3's code review, not fixed on this branch:** `hue` interpolates linearly between keyframes like any other numeric param, but `hue-rotate()` is periodic mod 360°. Two keyframes at `hue: 170` and `hue: -170` are only 20° apart on the color wheel, but linear interpolation sweeps the long way around (340°), passing through a full spectrum shift at the midpoint instead of a small step. Try animating hue across that boundary (e.g. one keyframe near +170, the next near -170) and confirm whether this reads as a bug worth a wrap-aware interpolation fix, or is acceptable for now.
11. **Known limitation, found in Task 3's code review, not fixed on this branch:** SATURATION has no visible effect in `TRAIL_PATH`/`ASCII_BOX` modes (the forced grayscale that runs after grading makes it a no-op), but the slider isn't hidden/disabled in those modes, unlike STROKE/STROKE WIDTH/LINKS in the VISUAL section which already do hide when inapplicable. Also, the code comment in `BlobTracker.ts`'s `drawVideoFrame()` claiming mono modes "flatten away" hue/saturation/temperature is only fully true for saturation — temperature and hue both still have a small-to-moderate residual effect in mono modes. Consider hiding SATURATION conditionally and correcting the comment.
12. Consider adding a `hint` tooltip to GAMMA and TEMPERATURE (matching SENSITIVITY/MAX DIMENSION elsewhere in the panel) — neither control's direction is self-evident from its label alone (e.g. "which way does temperature go warm?").
13. **Superseded by the final holistic review's Fix 1:** `gradeExport` is no longer a `TrackerParams` field. It was found that keeping it keyframable meant it could only ever be edited per-keyframe once any keyframe existed (the keyframe UI has no way to deselect back to "no keyframe"), causing the exported MP4 to hard-switch between graded/ungraded mid-file at a keyframe boundary, and the toggle's displayed state to not reflect actual global export behavior. It's now standalone App-level state (`useState`, default `true`), and the toggle is relabeled "APPLY GRADE TO MP4" to be explicit that it only affects MP4 recording (PNG always includes grading; SVG never can, since it carries no video raster).

Expected: all of the above behave as described, no console errors.

- [ ] **Step 6: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "chore: final regression fixes for color grading"
```

(Skip this commit if Steps 1-5 required no changes.)
