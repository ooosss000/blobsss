import { useEffect, useRef, useState } from 'react';
import type { Keyframe } from './keyframes';
import { clampKeyframeTime } from './keyframes';

interface TimelineBarProps {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  keyframes: Keyframe[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRetime: (id: string, time: number) => void;
  /** Double-click on empty track space adds a keyframe at that time — an alternative to the dock's ADD button, mirroring the double-click-to-add-marker convention in most video editor timelines. */
  onAddKeyframeAt: (time: number) => void;
  /** Disables all track interaction — set during MP4 recording/encoding, matching the other export-adjacent controls in App.tsx. */
  disabled: boolean;
}

/**
 * Single combined timeline: click/drag anywhere on the track to seek the
 * video, with keyframe diamonds sitting on the same baseline line. A
 * marker's own pointerdown takes priority over the track's scrub gesture
 * (stopPropagation — the marker's handler runs first since markers are
 * DOM descendants of the track, and stopping propagation there prevents
 * the track's own pointerdown from also firing for the same event).
 *
 * This was previously split into two separate bars (a scrub-only
 * VideoScrubBar and a marker-only KeyframeBar) to eliminate the gesture
 * conflict between "grabbed a marker" and "grabbed empty track" — that
 * safety logic (button/isPrimary guard, stopPropagation, onLostPointerCapture,
 * disabled-mid-gesture clearing) is reinstated here, now serving one bar
 * instead of two, per a later request to combine them back into a single
 * timeline for tighter control.
 */
export function TimelineBar({
  currentTime, duration, onSeek, keyframes, selectedId, onSelect, onRetime, onAddKeyframeAt, disabled,
}: TimelineBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const draggedRef = useRef(false);

  // Closes a gap a pointerdown guard alone can't: if disabled flips true
  // mid-gesture (pointer already down, capture already acquired), the CSS
  // `pointer-events: none` backup is inert (an active pointer capture
  // bypasses hit-testing), and handlePointerMove would otherwise keep
  // calling onRetime/onSeek for the rest of the gesture. This effect ends
  // the in-flight gesture the instant disabled becomes true, independent
  // of whether another pointer event ever arrives.
  useEffect(() => {
    // Self-terminating: only runs when `disabled` itself changes (not on
    // every render), and clearing gesture state here can't feed back into
    // `disabled` (an external prop), so there's no cascading-render risk.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (disabled) { setDraggingId(null); setScrubbing(false); }
  }, [disabled]);

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
    if (disabled) return;
    setDraggingId(id);
    draggedRef.current = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handleTrackPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    if (e.button !== 0 || !e.isPrimary) return;
    // Only reaches here if no marker's own pointerdown already
    // stopPropagation()'d — i.e. the user grabbed empty track, not a marker.
    setScrubbing(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSeek(clientXToTime(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (disabled) return;
    if (draggingId) {
      draggedRef.current = true;
      const proposed = clientXToTime(e.clientX);
      onRetime(draggingId, clampKeyframeTime(keyframes, draggingId, proposed, duration));
    } else if (scrubbing) {
      onSeek(clientXToTime(e.clientX));
    }
  };

  const handlePointerUp = () => { setDraggingId(null); setScrubbing(false); };

  const handleTrackDoubleClick = (e: React.MouseEvent) => {
    if (disabled) return;
    onAddKeyframeAt(clientXToTime(e.clientX));
  };

  return (
    <div
      className={`kf-track${disabled ? ' disabled' : ''}`}
      ref={trackRef}
      onPointerDown={handleTrackPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      onDoubleClick={handleTrackDoubleClick}
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
          onDoubleClick={e => e.stopPropagation()}
          title={`${k.time.toFixed(2)}s`}
        />
      ))}
    </div>
  );
}
