import { useState, useRef, useEffect, useCallback } from 'react';
import { Video, Camera, Upload, Play, Pause, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BlobTracker } from './BlobTracker';
import type { TrackerParams, RenderMode } from './BlobTracker';
import './index.css';

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'BOX_INVERT',   label: 'INVERT'  },
  { id: 'ASCII_BOX',    label: 'ASCII'   },
  { id: 'OUTLINE',      label: 'OUTLN'   },
  { id: 'CENTROID_NET', label: 'NET'     },
  { id: 'GHOST_TRAIL',  label: 'GHOST'   },
  { id: 'ELLIPSE',      label: 'ELLPS'   },
  { id: 'TRAIL_PATH',   label: 'PATH'    },
];

const DEFAULT_PARAMS: TrackerParams = {
  diffThreshold: 19, // Sensitivity 62 on the inverted UI scale
  minArea: 100,
  maxArea: 9000,
  maxBlobs: 100,
  lifeFrames: 18,
  jitter: 0,
  maxBlobDim: 320,
  subdivide: 1,
  renderMode: 'BOX_INVERT',
  neighborLinks: 3,
  strokeColor: '#FFFFFF',
  textColor: '#FFFFFF',
  strokeWidth: 1.0,
  fontSize: 10,
  fontFamily: 'monospace',
  asciiContrast: 1.2,
  showCoordinates: true,
  showId: true,
  showSize: false,
  showLabelBG: true,
};

// ─── MAIN APP ──────────────────────────────────────────────────────────────────

