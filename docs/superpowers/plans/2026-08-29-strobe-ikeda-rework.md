# Strobe rework: Ikeda-style pulses, box-tracking sync, random generator mode

## Problem

The existing strobe effect (added in `2026-08-27-strobe-effect.md`, `BlobTracker.ts:743-768`)
is a single linear alpha fade (full intensity → 0 over `strobeDecayMs`) applied either to the
whole canvas or to a raw filled rect over a spawning blob's bounding box. The user reports this
"is not working properly" and wants three changes (approved via terse "go" — per this project's
established shortcut, skipping the separate written-spec-review round; this plan doc is the
durable design record):

1. Strobe should read like a Ryoji Ikeda performance — stark, high-contrast, precise binary
   on/off pulses, not a soft fade.
2. When strobe is enabled, the blob-tracking bounding box ("the square tracking") itself should
   strobe, not just a full-canvas/rect overlay wash that sits on top of it.
3. A new trigger mode: strobing fires from a random generator (like a signal generator),
   independent of blob-spawn events.

## Design

### 1. Hard pulse-train instead of linear fade

Ikeda's strobe work (`test pattern`, `datamatics`) is defined by stark binary black/white cuts —
constant-intensity flashes with no fade, arriving in tight rapid bursts, not one smooth decay.

Replace the single linear-decay flash with a **pulse train**: on trigger, the effect fires
`strobePulses` (new field, default 4, range 1–12) hard on/off flashes spread evenly across the
existing `strobeDecayMs` window (renamed in spirit to "burst duration," field name unchanged to
minimize churn). Each pulse is constant-alpha `strobeIntensity` when "on" (no fade), 0 when
"off" — a fixed 35% duty cycle per pulse period (hardcoded constant, not a new slider — keeps
the UI additions minimal per the three actual asks).

```
period = strobeDecayMs / strobePulses
phase = (elapsedMs % period) / period
on = phase < 0.35
alpha = on ? strobeIntensity : 0
```

`strobePulses <= 1` degenerates to a single hard on/off flash (still valid, still hard-cut —
just not a "train"). This one change (hard cut, no fade, multi-pulse burst) is the fix for
"not working properly" and the core of the Ikeda-style ask; it applies uniformly to both trigger
modes (spawn and random, see below) and all three scopes.

### 2. `strobeScope: 'canvas' | 'blob' | 'box'` — new `'box'` scope strobes the tracking square

Current `'canvas'`/`'blob'` scopes both do a filled-rect wash, which sits on top of (and can
visually swallow) whatever the active render mode already drew for the tracking box — never
actually strobes the box itself.

New `'box'` scope: on each "on" pulse tick, stroke the tracking box outline (not fill) at
`strobeColor`, hard-edged, at a boosted line width (`Math.max(this.params.strokeWidth, 4) *
this.getS()`), using `difference` composite so it reads as a bright flash against both light and
dark backgrounds regardless of the active render mode's own box color. On the "off" tick, draw
nothing extra — the render mode's own (non-strobing) box remains, so the net visual is the
tracking square itself blinking hard on top of the normal box, rather than a wash covering it.

`'box'` scope loops over `getDisplayBlobs()` output (not raw `this.blobs`) so it strobes the
same subdivided sub-boxes actually rendered in SUBDIVIDE mode — fixing the known limitation
called out in the original plan doc for `'blob'` scope (which stays on raw `this.blobs` for
backward compat; `'box'` is the new, correctly-scoped option).

### 3. `strobeTriggerMode: 'spawn' | 'random'` — deterministic random generator

New field, default `'spawn'` (preserves current behavior exactly). `'random'` mode fires pulse
trains on a schedule independent of blob spawns, styled as a signal generator: irregular,
deterministic, reproducible on scrub/export.

