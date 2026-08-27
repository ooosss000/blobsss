import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ParamKeyframe, AnimatableParamKey, CurveType } from './keyframes';
import { clampKeyframeTime } from './keyframes';

interface ParamTrackRowProps {
  label: string;
  paramKey: AnimatableParamKey;
  keyframes: ParamKeyframe[];
  duration: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRetime: (id: string, time: number) => void;
  onDelete: (id: string) => void;
  /** Double-click on empty track space adds a keyframe at that time — mirrors TimelineBar's own convention. */
  onAddAt: (time: number) => void;
  onSetCurve: (id: string, curve: CurveType) => void;
  disabled: boolean;
}

/**
 * One thin keyframe track for a single animated parameter, shown inside the
 * ANIMATED PARAMS panel. Deliberately a trimmed-down TimelineBar: no
 * playhead (the dock's single shared timeline above already shows one; a
 * playhead in every row would be noisy) and no track-level scrub-to-seek —
 * these rows never move the video, only manage this one param's own
 * keyframes. The same gesture-safety rigor is still mirrored: a marker's
 * own pointerdown takes priority over anything else on the track
 * (stopPropagation), pointer capture is acquired on the marker itself (move/
 * up events still bubble to the track's own handlers per the DOM's pointer
 * capture semantics), and an in-flight drag is force-ended the instant
 * `disabled` flips true mid-gesture, since the CSS pointer-events:none
 * fallback can't stop an already-captured pointer.
 */
export function ParamTrackRow({
  label, paramKey, keyframes, duration, selectedId, onSelect, onRetime, onDelete, onAddAt, onSetCurve, disabled,
}: ParamTrackRowProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => {
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
    e.stopPropagation();
    if (disabled) return;
    if (e.button !== 0 || !e.isPrimary) return;
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

  const handleTrackDoubleClick = (e: React.MouseEvent) => {
    if (disabled) return;
    onAddAt(clientXToTime(e.clientX));
  };

  const selectedKf = selectedId ? keyframes.find(k => k.id === selectedId) : undefined;
  const curveDisabled = disabled || !selectedKf || paramKey === 'renderMode';

  return (
    <div className="anim-param-row">
      <div className="anim-param-row-head">
        <span>{label}</span>
        <div className="anim-param-row-controls">
          <button
            type="button"
            className={`curve-toggle-btn${selectedKf?.curve === 'linear' ? ' on' : ''}`}
            disabled={curveDisabled}
            onClick={() => selectedKf && onSetCurve(selectedKf.id, selectedKf.curve === 'linear' ? 'hold' : 'linear')}
            title={paramKey === 'renderMode' ? 'Render mode has no linear blend — hold only' : (selectedKf?.curve === 'linear' ? 'Linear — click for hold' : 'Hold — click for linear')}
          >
            {selectedKf?.curve === 'linear' ? 'LIN' : 'HOLD'}
          </button>
          <button
            type="button"
            className="anim-param-row-del"
            disabled={disabled || !selectedKf}
            onClick={() => selectedKf && onDelete(selectedKf.id)}
            title="Delete selected keyframe"
          >
            <X size={11} />
          </button>
        </div>
      </div>
      <div
        className={`kf-track param-track${disabled ? ' disabled' : ''}`}
        ref={trackRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onDoubleClick={handleTrackDoubleClick}
      >
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
              onSelect(k.id === selectedId ? null : k.id);
            }}
            onDoubleClick={e => e.stopPropagation()}
            title={`${k.time.toFixed(2)}s`}
          />
        ))}
      </div>
    </div>
  );
}