export default function App() {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [params, setParams] = useState<TrackerParams>(DEFAULT_PARAMS);
  const [showUI, setShowUI] = useState(true);
  const [isPaused, setIsPaused] = useState(true);

  // Export state
  const [isRecording, setIsRecording] = useState(false);
  const [recTime, setRecTime] = useState(0);
  const [exportRes, setExportRes] = useState<{ w: number; h: number }>({ w: 1920, h: 1080 });
  const [isEncoding, setIsEncoding] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<BlobTracker | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Keyboard shortcut ───────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowUI(p => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ─── Video lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!videoSrc || !videoRef.current || !canvasRef.current) return;
    const vid = videoRef.current;
    const cv  = canvasRef.current;
    const onMeta  = () => {
      if (vid.videoWidth && vid.videoHeight) {
        setExportRes({ w: vid.videoWidth, h: vid.videoHeight });
      }
      trackerRef.current?.stop();
      trackerRef.current = new BlobTracker(vid, cv, params);
    };
    const onPlay  = () => { trackerRef.current?.start(); setIsPaused(false); };
    const onPause = () => { trackerRef.current?.stop();  setIsPaused(true);  };
    vid.addEventListener('loadedmetadata', onMeta);
    vid.addEventListener('play',  onPlay);
    vid.addEventListener('pause', onPause);
    return () => {
      vid.removeEventListener('loadedmetadata', onMeta);
      vid.removeEventListener('play',  onPlay);
      vid.removeEventListener('pause', onPause);
    };
  }, [videoSrc]);

  useEffect(() => { trackerRef.current?.updateParams(params); }, [params]);

  const setParam = (k: keyof TrackerParams, v: any) =>
    setParams(p => ({ ...p, [k]: typeof v === 'string' && !isNaN(+v) ? +v : v }));

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    setVideoSrc(URL.createObjectURL(f));
    setIsPaused(true);
    trackerRef.current?.stop();
    trackerRef.current = null;
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
  };

  // ─── PNG Snapshot ────────────────────────────────────────────────────────────
  const snapshot = () => {
    const c = canvasRef.current; if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png'); a.download = `blobsss_${Date.now()}.png`; a.click();
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // EXPORT SYSTEM — Direct-to-MP4 (spacetypegenerator approach)
  //
  // Each canvas frame is captured as a VideoFrame, encoded via hardware-
  // accelerated H.264 VideoEncoder, and muxed directly into MP4 by mp4-muxer.
  // No intermediate WebM. No remuxing. No FFmpeg.
  // ═══════════════════════════════════════════════════════════════════════════════

  const muxerRef = useRef<any>(null);
  const encoderRef = useRef<VideoEncoder | null>(null);
  const frameCountRef = useRef(0);
  const recordingLoopRef = useRef<number | null>(null);

  const startRecording = useCallback(async () => {
    const tracker = trackerRef.current;
    const cv = canvasRef.current;
    if (!tracker || !cv) return;

    // Resize canvas to export resolution
    tracker.resize(exportRes.w, exportRes.h, true);

    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: 'avc',
        width: exportRes.w,
        height: exportRes.h,
      },
      fastStart: 'in-memory',
    });
    muxerRef.current = { muxer, target };

    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxer.addVideoChunk(chunk, meta);
      },
      error: (e) => console.error('VideoEncoder error:', e),
    });

    encoder.configure({
      codec: 'avc1.640034', // H.264 High Profile Level 5.2 (supports up to 4K+)
      width: exportRes.w,
      height: exportRes.h,
      bitrate: 30_000_000, // 30 Mbps for maximum output quality
      framerate: 30,
    });

    encoderRef.current = encoder;
    frameCountRef.current = 0;

    setIsRecording(true);
    setRecTime(0);
    timerRef.current = setInterval(() => setRecTime(t => t + 1), 1000);

    // Frame capture loop — grabs canvas every ~33ms (30fps)
    const captureFrame = () => {
      if (!encoderRef.current || encoderRef.current.state === 'closed') return;

      const frame = new VideoFrame(cv, {
        timestamp: frameCountRef.current * (1_000_000 / 30), // microseconds
      });

      encoderRef.current.encode(frame, {
        keyFrame: frameCountRef.current % 60 === 0, // keyframe every 2s
      });
      frame.close();
      frameCountRef.current++;

      recordingLoopRef.current = requestAnimationFrame(captureFrame);
    };

    recordingLoopRef.current = requestAnimationFrame(captureFrame);
  }, [exportRes]);

  const stopRecording = useCallback(async () => {
    // Stop the frame capture loop
    if (recordingLoopRef.current) {
      cancelAnimationFrame(recordingLoopRef.current);
      recordingLoopRef.current = null;
    }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    setIsEncoding(true);

    try {
      const encoder = encoderRef.current;
      const muxData = muxerRef.current;

      if (encoder && encoder.state !== 'closed') {
        await encoder.flush();
        encoder.close();
      }

      if (muxData) {
        muxData.muxer.finalize();
        const mp4Blob = new Blob([muxData.target.buffer], { type: 'video/mp4' });
        downloadBlob(mp4Blob, `blobsss_${exportRes.w}x${exportRes.h}_${Date.now()}.mp4`);
      }
    } catch (err) {
      console.error('MP4 finalization error:', err);
    }

    // Return to preview resolution
    trackerRef.current?.resize();
    encoderRef.current = null;
    muxerRef.current = null;
    frameCountRef.current = 0;
    setIsRecording(false);
    setIsEncoding(false);
  }, [exportRes]);

  const toggleRecord = useCallback(() => {
    isRecording ? stopRecording() : startRecording();
  }, [isRecording, startRecording, stopRecording]);

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  // ─── RENDER ──────────────────────────────────────────────────────────────────

  return (
    <div className="app-root">
      <video ref={videoRef} src={videoSrc || undefined} loop playsInline style={{ display: 'none' }} />
      <canvas
        ref={canvasRef}
        className={`main-canvas ${isRecording ? 'recording' : ''}`}
        onClick={togglePlay}
      />

      <AnimatePresence>
        {showUI && (
          <motion.div
            className="panel"
            initial={{ x: -340, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -340, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
          >
            <div className="panel-header">
              <span className="panel-title">BLOBSSS</span>
              <span className="panel-ver">⌃K HIDE</span>
            </div>

            <Section label="SOURCE">
              <div className="row gap-8">
                <label className="btn-brut flex-1">
                  <Upload size={13} />
                  <span>{videoSrc ? 'CHANGE VIDEO' : 'LOAD VIDEO'}</span>
                  <input type="file" accept="video/*" style={{ display: 'none' }} onChange={handleUpload} />
                </label>
                {videoSrc && (
                  <button className="btn-brut icon-btn" onClick={togglePlay}>
                    {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
                  </button>
                )}
              </div>
            </Section>

            {videoSrc && (
              <>
                <Section label="RENDER MODE">
                  <div className="mode-grid">
                    {MODES.map(m => (
                      <button key={m.id} className={`mode-btn${params.renderMode === m.id ? ' active' : ''}`}
                        onClick={() => setParam('renderMode', m.id)}>{m.label}</button>
                    ))}
                  </div>
                  {params.renderMode === 'ASCII_BOX' && (
                    <BrutSlider label="ASCII CONTRAST" value={params.asciiContrast} min={0.3} max={4} step={0.1} onChange={v => setParam('asciiContrast', v)} />
                  )}
                </Section>

                <Section label="MOTION DETECTION">
                  <BrutSlider label="SENSITIVITY" value={params.diffThreshold} min={1} max={80} step={1} onChange={v => setParam('diffThreshold', v)} hint="Lower = more sensitive" invert />
                  <BrutSlider label="BLOB LIFETIME" value={params.lifeFrames} min={1} max={60} step={1} onChange={v => setParam('lifeFrames', v)} />
                  <Row2>
                    <BrutSlider label="MIN AREA" value={params.minArea} min={1} max={200} step={1} onChange={v => setParam('minArea', v)} />
                    <BrutSlider label="MAX AREA" value={params.maxArea} min={100} max={20000} step={100} onChange={v => setParam('maxArea', v)} />
                  </Row2>
                  <BrutSlider label="MAX DIMENSION" value={params.maxBlobDim} min={1} max={320} step={1} onChange={v => setParam('maxBlobDim', v)} hint="Max width/height of a blob to track (1=micro, 320=full)" />
                </Section>

                <Section label="DENSITY">
                  <BrutSlider label="MAX BLOBS" value={params.maxBlobs} min={1} max={400} step={1} onChange={v => setParam('maxBlobs', v)} />
                  <BrutSlider label="SUBDIVIDE (NxN)" value={params.subdivide} min={1} max={4} step={1} onChange={v => setParam('subdivide', v)} />
                  <div className="hint-text">1=normal · 4=4× denser</div>
                </Section>

                <Section label="VISUAL">
                  <Row2>
                    {params.renderMode !== 'TRAIL_PATH' && <ColorRow label="STROKE" value={params.strokeColor} onChange={v => setParam('strokeColor', v)} />}
                    <ColorRow label="TEXT" value={params.textColor} onChange={v => setParam('textColor', v)} />
                  </Row2>
                  <Row2>
                    {params.renderMode !== 'TRAIL_PATH' && <BrutSlider label="STROKE W" value={params.strokeWidth} min={0.5} max={8} step={0.5} onChange={v => setParam('strokeWidth', v)} />}
                    <BrutSlider label="FONT PX" value={params.fontSize} min={6} max={48} step={1} onChange={v => setParam('fontSize', v)} />
                  </Row2>
                  {params.renderMode !== 'TRAIL_PATH' && <BrutSlider label="LINKS" value={params.neighborLinks} min={0} max={12} step={1} onChange={v => setParam('neighborLinks', v)} />}
                  <div className="row gap-8">
                    <div className="section-label" style={{ marginBottom: 0 }}>FONT</div>
                    <select value={params.fontFamily} onChange={e => setParam('fontFamily', e.target.value)} className="brut-select flex-1">
                      <option value="monospace">MONO</option>
                      <option value="Outfit">OUTFIT</option>
                      <option value="serif">SERIF</option>
                      <option value="sans-serif">SANS</option>
                    </select>
                  </div>
                </Section>

                <Section label="LABELS">
                  <div className="toggle-row"><span>COORDINATES XY</span><BrutToggle value={params.showCoordinates} onChange={v => setParam('showCoordinates', v)} /></div>
                  <div className="toggle-row"><span>BLOB ID</span><BrutToggle value={params.showId} onChange={v => setParam('showId', v)} /></div>
                  <div className="toggle-row"><span>BLOB SIZE W×H</span><BrutToggle value={params.showSize} onChange={v => setParam('showSize', v)} /></div>
                  <div className="toggle-row"><span>LABEL BG PILL</span><BrutToggle value={params.showLabelBG} onChange={v => setParam('showLabelBG', v)} /></div>
                </Section>

                {/* ── EXPORT ── */}
                <Section label="EXPORT">
                  <div className="row gap-8">
                    <div className="section-label" style={{ marginBottom: 0 }}>RES</div>
                    <select
                      value={`${exportRes.w}x${exportRes.h}`}
                      onChange={e => { const [w,h] = e.target.value.split('x'); setExportRes({ w:+w, h:+h }); }}
                      className="brut-select flex-1"
                      disabled={isRecording || isEncoding}
                    >
                      <option value={`${videoRef.current?.videoWidth || 1920}x${videoRef.current?.videoHeight || 1080}`}>
                        SOURCE ({videoRef.current?.videoWidth || '—'}×{videoRef.current?.videoHeight || '—'})
                      </option>
                      <option value="1920x1080">1920×1080</option>
                      <option value="1280x720">1280×720</option>
                      <option value="854x480">854×480</option>
                    </select>
                  </div>
                  <div className="row gap-8">
                    <button className="btn-brut flex-1" onClick={snapshot} disabled={isRecording || isEncoding}>
                      <Camera size={13} /> PNG
                    </button>
                    <button
                      className={`btn-brut flex-1${isRecording ? ' recording' : ''}`}
                      onClick={toggleRecord}
                      disabled={isEncoding}
                    >
                      {isRecording ? <div className="pulse-dot" /> : <Video size={13} />}
                      {isRecording ? `STOP ${fmtTime(recTime)}` : 'RECORD MP4'}
                    </button>
                  </div>
                  {isEncoding && (
                    <div className="row gap-8" style={{ justifyContent: 'center', marginTop: 4 }}>
                      <Loader2 size={12} className="spin" />
                      <span className="hint-text" style={{ color: 'var(--accent)' }}>ENCODING MP4...</span>
                    </div>
                  )}
                  <div className="hint-text">
                    SAVES .MP4 — HARDWARE ACCELERATED
                  </div>
                </Section>
              </>
            )}

            {!videoSrc && (
              <div className="empty-hint">
                Load a video to start.<br />
                Blobs track real motion regions.<br />
                <kbd>CTRL+K</kbd> hides everything.
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}


function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (<div className="section"><div className="section-label">{label}</div>{children}</div>);
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div className="two-col">{children}</div>;
}

function BrutSlider({ label, value, min, max, step, onChange, hint, invert }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: string) => void; hint?: string; invert?: boolean;
}) {
  const display = invert
    ? (max + min - value).toFixed(step < 1 ? 1 : 0)
    : typeof value === 'number' ? value.toFixed(step < 1 ? 1 : 0) : value;
  return (
    <div className="brut-slider" title={hint}>
      <div className="brut-slider-header">
        <span>{label}</span>
        <span className="val">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="color-row">
      <span>{label}</span>
      <div className="color-right">
        <span className="color-hex">{value.toUpperCase()}</span>
        <input type="color" value={value} onChange={e => onChange(e.target.value)} className="color-input" />
      </div>
    </div>
  );
}

function BrutToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`brut-toggle${value ? ' on' : ''}`} onClick={() => onChange(!value)}>
      {value ? 'ON' : 'OFF'}
    </button>
  );
}
