import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, ChevronLeft, ChevronRight, Plus, X, GripVertical } from 'lucide-react';
import type { Keyframe } from './keyframes';
import { VideoScrubBar } from './VideoScrubBar';
import { KeyframeBar } from './KeyframeBar';

interface TransportDockProps {
  isPaused: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  keyframes: Keyframe[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onRetime: (id: string, time: number) => void;
  onAddKeyframe: () => void;
  disabled: boolean;
  /**
   * null = use the default CSS position (bottom-center); otherwise explicit
   * viewport-relative coordinates. Lifted to the parent (rather than local
   * state) so a dragged position survives the dock being hidden and
   * re-shown via either the Ctrl+K (`showUI`) or "SHOW TRANSPORT DOCK"
   * toggle — both unmount this component rather than just hiding it via
   * CSS, which would otherwise silently reset local state back to null on
   * every re-show. Still resets to null on an actual page reload, since
   * the parent's own state isn't persisted either.
   */
  pos: { x: number; y: number } | null;
  onPosChange: (pos: { x: number; y: number } | null) => void;
  /** Whether the sidebar panel is currently shown — used to keep the dock from being dragged underneath it (see clampToViewport). */
  showUI: boolean;
}

// Mirrors App.tsx's own fmtTime — kept as a small local copy rather than a
// shared util for one function used in two places (YAGNI); revisit if a
// third call site appears.
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

const JUMP_EPS = 0.01;

// The sidebar panel's own CSS width (src/index.css, .panel) — used as a
// fallback if the panel element can't be measured directly (e.g. it hasn't
// painted yet). Kept in sync manually since there's no shared source of
// truth between CSS and JS here; if .panel's width ever changes, update
// this too.
const PANEL_WIDTH_FALLBACK = 320;

export function TransportDock({
  isPaused, onTogglePlay, onRestart, currentTime, duration, onSeek,
  keyframes, selectedId, onSelect, onDelete, onRetime, onAddKeyframe, disabled,
  pos, onPosChange, showUI,
}: TransportDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Keeps a dragged-to position on-screen if the window is resized smaller
  // afterward (e.g. the dock was dragged near the right edge, then the
  // browser window is narrowed) — re-clamps against the dock's current
  // measured size, not a stale one from drag-start time.
  //
  // Also keeps the dock from being dragged underneath the sidebar panel
  // when it's visible: the panel is a fixed-width, opaque, higher-z-index
  // column pinned to the left edge, sharing no visibility state with the
  // dock (dockVisible only ever hides the dock IN ADDITION TO showUI,
  // never independent of it) — so once dragged behind it, the dock has no
  // exposed area left to grab on a narrow viewport, with no in-app way to
  // recover short of a full reload (which also discards the loaded video).
  // Measuring the real element (rather than trusting a hardcoded width)
  // stays correct even if .panel's own CSS width is changed later.
  const clampToViewport = useCallback((x: number, y: number) => {
    const el = dockRef.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    const panelWidth = showUI
      ? (document.querySelector('.panel')?.getBoundingClientRect().width ?? PANEL_WIDTH_FALLBACK)
      : 0;
    // If the viewport is too narrow to avoid the panel at all, fall back to
    // the plain viewport clamp rather than producing an inverted [min, max]
    // range — the dock ends up as far right as geometrically possible.
    const minX = Math.min(panelWidth, maxX);
    return { x: Math.min(Math.max(minX, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, [showUI]);

  useEffect(() => {
    const onResize = () => { if (pos) onPosChange(clampToViewport(pos.x, pos.y)); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [pos, onPosChange, clampToViewport]);

  // No disabled-mid-gesture-clearing effect here, unlike VideoScrubBar's
  // scrubbing/KeyframeBar's draggingId — repositioning the dock has no
  // bearing on the recording/export pipeline, so there's nothing unsafe
  // about letting an in-flight grip drag finish even if `disabled` (or a
  // recording) starts mid-drag.
  const handleGripPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const el = dockRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handleGripPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    onPosChange(clampToViewport(e.clientX - dragOffset.current.x, e.clientY - dragOffset.current.y));
  };

  const handleGripPointerUp = () => setDragging(false);

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const prevKf = [...sorted].reverse().find(k => k.time < currentTime - JUMP_EPS);
  const nextKf = sorted.find(k => k.time > currentTime + JUMP_EPS);

  const jumpTo = (kf: Keyframe) => { onSeek(kf.time); onSelect(kf.id); };

  const selectedKf = selectedId ? keyframes.find(k => k.id === selectedId) : undefined;
  const statusText = selectedKf ? `EDITING KEYFRAME @ ${fmtTime(Math.floor(selectedKf.time))}` : 'EDITING LIVE';

  return (
    <div
      ref={dockRef}
      className="transport-dock"
      style={pos ? { left: pos.x, top: pos.y, bottom: 'auto', transform: 'none' } : undefined}
    >
      <div
        className="dock-grip"
        onPointerDown={handleGripPointerDown}
        onPointerMove={handleGripPointerMove}
        onPointerUp={handleGripPointerUp}
        onPointerCancel={handleGripPointerUp}
        onLostPointerCapture={handleGripPointerUp}
        title="Drag to move"
      >
        <GripVertical size={14} />
      </div>

      <div className="dock-row">
        <button className="btn-brut icon-btn" onClick={onTogglePlay} disabled={disabled}>
          {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
        </button>
        <button className="btn-brut icon-btn" onClick={onRestart} disabled={disabled} title="Restart">
          <RotateCcw size={14} />
        </button>
        <VideoScrubBar currentTime={currentTime} duration={duration} onSeek={onSeek} disabled={disabled} />
        <span className="dock-time">{fmtTime(Math.floor(currentTime))} / {fmtTime(Math.floor(duration))}</span>
      </div>
      <div className="dock-caption">DRAG TO SEEK</div>

      <div className="dock-row">
        <button
          className="btn-brut icon-btn"
          onClick={() => prevKf && jumpTo(prevKf)}
          disabled={disabled || !prevKf}
          title="Jump to previous keyframe"
        >
          <ChevronLeft size={14} />
        </button>
        <KeyframeBar
          keyframes={keyframes}
          selectedId={selectedId}
          currentTime={currentTime}
          duration={duration}
          onSelect={onSelect}
          onRetime={onRetime}
          disabled={disabled}
        />
        <button
          className="btn-brut icon-btn"
          onClick={() => nextKf && jumpTo(nextKf)}
          disabled={disabled || !nextKf}
          title="Jump to next keyframe"
        >
          <ChevronRight size={14} />
        </button>
        <button className="btn-brut icon-btn" onClick={onAddKeyframe} disabled={disabled} title="Add keyframe">
          <Plus size={14} />
        </button>
        {selectedId && (
          <button className="btn-brut icon-btn" onClick={() => onDelete(selectedId)} disabled={disabled} title="Delete keyframe">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="dock-caption">CLICK MARKER TO SELECT · DRAG TO RETIME</div>

      <div className="dock-status">{statusText}</div>
    </div>
  );
}
