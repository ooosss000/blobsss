# Preview Fixes, Transport Controls & Keyframe Export System

Date: 2026-07-29

## Context

BlobSSS is a single-page motion-tracking visualizer/exporter (`src/App.tsx` +
`src/BlobTracker.ts`). Video loads, a canvas overlays tracked-blob renders in
one of several `RenderMode`s, and export bakes the canvas to MP4 via
`VideoEncoder`/`mp4-muxer`.

Four issues/requests, bundled into one spec since they touch the same files
and ship together:

1. Preview canvas isn't centered for non-16:9 (e.g. portrait/Instagram) video.
2. Export mode shrinks the on-screen canvas to a fixed 320px corner box
   regardless of export resolution.
3. No restart control; play/pause only reachable via panel button or
   clicking the canvas.
4. No way to vary render mode/style over the timeline — everything is one
   static param set for the whole video. Core ask: a keyframe system so
   export can carry a motion-graphics look (mode/color/style changing over
   time), at high quality.

## 1. Canvas centering fix

**Root cause:** `.main-canvas` (`src/index.css:40-49`) is
`position:absolute; inset:0`, but `BlobTracker.resize()`
(`src/BlobTracker.ts:105-134`) sets an explicit `canvas.style.width/height`
in px (aspect-preserving contain-fit against the viewport). When the computed
size is smaller than the viewport in one axis (portrait video in a wide
window), `inset:0` no longer centers anything — the canvas just anchors at
its container's top-left origin.

**Fix:** change `.main-canvas` positioning to:

```css
.main-canvas {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  /* drop inset:0, width/height stay controlled by BlobTracker via style attrs */
}
```

`.main-canvas.recording` already sets its own `position/top/left/transform`
with `!important`, so it's unaffected.

## 2. Adaptive export preview sizing

Replace the fixed 320px corner box with a size computed from `exportRes`,
bounded against **both** viewport dimensions (not just width — a width-only
cap lets portrait/Instagram-format exports overflow the viewport
vertically, caught during Task 3 code review):

```
maxW = min(560, viewportW * 0.4)
maxH = min(560, viewportH * 0.4)
rawW = exportW * 0.3
rawH = exportH * 0.3
scale = min(maxW / rawW, maxH / rawH, 1)
w = rawW * scale
h = rawH * scale
// 240px legible floor applies to whichever edge is longer
if max(w, h) < 240: scale up so the long edge is exactly 240
```

Both dimensions are computed explicitly (not `height: auto`) and applied as
inline `width`/`height` styles on the canvas element (computed in
`App.tsx`, since CSS alone can't see `exportRes`), only while `isRecording`
is true. Big exports (4K+) shrink proportionally more but never below the
240px legible floor on their long edge; small exports (720p and under) stay
close to their natural size; portrait exports are now bounded by
`viewportH` instead of silently overflowing. Still docked bottom-right,
non-interactive (`pointer-events: none`), same border/shadow treatment as
today.

## 3. Transport controls

- **Panel:** add a RESTART button (`video.currentTime = 0`) next to the
  existing Play/Pause icon button in the SOURCE section.
- **Canvas overlay:** a small floating transport bar (Play/Pause, Restart),
  bottom-center over the canvas. Independent of panel visibility — reachable
  even with the panel hidden (⌃K). Hidden while `isRecording` or
  `isEncoding` (avoids clutter over the corner preview box; has no effect on
  exported pixels either way since it's DOM, not canvas content).

## 4. Keyframe motion-graphics system

### Data model

```ts
interface Keyframe {
  id: string;
  time: number;           // seconds, video.currentTime at creation
  params: TrackerParams;  // full snapshot
}
```

New App state: `keyframes: Keyframe[]`, `selectedKeyframeId: string | null`.

Zero keyframes → today's behavior is completely unchanged (single global
`params`, no special-casing needed elsewhere). The feature is additive, not
a mode toggle.

### UI — new KEYFRAMES panel section

- Horizontal timeline strip: playhead marker at
  `video.currentTime / video.duration`, diamond markers for each keyframe at
  their proportional time position.
- **+ ADD KEYFRAME** button: creates a keyframe at the current playhead time,
  snapshotting the currently active (possibly already-interpolated) params
  as its starting values. Auto-selects the new keyframe.
- Clicking a marker selects it. Selecting loads its `params` into the main
  panel controls; editing any slider/toggle/color while a keyframe is
  selected writes into that keyframe's stored params (not the global
  `params`). Deselecting (click the already-selected marker again) returns
  panel editing to the global `params` (only relevant if `keyframes.length
  === 0`, otherwise the last-selected keyframe stays authoritative for
  editing).
