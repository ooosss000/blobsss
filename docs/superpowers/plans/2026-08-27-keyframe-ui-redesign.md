# Keyframe UI redesign — persistent transport dock

## Problem

The keyframe workflow (seek to a moment → add a keyframe → tweak sliders for
it → seek to the next moment → repeat) required constant scrolling: the
timeline/add-keyframe controls lived in a `KEYFRAMES` section at the bottom
of a long scrollable sidebar, below MOTION/DENSITY/VISUAL/COLOR GRADE/LABELS,
while the sliders that actually edit a keyframe's params live at the top of
that same sidebar. Every edit cycle meant scrolling down to seek/add, then
back up to tweak, then back down again.

Separately, the single 28px `.kf-track` combined video-scrubbing and
keyframe-marker-dragging in one small strip, which the user found too small
and conflated two different jobs (moving through the video vs. managing
keyframes) into one control.

## Design (approved by user via conversational brainstorming, 2026-08-26/27 —
written directly to a plan doc per this project's established shortcut of
skipping the separate spec-doc-review step on quick conversational approval)

Replace the sidebar-embedded `KeyframeTimeline` with a **persistent dock**
floating over the canvas at the bottom of the screen (same positioning
pattern as the existing `.transport-overlay`), containing two visually
distinct, taller bars:

1. **Scrub row**: play/pause/restart buttons (moved here from the existing
   separate `.transport-overlay`) + a new `VideoScrubBar` (taller than the
   old 28px track, ~44px) + a `0:12 / 1:34` time readout. Click/drag
   anywhere on this bar seeks. This bar has ONE job: moving through the
   video.

2. **Keyframe row**: a new `KeyframeBar` (same height, markers only — no
   track-level click-to-seek at all) + prev/next-keyframe jump buttons
   (◀ ▶) + ADD/DELETE keyframe buttons, all in the same row. This bar's only
   interactive elements are the keyframe markers themselves (bigger hit
   targets than before). Removing track-scrub from this bar entirely also
   removes the whole "marker gesture vs. track gesture" conflict class that
   needed dedicated fixes in the old `KeyframeTimeline` (stopPropagation,
   button/isPrimary guards, hit-target enlargement, in-flight-gesture
   clearing on disable) — those fixes' logic still applies to the marker
   drag gesture itself, but there's no competing track-seek gesture to
   isolate it from anymore.

3. **Status line**: "EDITING LIVE" or "EDITING KEYFRAME @ 0:12" — a small
   always-visible label so slider edits' target is never ambiguous. This
   wasn't the user's top complaint but is a near-zero-cost addition given
   the dock already exists.

**Whole dock hides on Ctrl+K** (`showUI` state), including the play/pause/
restart buttons that move into it. This fixes a pre-existing bug: the old
`.transport-overlay` was NOT gated by `showUI` at all, contradicting the
sidebar's own hint text ("CTRL+K hides everything").

**Sidebar**: the `KEYFRAMES` section shrinks to just the existing status
hint text (`"3 keyframes — ..."`) — the interactive controls (track, add,
delete) move entirely to the dock. Sliders/sections above are unchanged.

## Non-goals

- Not changing how keyframe interpolation/resolution works (`keyframes.ts`
  is untouched).
- Not adding new keyframeable params.
- Not touching the COLOR GRADE, MOTION DETECTION, or other slider sections'
  layout — only the KEYFRAMES section and the transport overlay.
- Not re-litigating the existing "can't deselect back to LIVE editing once
  any keyframe exists" behavior (see `KeyframeTimeline.tsx`'s existing
  comment on this) — carried forward unchanged into `KeyframeBar`.

## Implementation

### New file: `src/VideoScrubBar.tsx`

Extracted/simplified scrub-only control. Props: `currentTime, duration,
onSeek, disabled`. Pointer handling is a strict subset of the old
`KeyframeTimeline`'s track logic (button/isPrimary guard, touch-action:none,
user-select:none, onLostPointerCapture, disabled-mid-gesture clearing via
the same `useEffect` pattern) — no markers, no `draggingId` state, since
this bar never deals with keyframes at all. Renders a playhead indicator
(`.kf-playhead`, reused) and the time readout as a sibling, not inside the
track itself (avoid the readout eating into the draggable hit area).

### Modify: `src/KeyframeTimeline.tsx` → rename to `src/KeyframeBar.tsx`

