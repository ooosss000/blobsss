# Video Timeline Scrubbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user click or drag anywhere on the existing KEYFRAMES timeline track to seek the loaded video, without disturbing the track's existing keyframe-marker drag/select/delete behavior.

**Architecture:** The `KeyframeTimeline` component already renders a track with a live playhead (`currentTime`/`duration` props) and draggable keyframe markers. This adds one new prop (`onSeek: (time: number) => void`) and a second, independent pointer-capture gesture on the track element itself (not the markers) — since marker `pointerdown` handlers already call `stopPropagation()`, a pointerdown that reaches the track's own handler unambiguously means the user grabbed empty track, not a marker, so there's no gesture conflict to resolve.

**Tech Stack:** React + TypeScript, Pointer Events (same pattern already used for marker dragging).

---

## Task 1: Add scrub-to-seek on the timeline track

**Files:**
- Modify: `src/KeyframeTimeline.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`

- [ ] **Step 1: Add the `onSeek` prop and track-level scrubbing gesture**

In `src/KeyframeTimeline.tsx`, replace the entire file with:

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
  onSeek: (time: number) => void;
}

export function KeyframeTimeline({
  keyframes, selectedId, currentTime, duration, onSelect, onDelete, onRetime, onSeek,
}: KeyframeTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const draggedRef = useRef(false);

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  const clientXToTime = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const handleMarkerPointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setDraggingId(id);
    draggedRef.current = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handleTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    // Only reaches here if no marker's own pointerdown already
    // stopPropagation()'d — i.e. the user grabbed empty track, not a marker.
    setScrubbing(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSeek(clientXToTime(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (draggingId) {
      draggedRef.current = true;
      const proposed = clientXToTime(e.clientX);
      onRetime(draggingId, clampKeyframeTime(keyframes, draggingId, proposed, duration));
    } else if (scrubbing) {
      onSeek(clientXToTime(e.clientX));
    }
  };

  const handlePointerUp = () => { setDraggingId(null); setScrubbing(false); };
  const handlePointerCancel = () => { setDraggingId(null); setScrubbing(false); };

  return (
    <div className="kf-timeline">
      <div
        className="kf-track"
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerUp}
      >
        <div className="kf-playhead" style={{ left: `${pct(currentTime)}%` }} />
        {keyframes.map(k => (
          <div
            key={k.id}
            className={`kf-marker${k.id === selectedId ? ' selected' : ''}`}
            style={{ left: `${pct(k.time)}%` }}
            onPointerDown={handleMarkerPointerDown(k.id)}
            onLostPointerCapture={handlePointerUp}
            onClick={e => {
              e.stopPropagation();
              if (draggedRef.current) { draggedRef.current = false; return; }
              if (k.id === selectedId) return; // keep a keyframe selected while any exist — deselecting would silently disable panel edits (resolver overrides global params every frame)
              onSelect(k.id);
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

(Only the `onSeek` prop, `scrubbing` state, `handleTrackPointerDown`, the `else if (scrubbing)` branch in `handlePointerMove`, the `setScrubbing(false)` calls in `handlePointerUp`/`handlePointerCancel`, and the new `onPointerDown={handleTrackPointerDown}` on `.kf-track` are new — everything else is unchanged from the current file, renamed `handlePointerDown` → `handleMarkerPointerDown` for clarity since there are now two distinct pointerdown handlers.)

- [ ] **Step 2: Wire a `seekTo` handler in `App.tsx` and pass it in**

In `src/App.tsx`, find the existing `restart` function:

```tsx
  const restart = () => {
    if (videoRef.current) videoRef.current.currentTime = 0;
  };
```

Add a new function right after it:

```tsx
  const restart = () => {
    if (videoRef.current) videoRef.current.currentTime = 0;
  };

  const seekTo = (time: number) => {
    if (videoRef.current) videoRef.current.currentTime = time;
  };
```

Then find the `<KeyframeTimeline` usage:

```tsx
                  <KeyframeTimeline
                    keyframes={keyframes}
                    selectedId={selectedKeyframeId}
                    currentTime={currentTime}
                    duration={duration}
                    onSelect={setSelectedKeyframeId}
                    onDelete={deleteKeyframe}
                    onRetime={retimeKeyframe}
                  />
```

Replace with:

```tsx
                  <KeyframeTimeline
                    keyframes={keyframes}
                    selectedId={selectedKeyframeId}
                    currentTime={currentTime}
                    duration={duration}
                    onSelect={setSelectedKeyframeId}
                    onDelete={deleteKeyframe}
                    onRetime={retimeKeyframe}
                    onSeek={seekTo}
                  />
```

(Setting `videoRef.current.currentTime` directly already triggers the existing `seeked`/`timeupdate` listeners in the video-lifecycle effect — which already update `currentTime` state and repaint the canvas via `renderOnce()` if paused — so no other wiring is needed for the playhead or preview to reflect the new position.)

- [ ] **Step 3: Update the track's CSS — cursor affordance and touch-drag fix**

In `src/index.css`, find:

```css
.kf-track {
  position: relative;
  height: 28px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  cursor: default;
}
```

Replace with:

```css
.kf-track {
  position: relative;
  height: 28px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
```

(`cursor: pointer` replaces `default` since the track is no longer inert — it's now the primary seek control. `touch-action: none` is required for the same reason it was already added to `.kf-marker` in an earlier feature: without it, a touch-drag on the track can be claimed by the panel's `overflow-y: auto` scroll behavior instead of reaching this component's pointer handlers, silently breaking the drag mid-gesture on touch devices. `user-select: none` prevents a drag that starts on the track from also selecting surrounding panel text.)

Also, in the same file, find the `.kf-marker` rule and add a hit-target-extending pseudo-element right after it — before this change, missing the 10px marker by a few pixels did nothing (the track was inert); now it starts a scrub and jumps the video, so the marker's hit target needs to be meaningfully larger than its visual size:

```css
.kf-marker::before {
  content: '';
  position: absolute;
  left: 50%; top: 50%;
  width: 20px; height: 28px;
  transform: translate(-50%, -50%) rotate(-45deg);
}
```

(Pseudo-element pointer events are attributed to the originating element, so `.kf-marker`'s own `onPointerDown` still fires when the pseudo-element is hit — this doesn't change the marker's visual size or add a new interactive element.)

- [ ] **Step 4: Verify it compiles and builds**

Run: `npx tsc -b --noEmit`
Expected: no errors.

Run: `npm run build` (use a timeout of at least 60000ms — a `vite build` hang has been observed in some sandboxed environments for unrelated reasons; if it hangs past ~90 seconds, note that clearly as an environment issue, but try a normal run first)
Expected: clean build.

Run: `npx vitest run`
Expected: unaffected, all existing tests still pass (this task doesn't touch `keyframes.ts` or its tests).

- [ ] **Step 5: Commit**

```bash
git add src/KeyframeTimeline.tsx src/App.tsx src/index.css
git commit -m "feat: add click/drag-to-seek on the keyframe timeline track"
```

**Correction found in final whole-branch holistic review (2026-08-26), fixed
on this branch — two Major issues, plus one Minor folded into the same fix:**

- **Major: scrub-while-paused left stale blob/trail overlays on the wrong
  frame.** `seekTo` sets `videoRef.current.currentTime` directly, which
  fires `seeked` → `renderOnce()` when paused (pre-existing machinery from
  an earlier feature). But `BlobTracker.renderOnce()` only redraws the
  video frame and calls `renderBlobs()` — it never re-runs detection or
  clears `this.blobs`/`this.prevData`/per-blob `trail` arrays. Every paused
  scrub was redrawing the new frame with blob boxes/labels/trails computed
  at the OLD time — worst in GHOST_TRAIL/TRAIL_PATH, where a stale trail
  got smeared across an unrelated frame, defeating the plan's own stated
  use case (scrub-while-paused to verify keyframe placement). Fixed by
  adding `public resetTracking()` to `BlobTracker.ts` (clears `this.blobs`
  and `this.prevData`; per-blob trails live inside the discarded blob
  objects so clearing `blobs` clears them too) and calling it
  unconditionally from the `seeked` handler in `App.tsx`, before the
  paused-only `renderOnce()` call — unconditionally (not just when paused)
  so `prevData` doesn't stay stale for the very next `processFrame()`
  after a scrub-while-playing either. This also resolves, for free, the
  one-frame spurious-blob glitch that scrubbing during playback caused
  (same root cause: stale `prevData` diffed against the post-seek frame).
- **Major: nothing disabled scrubbing during an active recording.** Every
  other export-adjacent control (resolution select, PNG/SVG export, record
  button) is gated with `disabled={isRecording || isEncoding}`, but the new
  `KeyframeTimeline` track had no such guard. The MP4 capture loop assigns
  strictly-monotonic synthetic timestamps regardless of the video's actual
  `currentTime`, so a click/drag on the timeline mid-recording could splice
  an arbitrary content jump (or backward jump) into the capture while
  exported timestamps stayed smooth — a hard un-flagged jump-cut in the
  output. Fixed by adding a required `disabled: boolean` prop to
  `KeyframeTimeline`, passed as `isRecording || isEncoding` from `App.tsx`;
  `handleTrackPointerDown` and `handleMarkerPointerDown` both early-return
  before any state mutation or `setPointerCapture` when disabled (retiming
  can therefore never fire either, since dragging can never start). A new
  `.kf-track.disabled` CSS rule (`pointer-events: none`, dimmed opacity,
  `cursor: not-allowed`) makes the state visible and — since `pointer-events`
  is inherited and markers don't override it — also blocks marker
  interaction at the DOM level as a second line of defense on top of the
  JS guards.

**Known minor inefficiency, found in the same review, not fixed on this
branch:** each paused `onSeek` now double-renders — once directly from the
`seeked` listener's `renderOnce()` call, once again from the pre-existing
"repaint paused preview" effect (`App.tsx`) that also depends on
`currentTime`. Wasteful during a continuous drag-scrub but not incorrect;
removing either call risks disturbing the pre-existing effect's other
responsibilities (repainting after param/keyframe edits unrelated to
seeking), so it was left alone rather than risk a change outside this
task's scope for a performance-only concern.

---

## Task 2: Regression pass

**Files:** none (verification only)

- [ ] **Step 1: Build check**

Run: `npm run build`
Expected: clean.

- [ ] **Step 2: Lint check**

Run: `npx eslint src/App.tsx src/KeyframeTimeline.tsx 2>&1 | tail -30`
Expected: no new errors beyond the pre-existing baseline (19 errors as of the last merged feature branch — compare against that; flag only genuinely new ones).

- [ ] **Step 3: Unit test suite**

Run: `npx vitest run`
Expected: unaffected (this feature doesn't touch `keyframes.ts`).

- [ ] **Step 4: Static/code-level regression check (no browser automation)**

1. Confirm the marker's `onPointerDown` handler still calls `e.stopPropagation()` — this is the entire mechanism that prevents the new track-level scrub gesture from firing when the user actually grabs a marker. If this ever gets removed/refactored, scrubbing and marker-dragging would fire simultaneously.
2. Confirm `onSeek`/`seekTo` only ever sets `videoRef.current.currentTime` — it must not touch `isPaused`, play state, or call `.play()`/`.pause()`. Scrubbing should never change whether the video is playing.
3. Grep for any other place that might need the new `onSeek` prop (there should be exactly one `<KeyframeTimeline` usage in the codebase).
4. Confirm `git diff main...HEAD --stat` shows only the expected 3 files.

- [ ] **Step 5: Manual visual verification (requires a human — no browser automation in this environment)**

Run `npm run dev`, load a video, and check:
1. Click anywhere on the KEYFRAMES timeline track (not on a marker) — confirm the video jumps to that position and the playhead moves there.
2. Click-and-drag across the track — confirm the video scrubs smoothly as you drag, playhead tracking your pointer.
3. While the video is playing, scrub the track — confirm playback continues from the new position after you release (doesn't auto-pause, matches how RESTART already behaves).
4. While the video is paused, scrub the track — confirm the canvas preview visibly updates to show the frame at the new position (this exercises the existing `seeked`→`renderOnce()` machinery from an earlier feature).
5. With one or more keyframes placed, drag a keyframe marker — confirm this still only retimes that keyframe and does NOT also scrub the video (i.e. confirm issue 4.1 above holds in practice, not just in theory).
6. Click a keyframe marker (without dragging) — confirm it still selects/deselects correctly, unaffected by the new track-level handler.
7. If a touch device or touch emulation is available, drag on the track — confirm the drag doesn't get interrupted by the panel scrolling instead.
8. Right-click the track — confirm it doesn't seek/scrub, just opens the normal context menu (fixed in code review).
9. Start a drag on the track, alt-tab away mid-drag, then tab back and hover the mouse over the track without pressing anything — confirm the video does NOT start seeking on its own (fixed in code review via `onLostPointerCapture`).
10. Try to click a keyframe marker while aiming slightly off (a few px above/below/beside it) — confirm it either selects the marker or does nothing, and does NOT jump the video to that spot (the marker's hit target was enlarged in code review to reduce this).
11. **Known limitation, found in code review, not fixed on this branch:** scrubbing the track WHILE the video is playing may show the playhead briefly jitter between your scrub position and the advancing playback position, since `timeupdate` keeps firing from the live playback position during the drag. Confirm whether this is noticeable/objectionable enough to warrant suppressing `timeupdate`-driven state updates while actively scrubbing.
12. **Known limitation, found in code review, not fixed on this branch:** with two simultaneous touch points (e.g. one finger dragging a marker, a second finger tapping the track), the second finger's release can prematurely end the first finger's drag, since pointer state isn't tracked per-`pointerId`. Low priority — note if reachable in practice on your test device.

Expected: all of the above behave as described, no console errors, no regression in existing keyframe marker behavior.

- [ ] **Step 6: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "chore: final regression fixes for timeline scrubbing"
```

(Skip this commit if Steps 1-5 required no changes.)