- **DELETE** button appears when a keyframe is selected; removes it.
- **Drag-to-retime:** grabbing a marker and dragging updates its `time`;
  list is re-sorted by time after drop; a minimum 0.05s gap between
  keyframes is enforced to avoid divide-by-zero in interpolation.
- **Not in v1:** no click-anywhere-on-track seeking, no duplicate-keyframe
  shortcut. Playhead is positioned solely via Play/Pause/Restart. This is a
  deliberate scope cut — flagging it here since it's the one convenience
  left out of an otherwise complete timeline UI.

### Param resolution (drives both preview and export identically)

`getActiveParams(time: number): TrackerParams`, called once per rendered
frame:

- 0 keyframes → global `params` (unchanged today's path).
- 1 keyframe → that keyframe's params, always (static hold).
- 2+ keyframes → find the bracketing pair `kPrev`/`kNext` for `time`
  (array kept sorted by `time`):
  - `time <= first.time` → hold `first.params`.
  - `time >= last.time` → hold `last.params`.
  - Otherwise, `t = (time - kPrev.time) / (kNext.time - kPrev.time)`:
    - Numeric params (`diffThreshold`, `minArea`, `maxArea`, `maxBlobs`,
      `lifeFrames`, `maxBlobDim`, `strokeWidth`, `fontSize`,
      `asciiContrast`) linearly interpolate.
    - Color params (`strokeColor`, `textColor`) interpolate per RGB channel,
      re-hex-encoded.
    - Discrete params (`renderMode`, `subdivide`, `neighborLinks`,
      `fontFamily`, `showCoordinates`, `showId`, `showSize`,
      `showLabelBG`) hard-switch at `t = 0.5` (no blending — can't
      meaningfully interpolate an algorithm choice or a boolean).

### BlobTracker integration

Single per-frame pipeline (`processFrame()`, `src/BlobTracker.ts:278`)
already drives both the live preview canvas and — via
`new VideoFrame(cv, ...)` capture in `App.tsx`'s `captureFrame` — the
exported MP4. One frame source, one place to hook interpolation:

- New method: `tracker.setLiveParamsResolver(fn: ((t: number) =>
  TrackerParams) | null)`.
- When set, `processFrame()` calls `fn(this.video.currentTime)` and assigns
  the result to `this.params` before rendering that frame.
- When `null` (today's default / `keyframes.length === 0`), behavior is
  byte-for-byte what it is today — no resolver call, `this.params` only
  changes via `updateParams()`.
- App wires this up: an effect sets the resolver whenever `keyframes.length
  > 0`, computing `getActiveParams` from current `keyframes` on each call;
  clears it (`null`) when `keyframes` empties.

This satisfies "live preview + export identical" and "smooth interpolate"
decisions with one small, isolated addition to BlobTracker — no changes to
the export capture loop itself.

**Caveat found in final review (2026-08-12):** the *params* fed into each
frame are provably identical between preview and export — same resolver,
same call site, same `TrackerParams` object. But several render modes
scale some visual constants by `getS() = this.width / 1280` (a
resolution-independence factor) and leave others hardcoded — e.g.
`renderASCIIBox`'s cell/font size, `renderEllipse`'s line width, parts of
`renderGhostTrail`/`renderTrailPath`. Since preview and export canvases are
rendered at different pixel widths, those specific unscaled constants
produce a visibly different look at export size than at preview size, even
though the interpolated params driving them are pixel-for-pixel the same.
This is pre-existing behavior, not introduced by the keyframe work — but
the keyframe system makes it easy to hard-switch *into* one of these modes
mid-export, so it's worth a follow-up to audit and fix the unscaled
constants. Correcting the claim above: "params are identical between
preview and export; pixel output is resolution-scaled and mostly, but not
entirely, consistent across render modes."

## Out of scope

- Export bitrate/codec/resolution changes — current 30 Mbps H.264 High
  Profile already targets high quality; not part of this spec.
- Per-keyframe easing curve choice (linear only for v1).
- Click-to-seek and duplicate-keyframe (noted above as deliberate v1 cuts).