Must stay deterministic and stateless (a function of `video.currentTime` alone) — this project
has hit stale-state-after-seek bugs before (see original strobe plan's `resetTracking()` fix,
and the `lastCanvasStrobeTime` seek-clear); a persistent "next scheduled trigger" timer would
reintroduce that class of bug. Instead, derive triggers purely from time buckets and a
deterministic hash, no stored schedule:

```ts
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
```

New fields:
- `strobeRandomIntervalMs: number` — average bucket spacing (default 400, range 100–2000).
- `strobeRandomDensity: number` — probability a given bucket actually fires (default 0.7, range
  0–1); this is what makes it read as an irregular generator rather than a metronome.

Per frame, for `bucket = Math.floor(now * 1000 / strobeRandomIntervalMs)`, check both `bucket`
and `bucket - 1` (a burst from the previous bucket may still be mid-pulse-train if
`strobeDecayMs` exceeds `strobeRandomIntervalMs`): `hash01(bucket)` decides fire/no-fire against
`strobeRandomDensity`, `hash01(bucket + 0.5)` gives a jitter fraction placing the exact trigger
instant within the bucket. Whichever bucket (if either) has an active, still-decaying pulse
train wins (prefer the more recent). Feed the resulting `elapsedMs` into the same pulse-train
formula as spawn mode — one shared renderer for both trigger sources.

