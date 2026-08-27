# Transport dock: draggable, hideable, bigger/thicker, and responsive

## Problem

Follow-up feedback on the persistent transport dock (shipped in
`2026-08-27-keyframe-ui-redesign.md`): the fixed bottom-center position and
44/56px track height still felt too small/imprecise to comfortably drag,
the dock couldn't be moved out of the way if it ever overlapped anything,
there was no way to hide it independently of the global Ctrl+K "hide
everything" (e.g. to declutter the canvas while leaving the sidebar
visible), and the small brutalist UI text was reported as hard to read.
Also asked: check the whole thing scales properly across screen sizes.

## Design (approved by user via conversational brainstorming, 2026-08-27 —
written directly per this project's established shortcut of skipping the
separate spec-doc-review step on quick conversational approval; two
explicit design decisions were made via AskUserQuestion: dragging via a
dedicated grip handle rather than click-anywhere-on-background, and
clamp-to-viewport-only rather than active sidebar-avoidance)

1. **Bigger UI text**: every small brutalist text `font-size` bumped up by
   1px (9→10, 10→11, 11→12px) across the whole stylesheet — done via three
   sequential `sed` passes in descending order (11→12, then 10→11, then
   9→10) to avoid a smaller rule's output being re-matched by a larger
   rule's pattern in the same pass. The large 18px title is untouched.
   New elements added by this same change (`.dock-caption`) are
   deliberately kept small (9px) since they're explanatory captions, not
   primary UI text — matches the user's own wording ("small text and info
   to better understand").

2. **Draggable dock**: a `GripVertical` handle at the top of the dock.
   Pointer-down on the grip records the offset between the pointer and the
   dock's current top-left (via `getBoundingClientRect()`), then
   pointer-move repositions the dock via inline `left`/`top` styles that
   override the default CSS bottom-center position. Clamped to
   `[0, viewport - dock size]` on every move, and re-clamped on window
   `resize` in case a previously-valid dragged position would now put the
   dock (partially) off-screen. Position resets to the default (`pos =
   null`) on every page load — deliberately not persisted, to avoid a
   stale position surviving a drastic resolution/window-size change across
   sessions.

