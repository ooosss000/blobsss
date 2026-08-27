import { useEffect, useRef, useState } from 'react';

interface VideoScrubBarProps {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  /** Disables scrubbing — set during MP4 recording/encoding, matching the other export-adjacent controls in App.tsx. Scrubbing mid-recording would splice an arbitrary content jump into the capture while the encoder's synthetic timestamps stay smooth. */
  disabled: boolean;
}

/**
 * Dedicated video-scrub control — click/drag anywhere on the track to seek.
 * This bar has exactly one job (move through the video); keyframe
 * management lives entirely in the separate KeyframeBar so the two never
 * compete for the same gesture.
 */
export function VideoScrubBar({ currentTime, duration, onSeek, disabled }: VideoScrubBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);

  // Same rationale as KeyframeBar's mid-drag clearing effect: if `disabled`
  // flips true while a scrub gesture is already in flight (pointer down,
  // capture already acquired), the CSS `pointer-events: none` backup is
  // inert against an active pointer capture, so this ends the gesture the
  // instant `disabled` becomes true regardless of whether another pointer
  // event ever arrives.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (disabled) setScrubbing(false);
  }, [disabled]);

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  const clientXToTime = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    if (e.button !== 0 || !e.isPrimary) return;
    setScrubbing(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSeek(clientXToTime(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (disabled || !scrubbing) return;
    onSeek(clientXToTime(e.clientX));
  };

  const handlePointerUp = () => setScrubbing(false);

  return (
    <div
      className={`scrub-track${disabled ? ' disabled' : ''}`}
      ref={trackRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
    >
      <div className="kf-playhead" style={{ left: `${pct(currentTime)}%` }} />
    </div>
  );
}
