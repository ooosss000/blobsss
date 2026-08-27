# Per-parameter keyframe tracks (Premiere-style animated properties)

## Problem

The existing keyframe system is a single unified timeline where one
keyframe = a full snapshot of every `TrackerParams` field. There's no way
to animate one property (say, hue) independently of another (say, render
mode) — editing any field on a selected keyframe changes only that
keyframe's own snapshot, with no per-property timing or curve control.
The user wants Premiere-style "animated properties": specific parameters
get their own independent keyframe track, each segment able to hold flat
or blend, without touching the rest.

## Design (approved via conversational brainstorming, 2026-08-27 — written
directly per this project's established shortcut of skipping the separate
spec-doc-review step on quick conversational approval)

**Scope, decided via AskUserQuestion:**
- Only 9 fields get independent tracks: `brightness, contrast, saturation,
  hue, gamma, temperature, strokeColor, strokeWidth, renderMode`. Everything
  else (motion detection, density, labels, font, etc.) is untouched —
  still governed by the existing unified keyframe system exactly as today.
- Per-segment curve is a **hold/linear toggle**, not a full easing/bezier
  curve editor. `renderMode` never supports linear (no such thing as a
  blend between two enum strings) — its track is hold-only.

**Architecture: two independent systems, merged at resolve time.**
The unified `Keyframe[]` system (`keyframes.ts`, hold-based per the prior
commit) is untouched and keeps governing the ~19 non-animatable fields.
The 9 animatable fields get their own parallel per-parameter tracks
(`ParamTracks`, new). Each frame, the final `TrackerParams` is: start from
`resolveActiveParams(unifiedKeyframes, time, baseParams)` (the existing
snapshot resolver — this covers the 19 other fields correctly, and
provides the *fallback* value for any of the 9 animatable fields that
doesn't have its own track yet), then for each of the 9 keys that DOES
have track keyframes, override with that track's own resolved value.
A unified keyframe's own stored value for one of the 9 fields becomes
vestigial (never read) once that field has its own track — this is a
known, accepted simplification (see Known limitations) rather than a
type-level `Omit`, to avoid a much larger refactor of `Keyframe.params`'s
type and every call site that constructs one.

**Stopwatch toggle, Premiere-style, not auto-record-on-touch.** Each of
the 9 sidebar sliders gets a small clock/stopwatch icon button next to it:
- **Off (default):** the slider edits `params[key]` directly — completely
  unchanged from today's behavior. No track exists for this param.
- **Click to turn on:** creates the param's first keyframe at the current
  playhead time, with the slider's *current* value (so turning it on
  causes zero visible change) — mirrors Premiere's stopwatch exactly.
- **While on:** moving the slider edits the keyframe at the *current*
  time if one already exists there (within `MIN_KEYFRAME_GAP`, reusing
  the existing epsilon), otherwise it adds a new keyframe at the current
  time with the new value. This mirrors "park the playhead, then drag the
  parameter" — the standard NLE keyframing motion — and deliberately does
  NOT spam a new keyframe on every slider tick when parked between two
  existing keyframes (edits go to global `params[key]`... no — see Task 2
  for the exact precedence rule).
- **Click to turn off:** deletes every keyframe on that param's track,
  reverting fully to a single static value (`params[key]`, left at
  whatever it last was). Deliberately destructive-on-toggle-off, matching
  Premiere's own stopwatch-off behavior, rather than inventing a
  half-animated in-between state this codebase has no UI to represent.

**New UI: a collapsible "ANIMATED PARAMS" section in the TransportDock**,
not a separate panel and not additional always-visible rows — collapsed
by default, expands to show one thin row per param that currently has
≥1 keyframe on its track (a param with the stopwatch off, or on with zero
keyframes — impossible per the toggle-on behavior above, but zero after
toggling off — simply has no row). Each row reuses the existing
`.kf-track`/`.kf-marker` visual language (thin baseline line, diamonds)
at a smaller size, with click-to-select, drag-to-retime (reusing
`clampKeyframeTime`, generalized — see Task 1), double-click-to-add-at-
that-time-and-value, and a small "H/L" toggle for the *selected*
keyframe's outgoing curve (irrelevant, disabled, for `renderMode`'s row).

## Non-goals

- No full bezier/ease-in/ease-out curve editor — hold/linear only.
- No per-parameter track for anything outside the 9 listed fields.
- No persistence of any keyframe data (unified or per-param) across page
  reloads — matches all existing keyframe behavior, already ephemeral.
- Not changing `Keyframe.params`'s type to exclude the 9 animatable
  fields — they stay present but unread once a param has its own track
  (see Known limitations).
- Not changing the MP4 export capture loop's mechanics — it already calls
  the same live-params resolver every frame; only what that resolver
  computes changes.

## Implementation

### Task 1 — Data model + resolver (`src/keyframes.ts`, `src/keyframes.test.ts`)

- `clampKeyframeTime`'s first parameter type widens from `Keyframe[]` to
  `{ id: string; time: number }[]` (a compatible widening — `Keyframe`
  already satisfies this shape, so no existing call site changes) so the
  exact same, already-tested clamping algorithm serves both the unified
  timeline and every per-param track, rather than duplicating it.
