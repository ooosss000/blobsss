# AR Tracking-Overlay Render Modes, Ellipse Fix & Transport Polish

Date: 2026-08-24

## Context

BlobSSS renders tracked video blobs in one of several `RenderMode`s
(`src/BlobTracker.ts`), all driven by the same `TrackedBlob[]` array and
`TrackerParams` object, all implemented as private methods on `BlobTracker`
and switched on in `renderBlobs()`. This spec adds three new render modes
inspired by photogrammetry/AR feature-tracking aesthetics (three reference
images supplied by the user — comet feature-detection callouts, an AR wire
scene with coordinate-tagged tracking reticles, and a dense triangulated
green mesh with per-node decimal coordinates), plus three small, unrelated
UI/rendering fixes bundled in because they touch the same files and ship
together:

1. `ELLIPSE` mode currently draws an oval whose aspect follows the blob's
   bounding-box aspect (`b.w*0.6, b.h*0.6`), which reads as visually
   "tilted"/distorted rather than a clean circle.
2. The transport overlay (play/pause/restart under the canvas) uses the
   same subtle, transparent `.icon-btn` style as panel buttons — low
   contrast against video, easy to miss.
3. Play/pause/restart exist in **two** places — the canvas transport
   overlay (added when keyframes/export-preview work landed) and the
   SOURCE panel section (pre-existing). Since the overlay is now always
   available whenever a video is loaded, the panel copies are redundant.

## Scope / non-goals

- No `TrackerParams` schema changes. All three new modes reuse existing
  params (`strokeColor`, `textColor`, `showCoordinates`, `showId`,
  `showSize`, `neighborLinks`, `fontSize`, `fontFamily`, `strokeWidth`).
  This means the keyframe interpolation system (`src/keyframes.ts`) needs
  **zero** changes — it already exhaustively partitions every
  `TrackerParams` field into numeric/color/discrete buckets, and adding a
  `RenderMode` value only touches the (already-discrete) `renderMode` key,
  not the field list.
- No new tunable "how many callouts" / "mesh density" params in this pass
  — each new mode uses a fixed, reasonable constant (documented per-mode
  below). Making those configurable is a natural follow-up, not required
  now.
- True Delaunay triangulation is explicitly rejected for Mode 3 (see
  below) in favor of reusing an existing, already-shipped algorithmic
  pattern.

## New render mode 1: `RECON_SCAN`

AR-tracker aesthetic (reference: wire/cable scene with dashed convergence
lines and coordinate-tagged reticles).

- **Reticle**: instead of a full stroked box or ellipse, draw 4 short
  corner brackets (small L-shapes) at the corners of each blob's bounding
  box — classic camera/AR tracking-marker look. Bracket arm length scales
  with `getS()` like other stroke geometry.
- **Convergence lines**: compute the centroid of all currently-tracked
  blobs once per frame; from each blob's center, draw a dashed line
  (`ctx.setLineDash([4, 4])` scaled by `getS()`) toward that shared
  centroid. This is O(n) — one shared point, not pairwise.
