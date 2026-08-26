import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Video, Upload, Play, Pause, Loader2, RotateCcw, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BlobTracker } from './BlobTracker';
import type { TrackerParams, RenderMode } from './BlobTracker';
import { resolveActiveParams, clampExportPreviewSize, clampKeyframeTime } from './keyframes';
import type { Keyframe } from './keyframes';
import { KeyframeTimeline } from './KeyframeTimeline';
import './index.css';

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'BOX_INVERT',   label: 'INVERT'  },
  { id: 'ASCII_BOX',    label: 'ASCII'   },
  { id: 'OUTLINE',      label: 'OUTLN'   },
  { id: 'CENTROID_NET', label: 'NET'     },
  { id: 'GHOST_TRAIL',  label: 'GHOST'   },
  { id: 'ELLIPSE',      label: 'ELLPS'   },
  { id: 'TRAIL_PATH',   label: 'PATH'    },
  { id: 'RECON_SCAN',   label: 'RECON'   },
  { id: 'FEATURE_CALLOUT', label: 'CALLOUT' },
  { id: 'MESH_TRIANGULATE', label: 'MESH' },
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
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  gamma: 1,
  temperature: 0,
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
  const [gradeExport, setGradeExport] = useState(true);

  // Keyframe state
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<BlobTracker | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const keyframesRef = useRef<Keyframe[]>(keyframes);
  const paramsRef = useRef<TrackerParams>(params);
  const gradeExportRef = useRef(gradeExport);
  useEffect(() => { keyframesRef.current = keyframes; }, [keyframes]);
  useEffect(() => { paramsRef.current = params; }, [params]);

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
      setDuration(vid.duration || 0);
      trackerRef.current?.stop();
      trackerRef.current = new BlobTracker(vid, cv, paramsRef.current);
      trackerRef.current.setGradeExport(gradeExportRef.current);
      if (keyframesRef.current.length > 0) {
        trackerRef.current.setLiveParamsResolver((t) => resolveActiveParams(keyframesRef.current, t, paramsRef.current));
      }
    };
    const onPlay  = () => { trackerRef.current?.start(); setIsPaused(false); };
    const onPause = () => { trackerRef.current?.stop();  setIsPaused(true);  };
    const onTime  = () => setCurrentTime(vid.currentTime);
    const onSeeked = () => {
      setCurrentTime(vid.currentTime);
      if (vid.paused) trackerRef.current?.renderOnce();
    };
    const onLoadedData = () => { trackerRef.current?.renderOnce(); };
    vid.addEventListener('loadedmetadata', onMeta);
    vid.addEventListener('play',  onPlay);
    vid.addEventListener('pause', onPause);
    vid.addEventListener('timeupdate', onTime);
    vid.addEventListener('seeked', onSeeked);
    vid.addEventListener('loadeddata', onLoadedData);
    return () => {
      vid.removeEventListener('loadedmetadata', onMeta);
      vid.removeEventListener('play',  onPlay);
      vid.removeEventListener('pause', onPause);
      vid.removeEventListener('timeupdate', onTime);
      vid.removeEventListener('seeked', onSeeked);
      vid.removeEventListener('loadeddata', onLoadedData);
    };
  }, [videoSrc]);

  // ─── Resize canvas on window resize ────────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      if (!isRecording && trackerRef.current) trackerRef.current.resize();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isRecording]);

  // Return to preview resolution after recording stops — deferred to an effect so
  // React first commits the canvas `style` prop change (to `undefined`) before the
  // imperative resize() re-establishes explicit style.width/height; doing it
  // synchronously inside stopRecording races the style commit and corrupts the
  // HiDPI preview until the next window resize.
  useLayoutEffect(() => { if (!isRecording) trackerRef.current?.resize(); }, [isRecording]);

  useEffect(() => { trackerRef.current?.updateParams(params); }, [params]);

  useEffect(() => {
    gradeExportRef.current = gradeExport;
    trackerRef.current?.setGradeExport(gradeExport);
  }, [gradeExport]);

  // Keep selection valid only when it dangles (points at a deleted keyframe);
  // never override an intentional deselect (selectedKeyframeId === null)
  useEffect(() => {
    if (selectedKeyframeId && !keyframes.some(k => k.id === selectedKeyframeId)) {
      const sorted = [...keyframes].sort((a, b) => a.time - b.time);
      // Recovers a dangling selection after external deletion; self-terminating,
      // cannot run on every render since the guard above stops matching once fixed.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedKeyframeId(sorted.length ? sorted[sorted.length - 1].id : null);
    }
  }, [keyframes, selectedKeyframeId]);

  // Drive live preview + export from keyframes (or fall back to static params)
  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    if (keyframes.length === 0) {
      tracker.setLiveParamsResolver(null);
    } else {
      tracker.setLiveParamsResolver((t) => resolveActiveParams(keyframes, t, params));
    }
  }, [keyframes, params, videoSrc]);

  const setParam = (k: keyof TrackerParams, v: any) =>
    setParams(p => ({ ...p, [k]: typeof v === 'string' && !isNaN(+v) ? +v : v }));

  const displayParams: TrackerParams = selectedKeyframeId
    ? (keyframes.find(k => k.id === selectedKeyframeId)?.params ?? params)
    : params;

  const setDisplayParam = (k: keyof TrackerParams, v: any) => {
    const coerced = typeof v === 'string' && !isNaN(+v) ? +v : v;
    if (selectedKeyframeId) {
      setKeyframes(kfs => kfs.map(kf =>
        kf.id === selectedKeyframeId ? { ...kf, params: { ...kf.params, [k]: coerced } } : kf
      ));
    } else {
      setParam(k, v);
    }
  };

  // Repaint the paused preview so keyframe/param edits give immediate visual feedback
  useEffect(() => {
    if (isPaused) trackerRef.current?.renderOnce();
  }, [isPaused, displayParams, keyframes, currentTime]);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    setVideoSrc(URL.createObjectURL(f));
    setIsPaused(true);
    setKeyframes([]);
    setSelectedKeyframeId(null);
    setCurrentTime(0);
    setDuration(0);
    trackerRef.current?.stop();
    trackerRef.current = null;
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
  };

  const restart = () => {
    if (videoRef.current) videoRef.current.currentTime = 0;
  };

  const seekTo = (time: number) => {
    if (videoRef.current) videoRef.current.currentTime = time;
  };

  const addKeyframe = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const id = `kf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const time = clampKeyframeTime(keyframes, id, vid.currentTime, duration);
    const activeParams = keyframes.length > 0
      ? resolveActiveParams(keyframes, vid.currentTime, params)
      : params;
    const newKf: Keyframe = { id, time, params: activeParams };
    setKeyframes(kfs => [...kfs, newKf]);
    setSelectedKeyframeId(newKf.id);
  };

  const deleteKeyframe = (id: string) => {
    setKeyframes(kfs => kfs.filter(k => k.id !== id));
  };

  const retimeKeyframe = (id: string, time: number) => {
    setKeyframes(kfs => kfs.map(k => (k.id === id ? { ...k, time: clampKeyframeTime(kfs, id, time, duration) } : k)));
  };

  // ─── Snapshots ────────────────────────────────────────────────────────────
  const snapshot = () => {
    const c = canvasRef.current; if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png'); a.download = `blobsss_${Date.now()}.png`; a.click();
  };

  const exportSVG = () => {
    const tracker = trackerRef.current; if (!tracker) return;
    const svg = tracker.toSVG();
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `blobsss_${Date.now()}.svg`; a.click();
    URL.revokeObjectURL(url);
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
    tracker.setExporting(true);
    tracker.resize(exportRes.w, exportRes.h, true);

    try {
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

      // Frame capture loop — throttled to actual 30fps with backpressure
      let lastCaptureTime = 0;
      const captureInterval = 1000 / 30; // 33.3ms

      const captureFrame = () => {
        if (!encoderRef.current || encoderRef.current.state === 'closed') return;

        recordingLoopRef.current = requestAnimationFrame(captureFrame);

        // Throttle to 30fps
        const now = performance.now();
        if (now - lastCaptureTime < captureInterval) return;
        lastCaptureTime = now;

        // Skip if encoder is backlogged (prevent frame pile-up)
        if (encoderRef.current.encodeQueueSize > 5) return;

        const frame = new VideoFrame(cv, {
          timestamp: frameCountRef.current * (1_000_000 / 30), // microseconds
        });

        encoderRef.current.encode(frame, {
          keyFrame: frameCountRef.current % 60 === 0, // keyframe every 2s
        });
        frame.close();
        frameCountRef.current++;
      };

      recordingLoopRef.current = requestAnimationFrame(captureFrame);
    } catch (err) {
      console.error('Failed to start recording:', err);
      tracker.setExporting(false);
      tracker.resize();
      encoderRef.current = null;
      muxerRef.current = null;
    }
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

    encoderRef.current = null;
    muxerRef.current = null;
    frameCountRef.current = 0;
    trackerRef.current?.setExporting(false);
    setIsRecording(false);
    setIsEncoding(false);
  }, [exportRes]);

  const toggleRecord = useCallback(() => {
    isRecording ? stopRecording() : startRecording();
  }, [isRecording, startRecording, stopRecording]);

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const previewSize = isRecording ? clampExportPreviewSize(exportRes.w, exportRes.h, window.innerWidth, window.innerHeight) : null;

  // ─── RENDER ──────────────────────────────────────────────────────────────────

  return (
    <div className="app-root">
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <filter id="bs-gamma-filter" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncR id="bs-gamma-r" type="gamma" amplitude="1" exponent="1" offset="0" />
              <feFuncG id="bs-gamma-g" type="gamma" amplitude="1" exponent="1" offset="0" />
              <feFuncB id="bs-gamma-b" type="gamma" amplitude="1" exponent="1" offset="0" />
            </feComponentTransfer>
          </filter>
          <filter id="bs-temp-filter" colorInterpolationFilters="sRGB">
            <feColorMatrix id="bs-temp-matrix" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
          </filter>
        </defs>
      </svg>
      <video ref={videoRef} src={videoSrc || undefined} loop playsInline style={{ display: 'none' }} />
      <canvas
        ref={canvasRef}
        className={`main-canvas ${isRecording ? 'recording' : ''}`}
        style={previewSize ? { width: previewSize.w, height: previewSize.h } : undefined}
        onClick={togglePlay}
      />
      {videoSrc && (
        <div className="transport-overlay">
          <button className="btn-brut icon-btn" onClick={togglePlay}>
            {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
          </button>
          <button className="btn-brut icon-btn" onClick={restart} title="Restart">
            <RotateCcw size={14} />
          </button>
        </div>
      )}

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
              </div>
            </Section>

            {videoSrc && (
              <>
                <Section label="RENDER MODE">
                  <div className="mode-grid">
                    {MODES.map(m => (
                      <button key={m.id} className={`mode-btn${displayParams.renderMode === m.id ? ' active' : ''}`}
                        onClick={() => setDisplayParam('renderMode', m.id)}>{m.label}</button>
                    ))}
                  </div>
                  {displayParams.renderMode === 'ASCII_BOX' && (
                    <BrutSlider label="ASCII CONTRAST" value={displayParams.asciiContrast} min={0.3} max={4} step={0.1} onChange={v => setDisplayParam('asciiContrast', v)} />
                  )}
                </Section>

                <Section label="MOTION DETECTION">
                  <BrutSlider label="SENSITIVITY" value={displayParams.diffThreshold} min={1} max={80} step={1} onChange={v => setDisplayParam('diffThreshold', v)} hint="Lower = more sensitive" invert />
                  <BrutSlider label="BLOB LIFETIME" value={displayParams.lifeFrames} min={1} max={60} step={1} onChange={v => setDisplayParam('lifeFrames', v)} />
                  <Row2>
                    <BrutSlider label="MIN AREA" value={displayParams.minArea} min={1} max={200} step={1} onChange={v => setDisplayParam('minArea', v)} />
                    <BrutSlider label="MAX AREA" value={displayParams.maxArea} min={100} max={20000} step={100} onChange={v => setDisplayParam('maxArea', v)} />
                  </Row2>
                  <BrutSlider label="MAX DIMENSION" value={displayParams.maxBlobDim} min={1} max={320} step={1} onChange={v => setDisplayParam('maxBlobDim', v)} hint="Max width/height of a blob to track (1=micro, 320=full)" />
                </Section>

                <Section label="DENSITY">
                  <BrutSlider label="MAX BLOBS" value={displayParams.maxBlobs} min={1} max={400} step={1} onChange={v => setDisplayParam('maxBlobs', v)} />
                  <BrutSlider label="SUBDIVIDE (NxN)" value={displayParams.subdivide} min={1} max={4} step={1} onChange={v => setDisplayParam('subdivide', v)} />
                  <div className="hint-text">1=normal · 4=4× denser</div>
                </Section>

                <Section label="VISUAL">
                  <Row2>
                    {displayParams.renderMode !== 'TRAIL_PATH' && <ColorRow label="STROKE" value={displayParams.strokeColor} onChange={v => setDisplayParam('strokeColor', v)} />}
                    <ColorRow label="TEXT" value={displayParams.textColor} onChange={v => setDisplayParam('textColor', v)} />
                  </Row2>
                  <Row2>
                    {displayParams.renderMode !== 'TRAIL_PATH' && <BrutSlider label="STROKE W" value={displayParams.strokeWidth} min={0.5} max={8} step={0.5} onChange={v => setDisplayParam('strokeWidth', v)} />}
                    <BrutSlider label="FONT PX" value={displayParams.fontSize} min={6} max={48} step={1} onChange={v => setDisplayParam('fontSize', v)} />
                  </Row2>
                  {displayParams.renderMode !== 'TRAIL_PATH' && <BrutSlider label="LINKS" value={displayParams.neighborLinks} min={0} max={12} step={1} onChange={v => setDisplayParam('neighborLinks', v)} />}
                  <div className="row gap-8">
                    <div className="section-label" style={{ marginBottom: 0 }}>FONT</div>
                    <select value={displayParams.fontFamily} onChange={e => setDisplayParam('fontFamily', e.target.value)} className="brut-select flex-1">
                      <option value="monospace">MONO</option>
                      <option value="Outfit">OUTFIT</option>
                      <option value="serif">SERIF</option>
                      <option value="sans-serif">SANS</option>
                    </select>
                  </div>
                </Section>

                <Section label="COLOR GRADE">
                  <Row2>
                    <BrutSlider label="BRIGHTNESS" value={displayParams.brightness} min={0} max={2} step={0.05} onChange={v => setDisplayParam('brightness', v)} />
                    <BrutSlider label="CONTRAST" value={displayParams.contrast} min={0} max={2} step={0.05} onChange={v => setDisplayParam('contrast', v)} />
                  </Row2>
                  <Row2>
                    <BrutSlider label="SATURATION" value={displayParams.saturation} min={0} max={2} step={0.05} onChange={v => setDisplayParam('saturation', v)} />
                    <BrutSlider label="HUE" value={displayParams.hue} min={-180} max={180} step={1} onChange={v => setDisplayParam('hue', v)} />
                  </Row2>
                  <Row2>
                    <BrutSlider label="GAMMA" value={displayParams.gamma} min={0.2} max={3} step={0.05} onChange={v => setDisplayParam('gamma', v)} />
                    <BrutSlider label="TEMPERATURE" value={displayParams.temperature} min={-1} max={1} step={0.05} onChange={v => setDisplayParam('temperature', v)} />
                  </Row2>
                  <div className="toggle-row"><span>APPLY GRADE TO MP4</span><BrutToggle value={gradeExport} onChange={setGradeExport} /></div>
                </Section>

                <Section label="LABELS">
                  <div className="toggle-row"><span>COORDINATES XY</span><BrutToggle value={displayParams.showCoordinates} onChange={v => setDisplayParam('showCoordinates', v)} /></div>
                  <div className="toggle-row"><span>BLOB ID</span><BrutToggle value={displayParams.showId} onChange={v => setDisplayParam('showId', v)} /></div>
                  <div className="toggle-row"><span>BLOB SIZE W×H</span><BrutToggle value={displayParams.showSize} onChange={v => setDisplayParam('showSize', v)} /></div>
                  <div className="toggle-row"><span>LABEL BG PILL</span><BrutToggle value={displayParams.showLabelBG} onChange={v => setDisplayParam('showLabelBG', v)} /></div>
                </Section>

                <Section label="KEYFRAMES">
                  <KeyframeTimeline
                    keyframes={keyframes}
                    selectedId={selectedKeyframeId}
                    currentTime={currentTime}
                    duration={duration}
                    onSelect={setSelectedKeyframeId}
                    onDelete={deleteKeyframe}
                    onRetime={retimeKeyframe}
                    onSeek={seekTo}
                  />
                  <button className="btn-brut flex-1 mt-8" onClick={addKeyframe}>
                    <Plus size={13} />
                    <span>ADD KEYFRAME AT {fmtTime(Math.floor(currentTime))}</span>
                  </button>
                  <div className="hint-text">
                    {keyframes.length === 0
                      ? 'No keyframes — export uses the static settings above.'
                      : `${keyframes.length} keyframe${keyframes.length > 1 ? 's' : ''} — play/pause to position, drag markers to retime.`}
                  </div>
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
                  <div className="row gap-4">
                    <button className="btn-brut flex-1" onClick={snapshot} disabled={isRecording || isEncoding} title="Export current frame as PNG">
                      PNG
                    </button>
                    <button className="btn-brut flex-1" onClick={exportSVG} disabled={isRecording || isEncoding} title="Export current frame as SVG">
                      SVG
                    </button>
                  </div>
                  <div className="row mt-8">
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
    ? (max + min - value).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)
    : typeof value === 'number' ? value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0) : value;
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