3. **Show/hide toggle**: `dockVisible` state (default `true`), a
   `BrutToggle` added to the sidebar's `KEYFRAMES` section ("SHOW
   TRANSPORT DOCK"). Render condition becomes `videoSrc && showUI &&
   dockVisible` — Ctrl+K (`showUI`) still hides the dock regardless of this
   toggle's own state; this toggle only ever hides it *in addition to*
   that, never overrides Ctrl+K to force it visible.

4. **Thicker tracks, responsive**: track height changed from a fixed 56px
   to `--track-h: clamp(64px, 6vw, 88px)` (a CSS custom property on
   `.transport-dock`, inherited by descendants), so it scales smoothly with
   viewport width between a 64px floor and 88px ceiling instead of a single
   fixed value. Marker size and its enlarged hit-target (`::before`) are
   both expressed as `calc(var(--track-h) * <ratio>)` rather than separate
   hardcoded pixel values, so they stay proportional to the track at any
   viewport width without needing extra breakpoints per size tier.

5. **Explanatory captions**: a small (9px) caption under each row —
   "DRAG TO SEEK" under the scrub row, "CLICK MARKER TO SELECT · DRAG TO
   RETIME" under the keyframe row.

## Non-goals

- Not persisting dock position across page loads/sessions (see design
  decision #2 above).
- Not implementing active collision-avoidance against the sidebar panel —
  the dock can be dragged to overlap it; the user is free to avoid that
  themselves (explicit design decision, see AskUserQuestion above).
- Not touching keyframe interpolation, the recording/export pipeline, or
  any sidebar section other than adding one toggle row to KEYFRAMES.

## Implementation

### `src/TransportDock.tsx`

- New `dockRef`, `dragOffset` (ref, not state — doesn't need to trigger
  re-renders), `dragging` (state), `pos` (state, `{x,y} | null`).
- `clampToViewport(x, y)`: reads `dockRef.current.offsetWidth/offsetHeight`
  fresh each call (not cached from drag-start), so the clamp bound is
  always correct even if the dock's own size changes between renders
  (e.g. the narrow-viewport CSS breakpoint changing its padding/gap).
- Grip handlers follow the same gesture-safety conventions already
  established in `VideoScrubBar`/`KeyframeBar`: `button`/`isPrimary` guard
  on pointerdown, `setPointerCapture`, `onLostPointerCapture` alongside
  `onPointerCancel`/`onPointerUp` for the release path. No `disabled`-mid-
  gesture clearing effect was added for the grip drag — unlike scrub/retime
  gestures, repositioning the dock has no interaction with the recording
  pipeline, so there's nothing unsafe about letting an in-flight drag
  finish even if `disabled` flips true mid-drag.
- `useEffect` window-resize listener re-clamps only when `pos` is non-null
  (default-positioned dock doesn't need it — the CSS `min(1100px,
  calc(100vw - 32px))` already handles that case).
- Inline `style={pos ? {left, top, bottom:'auto', transform:'none'} : undefined}`
  — `undefined` (no inline style at all) falls back cleanly to the
  default CSS bottom-center rule; once `pos` is set, the inline style wins
  on specificity and fully replaces the default positioning.

### `src/App.tsx`

- New `dockVisible` state next to `showUI`.
- `TransportDock`'s render condition gains `&& dockVisible`.
- New toggle row in the `KEYFRAMES` `<Section>`, using the existing
  `BrutToggle` component (already defined/used elsewhere in this file for
  the same `toggle-row` pattern — no new component needed).

### `src/index.css`

- `sed`-driven font-size bump (see design #1).
- `--track-h` custom property + `calc()`-derived marker/hit-target sizes
  (see design #4).
- New `.dock-grip` (centered flex row, `cursor: grab`/`grabbing`,
  `touch-action: none` so a touch-drag on the grip doesn't also scroll the
  page) and `.dock-caption` (small, dim, centered) rules.

## Testing

- `npx tsc -b`, `npx vitest run` (43 tests, unaffected), `npm run build`,
  `npx eslint src/App.tsx src/TransportDock.tsx src/VideoScrubBar.tsx
  src/KeyframeBar.tsx` (baseline: 17 pre-existing `App.tsx` errors, 0 in
  the dock/bar components).
- Manual QA checklist (no browser automation available in this
  environment — needs a human):
  1. Drag the grip handle — dock follows the pointer smoothly, tracks/
     buttons inside it remain fully functional (no gesture conflict with
     the grip drag).
  2. Drag the dock to each screen edge/corner — it stops exactly at the
     viewport boundary, never goes partially off-screen.
  3. Drag the dock somewhere, then resize the browser window smaller —
     dock stays fully on-screen (re-clamped), doesn't jump unexpectedly if
     it was already within the new bounds.
  4. Reload the page after dragging — dock returns to the default
     bottom-center position (not persisted, by design).
  5. Toggle "SHOW TRANSPORT DOCK" off — dock disappears; sidebar and canvas
     remain visible and unaffected. Toggle back on — dock reappears at
     wherever it currently would be (default position if never dragged
     this session, or its last dragged position if toggled off mid-session
     without a reload).
  6. With the dock hidden via the new toggle, press Ctrl+K — sidebar hides
     too (unaffected interaction between the two independent viz toggles).
     Press Ctrl+K again — sidebar returns, dock stays hidden (toggle state
     persists independently of Ctrl+K).
  7. Resize the browser window across a wide range (very narrow to very
     wide) — track height and marker size scale smoothly, no visible
     snapping/jump except at the existing ≤560px breakpoint's button/gap
     resize.
  8. Read the new captions under each row at actual (non-zoomed) size —
     confirm they're legible but clearly secondary/subtle, not competing
     with the primary controls.
  9. General text legibility pass across the sidebar — confirm the 1px
     bump is a genuine, noticeable improvement without breaking any
     existing tight layout (label wrapping, sliders' value readouts, etc).

## Known limitations

- Dock position is not persisted across page reloads (deliberate, see
  Non-goals).
- The grip-drag gesture has no `disabled`-during-recording gate (unlike
  the scrub/retime gestures) — this is intentional, not an oversight:
  repositioning the dock has no bearing on the recording/export pipeline.

## Post-implementation corrections (found in review, 2026-08-27)

**Code-quality review** found and fixed a plan-vs-implementation mismatch:
`pos` was originally local `useState` inside `TransportDock`, so hiding the
dock via either `showUI` (Ctrl+K) or the new `dockVisible` toggle — both of
which *unmount* the component rather than just CSS-hiding it — silently
reset the dragged position back to default, contradicting this doc's own
QA checklist item 5 (which describes the position surviving a toggle
round-trip). Fixed by lifting `pos`/`onPosChange` up into `App.tsx`
(`dockPos`/`setDockPos`) so it outlives the dock's own mount/unmount
cycles; still resets on an actual page reload, since `dockPos` itself
isn't persisted.

**Final holistic branch review** found and fixed a real Major issue this
doc's original "Non-goals" section underestimated: the sidebar `.panel`
(fixed 320px width, opaque, higher z-index, `position: absolute` at
`left: 0`) shares no visibility state independent of the dock — `TransportDock`
only ever renders when `showUI` is already true, so whenever the dock
exists, the panel is unavoidably on-screen too. The original
`clampToViewport` only bounded against the viewport, so dragging the dock
to hug the left edge (`x = 0`) was a fully legal position that could put
the *entire* dock underneath the panel on viewports up to ~352px wide (a
common mobile width, not a contrived edge case) — with zero exposed area
left to grab and no in-app recovery path short of a full reload (which
also discards the loaded video/keyframes, neither persisted).

Fixed by measuring `.panel`'s live width via
`getBoundingClientRect()` (with a `PANEL_WIDTH_FALLBACK = 320` constant as
a fallback, kept in sync with `index.css`'s `.panel { width: 320px }` by
hand — there's no shared source of truth between CSS and JS here) and
using it as the drag's left clamp bound whenever the panel is visible.
When the viewport is too narrow to fully avoid the panel, the clamp
degrades gracefully (`minX = Math.min(panelWidth, maxX)`) rather than
producing an inverted range — verified algebraically that this always
leaves a `.dock-grip`-width-spanning strip exposed and grabbable as long
as `innerWidth > panelWidth` (i.e. for any viewport where the app itself
is usable at all).

While implementing that fix, also found and fixed a pre-existing stale-
closure risk: `clampToViewport` reads `showUI` via closure but wasn't
memoized, and the resize-effect's dependency array didn't include it — a
resize occurring right after a `showUI` toggle (but before `pos` itself
changed) could have clamped against a stale panel-avoidance state. Fixed
by wrapping `clampToViewport` in `useCallback([showUI])` and depending on
that callback (rather than `showUI` directly) in the resize effect —
this also resolved a `react-hooks/exhaustive-deps` warning eslint raised
once the callback started reading `showUI`.

Also addressed a Nit: added an inline comment on `handleGripPointerDown`
explaining why there's no `disabled`-mid-gesture-clearing effect for the
grip drag (unlike the scrub/retime gestures) — the reasoning previously
only existed in this plan doc, not in the component itself.