- Re-add `hexToRgb`/`rgbToHex`/`lerpColor` (removed in the hold-based
  rewrite) — needed again here specifically for per-param track linear
  segments on `strokeColor`.
- New exports:
  ```ts
  export const ANIMATABLE_PARAM_KEYS = [
    'brightness', 'contrast', 'saturation', 'hue', 'gamma', 'temperature',
    'strokeColor', 'strokeWidth', 'renderMode',
  ] as const satisfies readonly (keyof TrackerParams)[];
  export type AnimatableParamKey = typeof ANIMATABLE_PARAM_KEYS[number];
  export type CurveType = 'hold' | 'linear';
  export interface ParamKeyframe {
    id: string;
    time: number;
    value: number | string; // number for numeric keys, string (hex or RenderMode) otherwise
    curve: CurveType; // interpolation OUT of this keyframe toward the next one on the same track
  }
  export type ParamTracks = Partial<Record<AnimatableParamKey, ParamKeyframe[]>>;

  export function resolveParamValue(
    track: ParamKeyframe[] | undefined,
    time: number,
    fallback: number | string,
  ): number | string { /* hold before first, hold after last; between two,
    kPrev.curve === 'hold' -> kPrev.value; 'linear' -> numeric lerp or
    lerpColor for '#'-prefixed strings; anything else (e.g. a RenderMode
    string erroneously marked 'linear') falls back to hold, defensively */ }

  export function resolveAnimatedParams(
    paramTracks: ParamTracks,
    time: number,
    base: TrackerParams,
  ): TrackerParams {
    const result = { ...base };
    for (const key of ANIMATABLE_PARAM_KEYS) {
      const track = paramTracks[key];
      if (track && track.length > 0) {
        (result[key] as number | string) = resolveParamValue(track, time, base[key] as number | string);
      }
    }
    return result;
  }
  ```
