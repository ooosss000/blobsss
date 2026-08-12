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
}

export function KeyframeTimeline({
  keyframes, selectedId, currentTime, duration, onSelect, onDelete, onRetime,
}: KeyframeTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggedRef = useRef(false);

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  const clientXToTime = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const handlePointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setDraggingId(id);
    draggedRef.current = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingId) return;
    draggedRef.current = true;
    const proposed = clientXToTime(e.clientX);
    onRetime(draggingId, clampKeyframeTime(keyframes, draggingId, proposed, duration));
  };

  const handlePointerUp = () => setDraggingId(null);
  const handlePointerCancel = () => setDraggingId(null);

  return (
    <div className="kf-timeline">
      <div
        className="kf-track"
        ref={trackRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <div className="kf-playhead" style={{ left: `${pct(currentTime)}%` }} />
        {keyframes.map(k => (
          <div
            key={k.id}
            className={`kf-marker${k.id === selectedId ? ' selected' : ''}`}
            style={{ left: `${pct(k.time)}%` }}
            onPointerDown={handlePointerDown(k.id)}
            onLostPointerCapture={handlePointerUp}
            onClick={e => {
              e.stopPropagation();
              if (draggedRef.current) { draggedRef.current = false; return; }
              onSelect(k.id === selectedId ? null : k.id);
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