- **Labels**: reuse the existing `drawLabel` gating (`showCoordinates`/
  `showId`/`showSize`) but format the coordinate line as `x: N  y: N`
  (matching the reference's exact label style) instead of the default
  `N  N`. This is mode-specific formatting inside `drawLabel` (branch on
  `this.params.renderMode === 'RECON_SCAN'`), not a new param.
- **Sparkle nodes**: at the shared convergence point, draw a small
  4-point star/cross mark whose alpha pulses with `Math.sin` of an
  internal frame counter (purely decorative, no new state beyond a
  counter already implied by continuous rendering).
- **Cost**: O(n) per frame — same complexity class as `BOX_INVERT`.

## New render mode 2: `FEATURE_CALLOUT`

Photogrammetry-callout aesthetic (reference: comet surface with a handful
of leader-lined dimension callouts, not every feature labeled).

- Select the **3 largest blobs by area** (`b.area`, already tracked) —
  fixed constant, matching the reference images' sparse callout count.
  Fewer than 3 detected blobs just means fewer callouts.
- For each selected blob: draw a thin leader line from a corner of its
  bounding box to an offset inset panel (placed to avoid overlapping the
  blob itself and, best-effort, other callouts — simple fixed offset
  directions per rank, e.g. top-right/bottom-right/top-left, not a
  full collision solver).
- Inset panel: a small bordered box containing the dimension readout
  `WWW×HHH PX` (blob's `w`/`h`, real pixel units — honest about what's
  being measured, unlike the reference's fictional "m" units).
- **Cost**: fixed (≤3 callouts) regardless of total blob count —
  negligible.

## New render mode 3: `MESH_TRIANGULATE`

Dense feature-mesh aesthetic (reference: green triangulated mesh over a
rock surface with per-node decimal coordinates and small highlight
patches).

**Algorithm decision:** reuse the k-nearest-neighbor mesh pattern already
shipped in `renderCentroidNet`/`drawLinks` (each node connects to its
nearest K neighbors, found via per-node distance-sort — already O(n²) on a
blob count that's always small because it's capped by `maxBlobs`), rather
than implementing true Delaunay triangulation. Delaunay would give a
planar (non-crossing-edge) mesh closer to the reference's literal
appearance, but requires a real computational-geometry algorithm
(Bowyer-Watson or similar) implemented from scratch — meaningfully more
implementation risk for a decorative overlay, versus a pattern this
codebase has already proven correct and performant. K is set higher than
`CENTROID_NET`'s default neighbor count for a busier look (e.g.
`neighborLinks + 2`, straight lines instead of quadratic-bezier curves).

- **Mesh lines**: straight `moveTo`/`lineTo` per edge (cheaper than
  `CENTROID_NET`'s bezier), styled with `strokeColor` at reduced alpha.
- **Per-node labels**: decimal-precision coordinates,
  `X: 413.34  Y: 574.33` style (note: decimal, not integer, to match the
  reference's precision-instrument look — this is a mode-specific label
  format, same mechanism as `RECON_SCAN`'s `x:`/`y:` prefix).
- **Highlight patches**: a small stroked (not filled, to stay cheap —
  no per-node `getImageData` sampling) rectangle centered on each node.
- **Cost**: same O(n²) class as already-shipped `CENTROID_NET`/
  `drawLinks`, just a different K and straight vs. curved edges — no new
  complexity class introduced.

## Naming

All three follow the existing all-caps, param/concept-referencing
convention (`BOX_INVERT`, `CENTROID_NET`, `GHOST_TRAIL`, `TRAIL_PATH`):
`RECON_SCAN`, `FEATURE_CALLOUT`, `MESH_TRIANGULATE`.

## UI wiring

Add all three to the `MODES` array in `src/App.tsx` (same array that
already drives the RENDER MODE button grid) with short button labels
(`RECON`, `CALLOUT`, `MESH`), consistent with existing labels (`INVERT`,
`ASCII`, `OUTLN`, `NET`, `GHOST`, `ELLPS`, `PATH`).

## Bundled fix 1: `ELLIPSE` mode circle distortion

Change `renderEllipse`'s ellipse radii from `b.w*0.6, b.h*0.6` (and the
ring-scale loop's `b.w * ringScale, b.h * ringScale`) to use a single
radius derived from both dimensions (e.g. `Math.min(b.w, b.h) * 0.6` or an
average) so the shape is a true circle regardless of the blob's bounding-
box aspect ratio, rather than an oval whose eccentricity varies frame to
frame with blob shape.

## Bundled fix 2: transport control visibility

`.icon-btn`/`.btn-brut` today is transparent with a 1px border — fine
against the dark panel background, low-contrast against arbitrary video
content. Give `.transport-overlay .icon-btn` a semi-opaque dark background
and a larger size so it reads clearly against any video frame.

## Bundled fix 3: remove duplicate transport controls

Remove the play/pause + restart buttons from the SOURCE panel section
(`src/App.tsx`) — the canvas transport overlay already provides both
whenever a video is loaded, making the panel copies redundant.
`togglePlay`/`restart` functions stay (still used by the overlay and by
the canvas `onClick`), only their panel-section JSX buttons are removed.

**Correction found in code review:** the overlay's original render
condition (`!isRecording && !isEncoding`) hid it during recording — but
`.main-canvas.recording` sets `pointer-events: none`, so the canvas
`onClick` fallback is inert during recording too. Since the removed panel
buttons had no `isRecording` guard, they were the *only* working playback
control during recording, not a redundant copy — removing them stranded
anyone who started a recording while paused. Fixed by relaxing the
overlay's condition to `!isEncoding` only, so it stays visible (and
functional) throughout recording; it's safe to show since it's a DOM
sibling never composited into the captured canvas frames.

## Testing / verification

Same constraint as the prior keyframe-export work: no browser automation
is available in this environment. Verification is `tsc -b --noEmit`,
`npx vitest run` (existing 26 `keyframes.ts` tests — unaffected, since
this work doesn't touch that file), `npm run build`, and static code
review. Visual confirmation of all three new render modes, the ellipse
fix, and the button changes requires the user to check manually in a
running browser — flagged explicitly in the implementation plan's
verification steps, same as every prior task in this project.

## Out of scope / follow-ups

- Making callout count (Mode 2) or mesh K (Mode 3) user-configurable via
  a new `TrackerParams` field.
- True Delaunay triangulation for Mode 3, if the k-nearest approximation
  turns out visually insufficient after manual review.
- Applying the new modes' label-format overrides (`x: N y: N`, decimal
  coordinates) to any of the existing 7 modes.

**Found during final whole-branch review (2026-08-25), deliberately deferred
rather than fixed on this branch — each needs its own decision, not a
silent fix bundled into a review cycle:**

- **`FEATURE_CALLOUT` doesn't route through `drawLabel`/`drawLinks`**, so the
  LABELS panel's `showId`/`showCoordinates`/`showSize` toggles and the
  LINKS slider (`neighborLinks`) have no effect in this mode, even though
  they're visible and enabled in the panel while this mode is selected.
  This contradicts the Scope section above, which lists these as reused
  params. Two ways to resolve it: make the mode actually honor the
  toggles (e.g. build the panel text conditionally), or hide the
  LABELS/LINKS controls while this mode is active, the way `TRAIL_PATH`
  already hides the STROKE control. Needs a product decision, not an
  implementer's guess.
- **The file now has two idioms for "is this the primary/anchor blob,
  not a subdivide sub-blob"**: five pre-existing modes (and `toSVG`) use
  an id-magnitude heuristic (`id < 1000 || id % 1000 === 0`, or a
  stricter variant missing the `< 1000` clause on two of them) that
  silently breaks once the never-reset global blob-id counter exceeds
  1000 (~1 minute of active tracking); `MESH_TRIANGULATE` was fixed to
  use an explicit `subIndex` field instead. The pre-existing modes were
  left as-is (out of scope for this branch), but they have the identical
  latent bug `MESH_TRIANGULATE` was just fixed for. Follow-up: replace
  the id-heuristic at the remaining 5-6 call sites with `!b.subIndex`.
- **`LOAD VIDEO`/`CHANGE VIDEO` isn't disabled during recording or
  encoding** (`src/App.tsx`, SOURCE section) — pre-existing gap, but
  this branch rewrote that exact JSX block and it's now the only
  unguarded control in that row (every export control nearby already has
  `disabled={isRecording || isEncoding}`). Swapping the video source
  mid-recording desyncs the canvas from the encoder's configured
  dimensions and produces a silently truncated/corrupt MP4 with no error
  shown to the user.
- **Transport overlay can be visually occluded by the recording preview
  thumbnail below ~760px viewport width** — both are absolutely
  positioned, and the thumbnail's `z-index: 10000` beats the overlay's
  `z-index: 40` when they overlap. The overlay's buttons stay clickable
  throughout (the thumbnail has `pointer-events: none`), just harder to
  see. Cosmetic, narrow-viewport-only.
- **SVG export silently produces incomplete output for 5 of 10 render
  modes** now (`ASCII_BOX`, `GHOST_TRAIL`, and all 3 new modes have no
  `toSVG()` case) — the export button stays enabled and downloads a
  well-formed but visually wrong file (just the optional neighbor-link
  lines, nothing else) with no warning. At 2/10 this was an obscure
  corner; at 5/10 it's a coin flip. Cheapest fix if picked up later: gate
  the "Export SVG" button's `disabled`/tooltip on render mode rather than
  implementing the missing SVG cases.
