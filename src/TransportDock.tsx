import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, ChevronLeft, ChevronRight, Plus, X, GripVertical } from 'lucide-react';
import type { Keyframe } from './keyframes';
import { TimelineBar } from './TimelineBar';

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
   * re-shown via the "SHOW TRANSPORT DOCK" toggle/Ctrl+L, which unmounts
   * this component rather than just hiding it via CSS — that would
   * otherwise silently reset local state back to null on every re-show.
   * Still resets to null on an actual page reload, since the parent's own
   * state isn't persisted either.
   */
  pos: { x: number; y: number } | null;
  onPosChange: (pos: { x: number; y: number } | null) => void;
  /** Hides the dock — Ctrl+L, separate from Ctrl+K which hides the sidebar. Also reachable by clicking the label this renders, mirroring the sidebar's "⌃K HIDE" text. */
  onHide: () => void;
  /** Whether the sidebar panel is currently shown. Purely a layout input now (Ctrl+K no longer hides the dock) — the dock's default (undragged) position/width shifts clear of the panel's column when it's open, and expands to use the freed width when it's closed. */
  showUI: boolean;
}

// Mirrors App.tsx's own fmtTime — kept as a small local copy rather than a
// shared util for one function used in two places (YAGNI); revisit if a
// third call site appears.
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

const JUMP_EPS = 0.01;

// M:SS.mmm — millisecond precision for the editable timecode readout,
// distinct from fmtTime's coarser M:SS (used for the status line, where
// keyframe times don't need sub-second precision).
const fmtTimecode = (s: number) => {
  const totalMs = Math.max(0, Math.round(s * 1000));
  const mm = Math.floor(totalMs / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${mm}:${ss.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
};

// Accepts M:SS, M:SS.m, M:SS.mm, or M:SS.mmm (partial millisecond digits are
// treated as the leading digits of a 3-digit value, e.g. ".5" -> 500ms, not
// 5ms — matches how a user typing left-to-right would expect it to round).
// Returns null for anything that doesn't parse, so the caller can silently
// ignore an invalid edit rather than needing dedicated error UI.
const parseTimecode = (input: string): number | null => {
  const match = input.trim().match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const mm = parseInt(match[1], 10);
  const ss = parseInt(match[2], 10);
  if (ss >= 60) return null;
  const ms = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
  return mm * 60 + ss + ms / 1000;
};

interface TimecodeDisplayProps {
  time: number;
  duration: number;
  onSeek: (t: number) => void;
  disabled: boolean;
}

// Click the readout to type an exact M:SS.mmm position, Premiere-style —
// Enter commits (seeking, clamped to [0, duration]), Escape or blur without
// a valid parse just reverts to the display, discarding the draft.
function TimecodeDisplay({ time, duration, onSeek, disabled }: TimecodeDisplayProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  const startEdit = () => {
    if (disabled) return;
    setDraft(fmtTimecode(time));
    setEditing(true);
  };

  const commit = () => {
    const parsed = parseTimecode(draft);
    if (parsed !== null) onSeek(Math.min(Math.max(0, parsed), duration));
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="dock-timecode-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <span className="dock-time" onClick={startEdit} title="Click to enter an exact time">
      {fmtTimecode(time)} / {fmtTimecode(duration)}
    </span>
  );
}

export function TransportDock({
  isPaused, onTogglePlay, onRestart, currentTime, duration, onSeek,
  keyframes, selectedId, onSelect, onDelete, onRetime, onAddKeyframe, disabled,
  pos, onPosChange, onHide, showUI,
}: TransportDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Keeps a dragged-to position on-screen if the window is resized smaller
  // afterward (e.g. the dock was dragged near the right edge, then the
  // browser window is narrowed) — re-clamps against the dock's current
  // measured size, not a stale one from drag-start time.
  //
  // Deliberately just clamps to the viewport, with no special-casing for
  // the sidebar panel: the dock's z-index is now above .panel's (see
  // index.css), so dragging it under the panel is harmless — it renders
  // on top and stays fully reachable. (An earlier version clamped against
  // the panel's width too, to work around the dock being unreachable when
  // the panel had the higher z-index; once that ordering was fixed
  // directly, the workaround here was no longer needed.)
  const clampToViewport = useCallback((x: number, y: number) => {
    const el = dockRef.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

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

  // Double-click-to-add on the keyframe track: seeking first (synchronous —
  // setting video.currentTime updates the property immediately, even though
  // the decoded frame itself catches up asynchronously) means onAddKeyframe
  // reads the correct new time when it runs right after, with no need for
  // App.tsx's addKeyframe to accept an explicit time argument.
  const addKeyframeAt = (time: number) => { onSeek(time); onAddKeyframe(); };

  const selectedKf = selectedId ? keyframes.find(k => k.id === selectedId) : undefined;
  const statusText = selectedKf ? `EDITING KEYFRAME @ ${fmtTime(Math.floor(selectedKf.time))}` : 'EDITING LIVE';

  return (
    <div
      ref={dockRef}
      className={`transport-dock${showUI ? ' sidebar-open' : ''}`}
      style={pos ? { left: pos.x, top: pos.y, bottom: 'auto', transform: 'none' } : undefined}
    >
      <div className="dock-top-row">
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
        <span className="dock-hide-btn" onClick={onHide} title="Hide dock (Ctrl+L)">⌃L HIDE</span>
      </div>

      <div className="dock-row">
        <button className="btn-brut icon-btn" onClick={onTogglePlay} disabled={disabled}>
          {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
        </button>
        <button className="btn-brut icon-btn" onClick={onRestart} disabled={disabled} title="Restart">
          <RotateCcw size={14} />
        </button>
        <button
          className="btn-brut icon-btn"
          onClick={() => prevKf && jumpTo(prevKf)}
          disabled={disabled || !prevKf}
          title="Jump to previous keyframe"
        >
          <ChevronLeft size={14} />
        </button>
        <TimelineBar
          currentTime={currentTime}
          duration={duration}
          onSeek={onSeek}
          keyframes={keyframes}
          selectedId={selectedId}
          onSelect={onSelect}
          onRetime={onRetime}
          onAddKeyframeAt={addKeyframeAt}
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
        {/* Always rendered (visibility toggled, not conditionally unmounted)
            so selecting/deselecting a keyframe doesn't shift the row's
            width and jump the track next to it. */}
        <button
          className="btn-brut icon-btn"
          onClick={() => selectedId && onDelete(selectedId)}
          disabled={disabled || !selectedId}
          title="Delete keyframe"
          style={{ visibility: selectedId ? 'visible' : 'hidden' }}
        >
          <X size={14} />
        </button>
        <TimecodeDisplay time={currentTime} duration={duration} onSeek={onSeek} disabled={disabled} />
      </div>
      <div className="dock-caption">DRAG TO SEEK · DOUBLE-CLICK OR + TO ADD KEYFRAME · DRAG DIAMOND TO RETIME</div>

      <div className="dock-status">{statusText}</div>
    </div>
  );
}
