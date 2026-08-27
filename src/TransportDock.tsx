import { Play, Pause, RotateCcw, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
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
}

// Mirrors App.tsx's own fmtTime — kept as a small local copy rather than a
// shared util for one function used in two places (YAGNI); revisit if a
// third call site appears.
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

const JUMP_EPS = 0.01;

export function TransportDock({
  isPaused, onTogglePlay, onRestart, currentTime, duration, onSeek,
  keyframes, selectedId, onSelect, onDelete, onRetime, onAddKeyframe, disabled,
}: TransportDockProps) {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const prevKf = [...sorted].reverse().find(k => k.time < currentTime - JUMP_EPS);
  const nextKf = sorted.find(k => k.time > currentTime + JUMP_EPS);

  const jumpTo = (kf: Keyframe) => { onSeek(kf.time); onSelect(kf.id); };

  const selectedKf = selectedId ? keyframes.find(k => k.id === selectedId) : undefined;
  const statusText = selectedKf ? `EDITING KEYFRAME @ ${fmtTime(Math.floor(selectedKf.time))}` : 'EDITING LIVE';

  return (
    <div className="transport-dock">
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

      <div className="dock-status">{statusText}</div>
    </div>
  );
}