In `'random'` mode, per-blob scopes (`'blob'`/`'box'`) apply to *all currently tracked blobs
simultaneously* on each fire (there's no single "spawning" blob to key off) — reuse
`this.blobs` / `getDisplayBlobs()` directly rather than tracking which blob "caused" the trigger.

## Non-goals

- No change to the blob-spawn trigger logic itself (`anySpawned`/`lastCanvasStrobeTime`) beyond
  routing its output through the new shared pulse-train renderer.
- No fade/easing option — hard cut is the point (Ikeda ask). Not adding a toggle to bring back
  the old soft-fade behavior; `strobePulses` accomplishes "single instant flash" at value 1 for
  anyone who wants something close to the old feel, just hard-cut instead of fading.
- No duty-cycle slider — hardcoded 35%, per the "don't add sliders beyond the three actual asks"
  scope call above.
- Not touching the 10 render modes' own box-drawing code — `'box'` scope is a post-pass overlay
  like `'canvas'`/`'blob'` already are, not a render-mode change.

## Implementation

### Task 1 — `src/BlobTracker.ts`

- Extend `TrackerParams` (around line 82-90): add `strobePulses: number`,
  `strobeTriggerMode: 'spawn' | 'random'`, `strobeRandomIntervalMs: number`,
  `strobeRandomDensity: number`; extend `strobeScope` union to include `'box'`.
- Add `hash01()` as a small module-level pure function (no class state) near the top of the
  file or just above `applyStrobe()`.
- Rewrite `applyStrobe()` (currently lines 743-768):
  - Compute `elapsedMs` per active scope-target using the shared pulse-train formula (extract a
    small private helper, e.g. `private strobeAlpha(elapsedMs: number): number`, returning 0 or
    `strobeIntensity` per the phase/duty-cycle formula above — reusable across trigger modes and
    scopes).
  - For `strobeTriggerMode === 'spawn'`: same trigger sourcing as today
    (`lastCanvasStrobeTime` for `'canvas'`, each blob's `spawnTime` for `'blob'`/`'box'`).
  - For `strobeTriggerMode === 'random'`: compute the two-bucket check above to get an
    `elapsedMs` (or "not firing"), independent of blob spawns; for `'blob'`/`'box'` scope apply
    to every current blob (or `getDisplayBlobs()` for `'box'`).
  - `'canvas'`: `fillRect` full frame at the computed alpha (same as today, just hard-cut alpha
    instead of decayed alpha).
  - `'blob'`: unchanged targeting (raw `this.blobs` rect fill), hard-cut alpha.
  - `'box'` (new): `getDisplayBlobs()`, `difference` composite, `strokeRect` at boosted line
    width, only drawn on "on" ticks (alpha > 0) — skip entirely on "off" ticks rather than
    stroking at alpha 0.
- `resetTracking()`: no new persistent state to clear (design is deliberately stateless/seek-safe
  per the determinism requirement above) — confirm this holds instead of adding new clearing
  logic; if the implementer finds a need for any new mutable field, it must be cleared here.

### Task 2 — `src/App.tsx`

- `DEFAULT_PARAMS`: add `strobePulses: 4, strobeTriggerMode: 'spawn', strobeRandomIntervalMs:
  400, strobeRandomDensity: 0.7`.
- STROBE section (currently `App.tsx:586-601`):
  - Add a `BrutSlider` for `strobePulses` (min 1, max 12, step 1), placed near `INTENSITY`.
  - Extend the scope 2-button row to 3 buttons: `CANVAS` / `BLOB` / `BOX`.
  - Add a trigger-mode 2-button row (`SPAWN` / `RANDOM`, same `mode-btn` pattern as the scope
    row) wired to `strobeTriggerMode`.
  - When `strobeTriggerMode === 'random'`, additionally show `BrutSlider`s for
    `strobeRandomIntervalMs` (min 100, max 2000, step 50) and `strobeRandomDensity` (min 0, max
    1, step 0.05) — conditionally rendered, same pattern as the existing `strobeEnabled &&
    (...)` guard.

### Task 3 — Regression pass + manual QA

Full verification gate (`npx tsc -b`, `npx vitest run`, `npm run build`, `npx eslint` on every
touched file) plus a manual QA checklist (no browser automation in this environment — needs a
human):

1. Spawn mode, canvas scope: confirm hard on/off flashes (no visible fade), multiple pulses per
   trigger matching `strobePulses`.
2. Spawn mode, box scope: confirm the tracking square itself blinks hard on new-blob spawn,
   visible against both light and dark video content; confirm it tracks subdivided sub-boxes
   correctly when SUBDIVIDE density > 1.
3. Spawn mode, blob scope: confirm still only the raw full-extent box flashes (unchanged from
   before), now hard-cut instead of fading.
4. Random mode: confirm strobing fires on its own with no blobs spawning, at an irregular (not
   metronomic) cadence matching `strobeRandomDensity` — lower density should visibly skip more
   ticks.
5. Random mode + box scope: confirm all currently-tracked blobs' boxes flash together on each
   generator tick.
6. Seek around the video repeatedly in both trigger modes — confirm no stuck/stale flash and no
   crash; random mode in particular must reproduce the same flash pattern at the same timestamp
   on repeated seeks (determinism check).
7. Confirm `strobeColor` black vs white both read correctly in `'box'` scope's `difference`
   blend (a pure-black stroke under `difference` is a no-op against video — flag if this reads
   as broken; may need `'box'` scope to force `source-over` with an emphasized stroke instead of
   relying on `difference` if black flashes turn out invisible).
8. Confirm export (MP4 record) bakes in both trigger modes correctly, including random mode
   reproducing the same pattern in the export as in preview (same determinism check as #6, but
   through the export path).
9. Confirm strobe fields (including the 4 new ones) are captured correctly by the unified
   keyframe hold-based system.

## Known limitations

- Fixed 35% duty cycle (no slider) — revisit if Ikeda-style tuning needs finer control later.
- `'box'` scope's `difference` blend may render pure black (`#000000`) flashes as invisible
  (difference against black = no change) — see QA item 7; implementer should verify visually and
  adjust to `source-over` if needed, noting the change here if so.
- Random-mode bucket check only looks back one bucket; if `strobeDecayMs` is set to more than
  `2 * strobeRandomIntervalMs`, a very old trigger's tail could be missed. Acceptable given the
  slider ranges (max decay 1000ms vs min interval 100ms means this only matters at extreme
  slider combinations) — revisit if it reads as wrong in testing.