Strip `onSeek` prop and all track-level pointerdown/scrubbing logic
entirely (`handleTrackPointerDown`, `scrubbing` state, the `else if
(scrubbing)` branch in `handlePointerMove`). What remains: marker rendering,
`handleMarkerPointerDown`, marker drag via `handlePointerMove` (now only the
`if (draggingId)` branch), the disabled-mid-drag-clears-effect (still
needed — marker dragging is still a multi-event gesture that can span a
`disabled` flip), and the playhead indicator (visual only now, no
pointerdown handler on the container at all since there's nothing for it to
do). Delete button (`onDelete`) stays as a prop but its rendering moves out
to `TransportDock` (single row layout, see below) rather than living inside
this component — `KeyframeBar` becomes purely the marker strip.

Add: `onJumpPrev`/`onJumpNext` are NOT part of this component — nav-button
logic (finding nearest prior/next keyframe) lives in `TransportDock` where
`onSelect`/`onSeek` are both in scope, since jumping needs both actions
together.

### New file: `src/TransportDock.tsx`

Composes both bars plus buttons into the persistent floating dock. Props:
everything currently threaded through App.tsx for playback + keyframes
(`isPaused, onTogglePlay, onRestart, currentTime, duration, onSeek,
keyframes, selectedId, onSelect, onDelete, onRetime, onAddKeyframe,
disabled`).

Prev/next logic (pure function, no new state):
```ts
const EPS = 0.01;
const sorted = [...keyframes].sort((a, b) => a.time - b.time);
const prevKf = [...sorted].reverse().find(k => k.time < currentTime - EPS);
const nextKf = sorted.find(k => k.time > currentTime + EPS);
```
Jump handlers seek AND select together: `onSeek(target.time); onSelect(target.id);`
so the status line and slider values update immediately, not just the
playhead. Nav buttons are `disabled` when there's no such keyframe, in
addition to the existing recording-disabled flag.

Status line derives from `selectedId`/`keyframes`/`fmtTime` (already exists
in App.tsx, needs threading down or reimplementing locally — reuse, don't
duplicate: export `fmtTime` from App.tsx or move it to a small shared
util). Given it's a one-line pure function, simplest is a tiny local copy
in `TransportDock.tsx` with a comment noting it intentionally mirrors
App.tsx's `fmtTime` rather than adding a new shared-util file for one
function — acceptable per YAGNI, revisit only if a third place needs it.

Layout: outer `.transport-dock` (fixed/absolute, bottom-center, matches
`.transport-overlay`'s positioning), two `.dock-row` children (scrub row,
keyframe row), one `.dock-status` line. Gated by `showUI` in App.tsx (not
internally) — same pattern as the existing sidebar `AnimatePresence` block.

### `src/App.tsx` changes

- Remove the standalone `.transport-overlay` block (play/pause/restart) —
  moves into `TransportDock`.
- Remove `<KeyframeTimeline ... />` usage and the `ADD KEYFRAME AT ...`
  button from the sidebar's `KEYFRAMES` `<Section>` — keep only the status
  hint text.
- Add `<TransportDock ... />` inside the existing `{showUI && (...)}` gate
  (or its own sibling gate — either way, must not render when `showUI` is
  false).
- `addKeyframe` becomes a prop passed straight through (`onAddKeyframe`),
  logic unchanged.

### `src/index.css` changes

