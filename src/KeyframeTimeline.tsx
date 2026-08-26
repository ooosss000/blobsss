import { useEffect, useRef, useState } from 'react';
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
  /** Disables all track interaction (scrub, marker drag) — set during MP4 recording/encoding, matching the other export-adjacent controls in App.tsx. Scrubbing mid-recording would splice an arbitrary content jump into the capture while the encoder's synthetic timestamps stay smooth. */
  disabled: boolean;
}

export function KeyframeTimeline({
  keyframes, selectedId, currentTime, duration, onSelect, onDelete, onRetime, onSeek, disabled,
}: KeyframeTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const draggedRef = useRef(false);

  // Closes a gap a pointerdown guard alone can't: if disabled flips true
  // mid-gesture (pointer already down, capture already acquired — e.g. the
  // user starts scrubbing, then triggers Record while still holding the
  // pointer), the CSS `pointer-events: none` backup on .kf-track is inert
  // (an active pointer capture bypasses hit-testing), and handlePointerMove
  // would otherwise keep calling onSeek/onRetime for the rest of the
  // gesture. This effect ends the in-flight gesture the instant disabled
  // becomes true, independent of whether another pointer event ever
  // arrives. It doesn't release the OS-level pointer capture itself, but
  // that's fine — the browser releases it automatically on the next
  // pointerup, and with draggingId/scrubbing already cleared (plus the
  // disabled guard in handlePointerMove below), no further seeks/retimes
  // can happen even while capture is technically still held.
  useEffect(() => {
    // Self-terminating: only runs when `disabled` itself changes (not on
    // every render), and clearing gesture state here can't feed back into
    // `disabled` (an external prop), so there's no cascading-render risk —
    // this is the one-shot "external signal forces internal state to reset"
    // case the lint rule can't distinguish from an unbounded loop.
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
  const handlePointerCancel = () => { setDraggingId(null); setScrubbing(false); };

  return (
    <div className="kf-timeline">
      <div
        className={`kf-track${disabled ? ' disabled' : ''}`}
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
