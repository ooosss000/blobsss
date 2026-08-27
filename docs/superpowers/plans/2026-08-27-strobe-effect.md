# Blob-triggered strobe effect

## Problem

The user wants a strobe effect: the frame flashes when a new blob is
detected, rather than on a fixed timer — reactive to motion, not a
metronome.

## Design (approved via conversational brainstorming, 2026-08-27 — written
directly per this project's established shortcut of skipping the separate
spec-doc-review step on quick conversational approval)

**Trigger**: a new blob spawning (the `else if (this.blobs.length <
this.params.maxBlobs)` branch in `BlobTracker.ts`'s blob-matching loop,
around line 634-647 — a brand new `TrackedBlob` being pushed, not an
existing one being matched/updated). Multiple simultaneous spawns in one
frame just re-trigger to full intensity rather than stacking/summing.

**Visual**: a plain alpha-blended color overlay (not a blend-mode trick
like `screen`/`multiply` — those behave asymmetrically for light vs. dark
colors, and the user explicitly wants both black and white flashes to work
the same way), decaying linearly from full intensity to 0 over a
configurable duration, drawn after everything else in the frame.

**Configurable via 5 new `TrackerParams` fields** (plain fields, governed
only by the existing unified keyframe system like most params — not added
to the special 9-field per-parameter-track set from the animated-params
feature, since there's no request for independent strobe keyframing):
- `strobeEnabled: boolean`
- `strobeIntensity: number` — peak alpha multiplier at the instant of
  trigger (0–2 range, sidebar slider, like other intensity-style params)
- `strobeColor: string` — hex color, default white (`#FFFFFF`); setting it
  to black gives the "inverted" flash the user asked for. Reuse the
  existing `ColorRow` sidebar component, same as `strokeColor`/`textColor`.
- `strobeDecayMs: number` — milliseconds for the flash to fade from full
  intensity back to 0 (e.g. slider range 50–1000ms)
- `strobeScope: 'canvas' | 'blob'` — `'canvas'` flashes the whole frame;
  `'blob'` flashes only the bounding box of whichever blob(s) triggered it

**Scope note**: `'canvas'` scope is one global decay clock. `'blob'` scope
needs a decay time *per blob* (a blob spawned 200ms ago and one spawned
20ms ago should be at different points in their own decay) — see Task 1's
`spawnTime` field.

## Non-goals

- No Ken Burns / zoom effect — explicitly deferred by the user as "too
  complex for now." Do not touch anything related to camera zoom/pan.
- No per-parameter independent track for strobe fields (see Design above)
  — they're plain `TrackerParams` fields like the ~19 non-animatable ones.
- Not changing blob-matching/lifecycle logic itself, other than reading
  (not altering) the existing spawn branch to know *when* a spawn happens.
- No new render mode — this is a post-processing overlay applied
  regardless of which render mode is active, like the mono-mode grayscale
  override already is.

## Implementation

### Task 1 — `src/BlobTracker.ts`

- Add `spawnTime: number;` to the `TrackedBlob` interface — the
  `this.video.currentTime` value at the moment this blob was created. Set
  it once, in the new-blob-push branch (~line 637-646), alongside the
  existing `spawnX`/`spawnY` fields. Using video time (not
  `performance.now()`) keeps the decay calculation correct and
  deterministic across both live preview and non-realtime-adjacent export,
  consistent with how every other time-based calculation in this class
  (keyframe resolution, trail aging) already keys off video time, not
  wall-clock time.
- Add `private lastCanvasStrobeTime: number | null = null;` — the
  `this.video.currentTime` of the most recent frame in which *any* new
  blob spawned (used only for `'canvas'` scope; `'blob'` scope reads each
  blob's own `spawnTime` instead and needs no separate state).
- In the blob-matching loop, track whether *any* new blob was pushed this
  call (a local `let anySpawned = false;` set `true` in the new-blob
  branch), and after the loop, if `anySpawned`, set
  `this.lastCanvasStrobeTime = this.video.currentTime;`.
- New private method, called once per frame after the last render step
  (`renderBlobs()`) in **both** places that currently call it —
  `processFrame()` (~line 542) and `renderOnce()` (~line 358):
  ```ts
  private applyStrobe() {
    const p = this.params;
    if (!p.strobeEnabled || p.strobeDecayMs <= 0) return;
    const now = this.video.currentTime;
    this.ctx.fillStyle = p.strobeColor;
    if (p.strobeScope === 'canvas') {
      if (this.lastCanvasStrobeTime === null) return;
      const decay = 1 - (now - this.lastCanvasStrobeTime) * 1000 / p.strobeDecayMs;
      if (decay <= 0) return;
      this.ctx.globalAlpha = Math.min(1, p.strobeIntensity * decay);
      this.ctx.fillRect(0, 0, this.width, this.height);
    } else {
      for (const b of this.blobs) {
        const decay = 1 - (now - b.spawnTime) * 1000 / p.strobeDecayMs;
        if (decay <= 0) continue;
        this.ctx.globalAlpha = Math.min(1, p.strobeIntensity * decay);
        this.ctx.fillRect(b.x, b.y, b.w, b.h);
      }
    }
    this.ctx.globalAlpha = 1;
  }
  ```
  (Exact placement/structure is implementer's judgment — the above is
  illustrative, not literal-must-match — but the decay formula, the
  video-time basis, and the "runs after `renderBlobs()`, in both existing
  call sites" placement are load-bearing and must be preserved.)
- `resetTracking()` (~line 346) must also clear
  `this.lastCanvasStrobeTime = null;` — a seek already clears `this.blobs`
  (which naturally zeroes out `'blob'`-scope strobe state, since there are
  no blobs left to iterate), but `lastCanvasStrobeTime` is independent
  state that would otherwise survive a seek and could produce an incorrect
  leftover canvas-wide flash computed against a trigger time from a
  completely different point in the video — the exact class of stale-
  state-after-seek bug this project has caught and fixed multiple times
  already this session (e.g. the original `resetTracking()` fix itself,
  for blobs/prevData).

### Task 2 — `src/App.tsx`

- Add the 5 new fields to `DEFAULT_PARAMS` (line ~24): `strobeEnabled:
  false, strobeIntensity: 1, strobeColor: '#FFFFFF', strobeDecayMs: 200,
  strobeScope: 'canvas'`.
- New sidebar `<Section label="STROBE">` (placement: implementer's
  judgment — logically near COLOR GRADE or VISUAL, since it's another
  visual-only effect toggle). Contents:
  - A toggle row for `strobeEnabled` (reuse `BrutToggle`, same pattern as
    `showCoordinates`/etc.).
  - `BrutSlider` for `strobeIntensity` (e.g. min 0, max 2, step 0.05).
  - `ColorRow` for `strobeColor` (reuse exactly as `strokeColor`/`textColor`
    are wired).
  - `BrutSlider` for `strobeDecayMs` (e.g. min 50, max 1000, step 10).
  - A 2-option toggle for `strobeScope` (`'canvas'` / `'blob'`) — reuse
    whatever this codebase's existing 2-option-button pattern is (e.g. the
    render-mode grid's button styling, scaled down to 2 buttons) rather
    than inventing a new control type.
  - All 5 controls wired through `setDisplayParam`/`displayParams`
    exactly like every other non-animatable `TrackerParams` field — no
    special-casing needed (these aren't part of the animatable-9 system).

### Task 3 — Regression pass + manual QA

Full verification gate (`npx tsc -b`, `npx vitest run`, `npm run build`,
`npx eslint` on every touched file) plus a manual QA checklist (no browser
automation available in this environment — needs a human):
1. Load a video with motion, enable strobe (canvas scope) — confirm the
   whole frame flashes white briefly whenever a new blob appears, fading
   smoothly over the configured decay duration, not before.
2. Switch `strobeColor` to black — confirm the flash now darkens instead
   of brightening, with no asymmetric/broken blending.
3. Switch scope to `'blob'` — confirm only the newly-spawned blob's own
   box region flashes, not the whole frame, and that an existing
   (previously-matched, not newly-spawned) blob does NOT flash just
   because it's still being tracked.
4. Multiple blobs spawning in the same frame — confirm each blob-scope
   flash decays independently (a blob spawned slightly later should still
   be flashing after an earlier one has faded).
5. Pause, seek elsewhere in the video, confirm no stale/incorrect flash
   appears at the new position purely from an old trigger time surviving
   the seek (this is the `resetTracking()` fix's specific job — test it
   directly).
6. Confirm strobe intensity/decay/color are correctly baked into MP4
   export (record a short clip with strobe enabled, play it back,
   confirm the flashes appear in the output).
7. Confirm strobe interacts sanely with mono-mode render modes
   (TRAIL_PATH/ASCII_BOX, which force grayscale on the video draw) — the
   strobe overlay itself isn't grayscale-forced (it's a separate pass
   after `renderBlobs()`, not part of `drawVideoFrame()`'s mono
   treatment), so confirm this reads as intentional (a colored flash is
   fine even in a mono render mode) rather than a jarring inconsistency —
   flag if it looks wrong, this wasn't explicitly specified by the user.
8. Confirm strobe fields are captured correctly by the unified keyframe
   system exactly like any other param (add a keyframe with strobe on,
   another with strobe off, confirm the hold-based switch works).

## Known limitations

- No per-parameter independent track for strobe (see Non-goals) — it's
  keyframeable only via the unified (hold-based, full-snapshot) system.
- `'blob'` scope's per-blob flash uses each blob's raw `TrackedBlob`
  bounding box (`b.x, b.y, b.w, b.h`), not the possibly-subdivided
  `getDisplayBlobs()` output used for actual rendering in some modes — a
  blob subdivided into multiple sub-boxes (via the SUBDIVIDE density
  setting) will flash as one single box covering its full original
  extent, not per-sub-box. Acceptable simplification; revisit if it reads
  as visually wrong once tested.