- New `.transport-dock` container: fixed/absolute bottom-center (mirror
  `.transport-overlay`'s existing rule), `display: flex; flex-direction:
  column; gap: 8px`, reasonable `max-width` so it doesn't stretch edge-to-
  edge on wide screens, `z-index` matching or above `.transport-overlay`'s
  old `40`.
- `.dock-row { display: flex; align-items: center; gap: 8px; }`
- Bump `.kf-track`/new shared scrub-track height from `28px` to `44px` (or
  introduce a `.dock-track` class shared by both bars if visually
  identical apart from marker presence — prefer one shared class over
  duplicating the track's base styles, to avoid the two bars drifting
  visually out of sync later).
- Enlarge `.kf-marker` proportionally to the new track height (keep the
  existing `::before` hit-target-enlargement trick, just re-tuned to the
  new dimensions).
- `.dock-status` small hint-text styling (reuse `.hint-text` if it fits).

## Testing

- `npx tsc -b`, `npm run build` (timeout ≥60000ms — known intermittent
  sandbox hang), `npx vitest run` (43 tests, unaffected — no `keyframes.ts`
  changes), `npx eslint src/*.tsx` (baseline: 17 pre-existing errors in
  `App.tsx` around the SOURCE `<option>` ref access, unrelated).
- Manual QA checklist (no browser automation available in this
  environment — needs a human):
  1. Ctrl+K hides the ENTIRE dock (both bars, buttons, status line) —
     the specific bug this redesign is required to fix, not just carry
     forward.
  2. Scrub bar: click/drag seeks smoothly; does not affect keyframe
     selection.
  3. Keyframe bar: clicking empty space does nothing (no seek) — confirms
     the two bars' jobs stay separated.
  4. Keyframe bar: marker click selects, drag retimes, same as before.
  5. Prev/next buttons jump to the correct adjacent keyframe and update
     both the playhead and the selected keyframe (status line + sliders
     reflect the new selection).
  6. Prev/next buttons are disabled (not just inert) at the first/last
     keyframe.
  7. ADD/DELETE buttons in the dock work identically to the old sidebar
     versions.
  8. All of the above disabled correctly during recording/encoding,
     matching the old `disabled` behavior.
  9. Status line accurately reflects LIVE vs. the correct keyframe's time
     at every selection change.
  10. Sidebar KEYFRAMES section still shows the correct count/hint text
      and takes up much less vertical space than before.

## Known limitations (carried forward or accepted for this pass)

- Can't deselect back to "LIVE" editing once any keyframe exists (existing
  behavior, unchanged — see `KeyframeBar`'s inherited comment).
- No per-pointerId multi-touch tracking (existing limitation, unchanged).
- `fmtTime` is duplicated (App.tsx + TransportDock.tsx) rather than
  extracted to a shared util — acceptable per YAGNI for two call sites,
  revisit if a third appears.

## Post-implementation corrections (found in review, 2026-08-27)

Spec-compliance review found and fixed: `.kf-marker::before`'s enlarged
hit-target (re-tuned for the new 44px track height) bled ~6px into
adjacent `.dock-row` buttons for a keyframe at time≈0 or time≈duration —
fixed with `overflow: hidden` on `.scrub-track, .kf-track`, which clips
both rendering and hit-testing at the track boundary (verified this
doesn't clip the marker diamond or playhead in normal, non-edge
positions).

Code-quality review found and fixed three issues:
- **Major**: `TransportDock`'s play/pause and restart buttons had no
  `disabled` prop, unlike every other dock control — a stray Restart
  mid-recording would splice a backward seek into the MP4 capture (the
  encoder's timestamps are a pure synthetic counter, independent of
  `video.currentTime`). Fixed by adding `disabled={disabled}` to both.
- **Minor**: `.kf-track` kept `cursor: pointer` from the old shared rule
  even though it's no longer click-to-seek. Split into
  `.scrub-track { cursor: pointer }` / `.kf-track { cursor: default }`.
- **Minor**: `handleMarkerPointerDown` in `KeyframeBar.tsx` had a
  vestigial `e.stopPropagation()` left over from the old combined
  component (guarding against a track-level pointerdown handler that no
  longer exists). Removed.

Final holistic branch review found no blocking issues (`Ready to merge:
Yes`) but flagged two non-blocking items for the record, both confirmed
**pre-existing** (not introduced by this branch) via `git diff`/`git
show` against the prior versions of the affected files:

- **`startRecording`'s async setup window** (`App.tsx`): the dynamic
  `import('mp4-muxer')` means there's a brief window where
  `tracker.setExporting(true)`/`tracker.resize(...)` have already run but
  `isRecording` (and therefore the dock's `disabled` gate) hasn't
  committed yet. A stray seek/restart in that narrow window wouldn't
  corrupt the MP4 itself (the capture loop starts after `isRecording`
  commits, in the same synchronous continuation), but it's a real gap
  against the "all export-adjacent controls disabled during recording"
  invariant. Out of scope for a keyframe-UI redesign; worth a small,
  separate follow-up (set `isRecording` true before the `await import`).
- **`pct()`/`clientXToTime()` duplication**: `VideoScrubBar.tsx` and
  `KeyframeBar.tsx` have byte-for-byte identical implementations of both
  helpers. Low risk (simple duration/rect math, unlikely to drift), but a
  natural candidate for a shared `useTrackGeometry(duration)` hook if a
  third track/consumer ever appears — not extracted now per the same
  YAGNI reasoning already applied to `fmtTime` above.
