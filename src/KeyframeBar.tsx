import { useEffect, useRef, useState } from 'react';
import type { Keyframe } from './keyframes';
import { clampKeyframeTime } from './keyframes';

interface KeyframeBarProps {
  keyframes: Keyframe[];
  selectedId: string | null;
  currentTime: number;
  duration: number;
  onSelect: (id: string | null) => void;
  onRetime: (id: string, time: number) => void;
  /** Disables marker interaction — set during MP4 recording/encoding, matching the other export-adjacent controls in App.tsx. */
  disabled: boolean;
}

/**
 * Keyframe marker strip. Unlike the old combined KeyframeTimeline, this bar
 * has no track-level click-to-seek at all — video navigation lives entirely
 * in the separate VideoScrubBar. That split removes the marker-vs-track
 * gesture conflict the old component needed dedicated fixes for; the only
 * interactive elements here are the markers themselves.
 */
export function KeyframeBar({
  keyframes, selectedId, currentTime, duration, onSelect, onRetime, disabled,
}: KeyframeBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggedRef = useRef(false);

  // Closes a gap a pointerdown guard alone can't: if disabled flips true
  // mid-gesture (pointer already down, capture already acquired), the CSS
  // `pointer-events: none` backup is inert (an active pointer capture
  // bypasses hit-testing), and handlePointerMove would otherwise keep
  // calling onRetime for the rest of the gesture. This effect ends the
  // in-flight gesture the instant disabled becomes true, independent of
  // whether another pointer event ever arrives.
  useEffect(() => {
    // Self-terminating: only runs when `disabled` itself changes (not on
    // every render), and clearing gesture state here can't feed back into
    // `disabled` (an external prop), so there's no cascading-render risk.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (disabled) setDraggingId(null);
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
    if (disabled) return;
    setDraggingId(id);
    draggedRef.current = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (disabled || !draggingId) return;
    draggedRef.current = true;
    const proposed = clientXToTime(e.clientX);
    onRetime(draggingId, clampKeyframeTime(keyframes, draggingId, proposed, duration));
  };

  const handlePointerUp = () => setDraggingId(null);

  return (
    <div
      className={`kf-track${disabled ? ' disabled' : ''}`}
      ref={trackRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
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
  );
}