- New tests in `keyframes.test.ts` covering: hold segment (value stays at
  kPrev until kNext's exact time), linear numeric segment (midpoint lerp),
  linear color segment (channel-wise midpoint), before-first/after-last
  holding, a track with only one keyframe, `resolveAnimatedParams` leaving
  non-animatable fields alone and correctly falling back to `base[key]`
  for an animatable field with no track at all, and `clampKeyframeTime`
  still passing its existing suite unchanged (type widening only, no
  behavior change) — full existing 27-test suite must stay green plus
  the new cases.

### Task 2 — `src/App.tsx` wiring

- New state: `const [paramTracks, setParamTracks] = useState<ParamTracks>({});`
  and a ref mirror (`paramTracksRef`) following the same pattern as
  `keyframesRef`/`paramsRef`, for the same stale-closure reasons (read by
  `onMeta`'s tracker construction and the live-params-resolver effect).
- Merged resolver replaces the current one everywhere it's set:
  ```ts
  tracker.setLiveParamsResolver((t) => {
    const unified = keyframes.length > 0
      ? resolveActiveParams(keyframes, t, params)
      : params;
    return resolveAnimatedParams(paramTracks, t, unified);
  });
  ```
  (both the `onMeta`-time initial setup, using the ref-mirrored values, and
  the `[keyframes, params, paramTracks, videoSrc]`-dependent effect that
  already exists for the unified system — this effect's dependency array
  gains `paramTracks`.)
- New functions, following the existing `addKeyframe`/`deleteKeyframe`/
  `retimeKeyframe` naming and shape:
  - `toggleParamAnimation(key: AnimatableParamKey)`: if `paramTracks[key]`
    is empty/absent, creates one keyframe at `videoRef.current.currentTime`
    with value `params[key]` and `curve: 'hold'`. If it already has
    keyframes, deletes the whole track (`delete` the key, or set to `[]`
    then prune — either way, the row disappears from the UI per the
    "only show rows with keyframes" rule).
  - `setAnimatableParam(key: AnimatableParamKey, value: number | string)`:
    the sidebar slider's `onChange` for these 9 fields. Precedence rule
    (this is the one place needing a firm decision the design section
    above deferred): if `paramTracks[key]` has ANY keyframes (animation
    is on for this param), find a keyframe within `MIN_KEYFRAME_GAP` of
    `currentTime` — if found, update its `value` in place; if not found,
    add a new keyframe at `currentTime` with this `value` and
    `curve: 'hold'` (matching the default for a freshly-added keyframe;
    the user can flip it to linear afterward via the row's toggle). If
    `paramTracks[key]` is empty/absent (animation off), just
    `setParam(key, value)` exactly like every other non-animatable field
    today — zero behavior change for the common "just tweak a slider"
    case.
  - `retimeParamKeyframe(key, id, time)` / `deleteParamKeyframe(key, id)` /
    `setParamKeyframeCurve(key, id, curve)` — straightforward, mirroring
    the unified system's equivalents, operating on `paramTracks[key]`.
- Sidebar: for each of the 9 `BrutSlider`/`ColorRow`/mode-button controls
  (COLOR GRADE section's 6 sliders, VISUAL section's stroke color/width,
  and the render-mode button grid), the displayed `value` becomes
  `resolveParamValue(paramTracks[key], currentTime, params[key])` instead
  of reading through `displayParams[key]` — **this is intentionally
  decoupled from `selectedKeyframeId`/`displayParams`**, per the design
  section's "two independent systems" call: whether a unified keyframe is
  selected has no bearing on these 9 fields' displayed/edited value
  anymore. `onChange` for these 9 becomes `setAnimatableParam(key, v)`
  instead of `setDisplayParam(key, v)`. A small stopwatch icon (lucide
  `Clock`, already available in the project's icon set via `lucide-react`)
  sits next to each of the 9 controls, `onClick={() => toggleParamAnimation(key)}`,
  visually indicating on/off state (e.g. filled/accent when a track
  exists, outline/dim otherwise).

### Task 3 — New UI: collapsible "ANIMATED PARAMS" section

- New component `src/ParamTrackRow.tsx`: one row per animated param.
  Props: `label: string`, `paramKey: AnimatableParamKey`,
  `keyframes: ParamKeyframe[]`, `duration: number`, `selectedId: string
  | null`, `onSelect`, `onRetime`, `onDelete`, `onAddAt: (time: number) =>
  void`, `onSetCurve: (id: string, curve: CurveType) => void`, `disabled:
  boolean`. Visually: reuses `.kf-track`/`.kf-marker` CSS at a smaller
  height (a new `--param-track-h`, smaller than `--track-h`, e.g. ~14px)
  — no playhead needed per row (the dock's single shared timeline above
  already shows the playhead; repeating it in every row would be noisy).
  Gesture logic is a trimmed-down version of `TimelineBar`'s marker
  handling (drag-to-retime, double-click-to-add, no track-level seek at
  all — these rows never scrub video, only manage that param's own
  keyframes).
- New component `src/AnimatedParamsPanel.tsx` (or inline in
  `TransportDock.tsx` if it stays reasonably small — implementer's
  judgment): a collapsed-by-default section, header line "▸ ANIMATED
  PARAMS (N)" (N = count of params with ≥1 keyframe) that expands to
  stack one `ParamTrackRow` per animated param, each with its label, an
  H/L curve toggle for the currently-selected keyframe on that row (only
  enabled for non-`renderMode` rows), and a delete button for the
  selected keyframe.
- Wire into `TransportDock.tsx`: new props threaded through from
  `App.tsx` (`paramTracks`, `onRetimeParamKeyframe`,
  `onDeleteParamKeyframe`, `onSetParamKeyframeCurve`, `onAddParamKeyframeAt`,
  a per-row `selectedParamKeyframeId` map or similar — implementer's
  judgment on the cleanest shape, e.g. `Record<AnimatableParamKey, string
  | null>` state in `App.tsx` alongside `paramTracks`).

### Task 4 — Regression pass + manual QA

Full verification gate (`npx tsc -b`, `npx vitest run`, `npm run build`,
`npx eslint` on every touched file) plus a manual QA checklist covering:
toggling a param's stopwatch on/off, adding/retiming/deleting keyframes
on a param row, switching a segment between hold and linear and
confirming the visual actually blends vs. snaps, confirming the unified
timeline's own keyframes are completely unaffected by any of this,
confirming MP4 export reflects per-param animation correctly, and
confirming a param with no track still behaves exactly as it did before
this feature existed (global-only, `selectedKeyframeId`-driven like every
other non-animatable field).

## Known limitations

- A unified keyframe's own stored value for one of the 9 animatable
  fields becomes vestigial once that field has its own track — it's
  still present in the `Keyframe.params` object (unchanged type) but
  never read by the resolver. Accepted rather than reshaping
  `Keyframe.params`'s type, which would ripple into every call site that
  constructs a `Keyframe`.
- Turning a param's stopwatch off deletes all of its keyframes with no
  undo — matches Premiere's own behavior, but is a real, irreversible
  action with no confirmation dialog (kept out of scope — this app has no
  existing confirmation-dialog pattern to reuse, and adding one for this
  single case felt disproportionate; revisit if this bites someone).
- No bezier/ease curves — hold/linear only, per explicit scope decision.
- No persistence across reloads, same as every other keyframe in this app.
- Implementation note (fixed during review, documented for completeness):
  the sidebar's displayed/gating value for the 9 animatable fields
  (`animatedDisplay`/`activeRenderMode` in `App.tsx`) must fall back, for
  a field with no per-param track, to `resolveActiveParams(keyframes,
  currentTime, params)[key]` — the SAME unified-timeline resolution the
  live-preview/export resolver actually uses — not to raw `params[key]`.
  An earlier draft fell back to raw `params[key]` directly, which left the
  mode-grid highlight and the `ASCII_BOX`/`TRAIL_PATH`-gated control
  visibility frozen on the last direct edit instead of tracking whichever
  unified keyframe is actually active at the current scrub position, for
  any of the 9 fields left undriven by their own track. Fixed by computing
  `unifiedForDisplay` once (mirroring the resolver's own `unified` local)
  and using `unifiedForDisplay[key]` as `resolveParamValue`'s fallback.
