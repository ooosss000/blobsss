import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Video, Upload, Loader2, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BlobTracker } from './BlobTracker';
import type { TrackerParams, RenderMode } from './BlobTracker';
import {
  resolveActiveParams, clampExportPreviewSize, clampKeyframeTime,
  resolveAnimatedParams, resolveParamValue, MIN_KEYFRAME_GAP,
  ANIMATABLE_PARAM_KEYS,
} from './keyframes';
import type { Keyframe, ParamTracks, ParamKeyframe, AnimatableParamKey, CurveType } from './keyframes';
import { TransportDock } from './TransportDock';
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

// Module-scope monotonic counter for per-parameter keyframe ids — mirrors
// BlobTracker.ts's own `nextId` pattern for tracked blobs. Used instead of
// Date.now()/Math.random() (as the unified system's addKeyframe still does)
// specifically because these ids are generated from inside functions
// referenced indirectly through inline JSX arrow wrappers (onClick={() =>
// toggleParamAnimation(key)}, onChange={v => setAnimatableParam(key, v)})
// rather than passed by direct reference, which trips this project's
// react-hooks/purity lint rule when the call is Date.now/Math.random but
// not when it's a plain synchronous counter increment.
let nextParamKfId = 1;

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
  const [videoError, setVideoError] = useState<string | null>(null);
  const [params, setParams] = useState<TrackerParams>(DEFAULT_PARAMS);
  const [showUI, setShowUI] = useState(true);
  const [dockVisible, setDockVisible] = useState(true);
  // Lifted out of TransportDock so a dragged position survives the dock
  // being hidden/re-shown via either showUI (Ctrl+K) or dockVisible —
  // both unmount TransportDock rather than just CSS-hiding it, which would
  // otherwise reset a dock-local position back to default on every re-show.
  const [dockPos, setDockPos] = useState<{ x: number; y: number } | null>(null);
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

  // Per-parameter keyframe tracks — a second, independent keyframing system
  // for the 9 "animatable" fields (Premiere-style stopwatch), layered
  // alongside (not replacing) the unified `keyframes` timeline above. See
  // docs/superpowers/plans/2026-08-27-per-parameter-keyframe-tracks.md.
  const [paramTracks, setParamTracks] = useState<ParamTracks>({});
  // Selected keyframe id per animated-param row, for the ANIMATED PARAMS
  // panel's H/L curve toggle and delete button — independent of
  // selectedKeyframeId (the unified timeline's own selection).
  const [selectedParamKeyframeIds, setSelectedParamKeyframeIds] = useState<Partial<Record<AnimatableParamKey, string | null>>>({});

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<BlobTracker | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const keyframesRef = useRef<Keyframe[]>(keyframes);
  const paramsRef = useRef<TrackerParams>(params);
  const paramTracksRef = useRef<ParamTracks>(paramTracks);
  const gradeExportRef = useRef(gradeExport);
  useEffect(() => { keyframesRef.current = keyframes; }, [keyframes]);
  useEffect(() => { paramsRef.current = params; }, [params]);
  useEffect(() => { paramTracksRef.current = paramTracks; }, [paramTracks]);

  // ─── Keyboard shortcut ───────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowUI(p => !p); }
      // Separate from Ctrl+K: hides just the transport dock (scrub/keyframe
      // bars), leaving the sidebar visible — independent toggle, same as
      // the "SHOW TRANSPORT DOCK" checkbox in the KEYFRAMES section.
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); setDockVisible(p => !p); }
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
      setVideoError(null);
      if (vid.videoWidth && vid.videoHeight) {
        setExportRes({ w: vid.videoWidth, h: vid.videoHeight });
      }
      setDuration(vid.duration || 0);
      trackerRef.current?.stop();
      trackerRef.current = new BlobTracker(vid, cv, paramsRef.current);
      trackerRef.current.setGradeExport(gradeExportRef.current);
      trackerRef.current.setLiveParamsResolver((t) => {
        const unified = keyframesRef.current.length > 0
          ? resolveActiveParams(keyframesRef.current, t, paramsRef.current)
          : paramsRef.current;
        return resolveAnimatedParams(paramTracksRef.current, t, unified);
      });
    };
    const onPlay  = () => { trackerRef.current?.start(); setIsPaused(false); };
    const onPause = () => { trackerRef.current?.stop();  setIsPaused(true);  };
    const onTime  = () => setCurrentTime(vid.currentTime);
    const onSeeked = () => {
      setCurrentTime(vid.currentTime);
      // Unconditional: a seek invalidates blobs/trails/prevData regardless of
      // play state — while paused this prevents stale overlays from the old
      // frame persisting into renderOnce(); while playing it prevents the
      // next processFrame() from diffing against a pre-seek prevData buffer.
      trackerRef.current?.resetTracking();
      if (vid.paused) trackerRef.current?.renderOnce();
    };
    const onLoadedData = () => { trackerRef.current?.renderOnce(); };
    const onError = () => {
      // The browser gives no detail beyond a MediaError code — most often
      // this means the container/codec isn't one this browser can decode
      // (e.g. HEVC or ProRes inside a .mov from an iPhone/camera), not a
      // file-size limit. Surface something actionable instead of a silent
      // blank canvas, and drop the failed source so the app returns to its
      // normal "no video loaded" state rather than a half-initialized one.
      const code = vid.error?.code;
      const reason = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? 'Unsupported format or codec (browsers typically only decode H.264/VP9/AV1 in MP4 or WebM — not HEVC or ProRes .mov files).'
        : code === MediaError.MEDIA_ERR_DECODE
        ? 'The browser started decoding but failed partway through — the file may be corrupt or use an unsupported codec profile.'
        : 'The browser could not load this video.';
      setVideoError(`Couldn't load video: ${reason}`);
      trackerRef.current?.stop();
      trackerRef.current = null;
      URL.revokeObjectURL(vid.currentSrc);
      setVideoSrc(null);
    };
    vid.addEventListener('loadedmetadata', onMeta);
    vid.addEventListener('play',  onPlay);
    vid.addEventListener('pause', onPause);
    vid.addEventListener('timeupdate', onTime);
    vid.addEventListener('seeked', onSeeked);
    vid.addEventListener('loadeddata', onLoadedData);
    vid.addEventListener('error', onError);
    return () => {
      vid.removeEventListener('loadedmetadata', onMeta);
      vid.removeEventListener('play',  onPlay);
      vid.removeEventListener('pause', onPause);
      vid.removeEventListener('timeupdate', onTime);
      vid.removeEventListener('seeked', onSeeked);
      vid.removeEventListener('loadeddata', onLoadedData);
      vid.removeEventListener('error', onError);
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

  // Drive live preview + export from the merged unified + per-param systems
  // (or fall back to static params when neither has any keyframes): the
  // unified timeline's own resolveActiveParams provides the base snapshot —
  // covering the ~19 non-animatable fields, and acting as the fallback for
  // any of the 9 animatable fields with no track of its own yet — then
  // resolveAnimatedParams overrides each animatable field that DOES have
  // its own track. Always set (never null) so a per-param track alone,
  // with zero unified keyframes, still drives preview/export correctly.
  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    tracker.setLiveParamsResolver((t) => {
      const unified = keyframes.length > 0
        ? resolveActiveParams(keyframes, t, params)
        : params;
      return resolveAnimatedParams(paramTracks, t, unified);
    });
  }, [keyframes, params, paramTracks, videoSrc]);

  const setParam = (k: keyof TrackerParams, v: any) =>
    setParams(p => ({ ...p, [k]: typeof v === 'string' && !isNaN(+v) ? +v : v }));

  const displayParams: TrackerParams = selectedKeyframeId
    ? (keyframes.find(k => k.id === selectedKeyframeId)?.params ?? params)
    : params;

  // The 9 animatable fields' displayed/edited value — intentionally
  // decoupled from selectedKeyframeId/displayParams: whether a unified
  // keyframe is selected has no bearing on these fields anymore. Falls back
  // to the SAME unified-timeline resolution the live-preview/export resolver
  // actually uses (resolveActiveParams(keyframes, currentTime, params), or
  // raw params when there are no unified keyframes) whenever a field has no
  // track of its own — not raw params[key] directly. Without this, a field
  // driven only by the unified system (no per-param track) would show a
  // sidebar value/highlight frozen on the last direct edit instead of
  // tracking whichever unified keyframe is actually active at this instant.
  const unifiedForDisplay = keyframes.length > 0
    ? resolveActiveParams(keyframes, currentTime, params)
    : params;
  const animatedDisplay = ANIMATABLE_PARAM_KEYS.reduce((acc, key) => {
    acc[key] = resolveParamValue(paramTracks[key], currentTime, unifiedForDisplay[key] as number | string);
    return acc;
  }, {} as Record<AnimatableParamKey, number | string>);
  // Which render mode is actually active right now, honoring its own track
  // if present — used to gate visibility of mode-dependent controls
  // (ASCII CONTRAST, STROKE/STROKE W/LINKS) so they track reality even when
  // a unified keyframe happens to be selected with a different snapshot.
  const activeRenderMode = animatedDisplay.renderMode as RenderMode;

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

  // Repaint the paused preview so keyframe/param edits give immediate visual feedback.
  // paramTracks is included separately from displayParams: editing an animatable
  // param's own track (via setAnimatableParam) never touches displayParams/params
  // when a track already exists for that field, so without this the paused canvas
  // wouldn't refresh after adding/retiming/deleting a per-param keyframe.
  useEffect(() => {
    if (isPaused) trackerRef.current?.renderOnce();
  }, [isPaused, displayParams, keyframes, paramTracks, currentTime]);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (videoSrc) URL.revokeObjectURL(videoSrc);
    setVideoError(null);
    setVideoSrc(URL.createObjectURL(f));
    setIsPaused(true);
    setKeyframes([]);
    setSelectedKeyframeId(null);
    setParamTracks({});
    setSelectedParamKeyframeIds({});
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
    // Update the playhead position immediately rather than waiting for the
    // video's own 'seeked'/'timeupdate' events to confirm it — those only
    // fire once the browser has actually processed the seek (real decode
    // latency), so during a fast drag on the scrub bar the playhead would
    // otherwise visibly lag behind the pointer. The actual video frame
    // still catches up asynchronously same as before; only the timeline
    // cursor's position is now optimistic.
    setCurrentTime(time);
  };

  const addKeyframe = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const id = `kf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const time = clampKeyframeTime(keyframes, id, vid.currentTime, duration);
    const activeParams = keyframes.length > 0
      ? resolveActiveParams(keyframes, vid.currentTime, params)
      : params;
    // Fold in the currently-active per-param-track values before
    // snapshotting: any of the 9 animatable fields currently driven by its
    // own paramTracks entry lives only there, not in `params` — without
    // this, a new unified keyframe would bake in a stale value for that
    // field (whatever `params[key]` last held before the stopwatch was
    // turned on), which later resurfaces when that param's stopwatch is
    // turned off (reverting to the unified system's now-stale snapshot
    // instead of the value the user actually left it at). Same fallback-
    // correctness fix already applied to toggleParamAnimation/
    // addParamKeyframeAt.
    const newKf: Keyframe = {
      id, time,
      params: resolveAnimatedParams(paramTracksRef.current, vid.currentTime, activeParams),
    };
    setKeyframes(kfs => [...kfs, newKf]);
    setSelectedKeyframeId(newKf.id);
  };

  const deleteKeyframe = (id: string) => {
    setKeyframes(kfs => kfs.filter(k => k.id !== id));
  };

  const retimeKeyframe = (id: string, time: number) => {
    setKeyframes(kfs => kfs.map(k => (k.id === id ? { ...k, time: clampKeyframeTime(kfs, id, time, duration) } : k)));
  };

  // ─── Per-parameter animated tracks (Premiere-style stopwatch) ─────────────
  // Independent of the unified keyframe system above — see keyframes.ts's
  // resolveAnimatedParams and the plan doc for the full design.

  const toggleParamAnimation = (key: AnimatableParamKey) => {
    const vid = videoRef.current;
    if (!vid) return;
    const existing = paramTracks[key];
    if (existing && existing.length > 0) {
      // Turning off: delete every keyframe on this param's track — fully
      // reverts to a single static value (params[key], left at whatever it
      // last was). Deliberately destructive-on-toggle-off, matching
      // Premiere's own stopwatch-off behavior.
      setParamTracks(tracks => {
        const next = { ...tracks };
        delete next[key];
        return next;
      });
      setSelectedParamKeyframeIds(sel => ({ ...sel, [key]: null }));
      return;
    }
    // Turning on: seed the track with one keyframe at the current playhead
    // time, holding the *actually displayed/rendering* value — turning it
    // on causes zero visible change, mirroring Premiere's stopwatch exactly.
    // Resolved fresh off vid.currentTime via refs (matching addKeyframe's
    // own pattern), not raw params[key]: if a unified keyframe currently
    // governs this field (no per-param track yet), params[key] can be
    // stale relative to what's actually showing/rendering — using it
    // directly would make the stopwatch visibly snap the output.
    const id = `pkf_${nextParamKfId++}`;
    const unified = keyframesRef.current.length > 0
      ? resolveActiveParams(keyframesRef.current, vid.currentTime, paramsRef.current)
      : paramsRef.current;
    const captured = resolveParamValue(paramTracksRef.current[key], vid.currentTime, unified[key] as number | string);
    const newKf: ParamKeyframe = { id, time: vid.currentTime, value: captured, curve: 'hold' };
    setParamTracks(tracks => ({ ...tracks, [key]: [newKf] }));
    setSelectedParamKeyframeIds(sel => ({ ...sel, [key]: id }));
  };

  // Sidebar slider onChange for the 9 animatable fields. Precedence rule:
  // animation off for this param (no track / empty track) -> identical to
  // editing any other non-animatable field today (setParam). Animation on:
  // find a keyframe within MIN_KEYFRAME_GAP of the current playhead — if
  // found, update its value in place; otherwise add a new keyframe at the
  // current time with curve 'hold' (the default for a freshly-added
  // keyframe; flip to linear afterward via the ANIMATED PARAMS row's
  // toggle). This mirrors "park the playhead, then drag the parameter".
  const setAnimatableParam = (key: AnimatableParamKey, value: number | string) => {
    const coerced = typeof value === 'string' && !isNaN(+value) ? +value : value;
    const track = paramTracks[key];
    if (!track || track.length === 0) {
      setParam(key, coerced);
      return;
    }
    const time = videoRef.current?.currentTime ?? currentTime;
    const nearby = track.find(k => Math.abs(k.time - time) < MIN_KEYFRAME_GAP);
    if (nearby) {
      const nearbyId = nearby.id;
      setParamTracks(tracks => ({
        ...tracks,
        [key]: (tracks[key] ?? []).map(k => (k.id === nearbyId ? { ...k, value: coerced } : k)),
      }));
      setSelectedParamKeyframeIds(sel => ({ ...sel, [key]: nearbyId }));
      return;
    }
    const id = `pkf_${nextParamKfId++}`;
    const newKf: ParamKeyframe = { id, time, value: coerced, curve: 'hold' };
    setParamTracks(tracks => ({ ...tracks, [key]: [...(tracks[key] ?? []), newKf] }));
    setSelectedParamKeyframeIds(sel => ({ ...sel, [key]: id }));
  };

  const retimeParamKeyframe = (key: AnimatableParamKey, id: string, time: number) => {
    setParamTracks(tracks => {
      const track = tracks[key] ?? [];
      return { ...tracks, [key]: track.map(k => (k.id === id ? { ...k, time: clampKeyframeTime(track, id, time, duration) } : k)) };
    });
  };

  const deleteParamKeyframe = (key: AnimatableParamKey, id: string) => {
    setParamTracks(tracks => {
      const track = (tracks[key] ?? []).filter(k => k.id !== id);
      if (track.length === 0) {
        const next = { ...tracks };
        delete next[key];
        return next;
      }
      return { ...tracks, [key]: track };
    });
    setSelectedParamKeyframeIds(sel => (sel[key] === id ? { ...sel, [key]: null } : sel));
  };

  const setParamKeyframeCurve = (key: AnimatableParamKey, id: string, curve: CurveType) => {
    setParamTracks(tracks => ({
      ...tracks,
      [key]: (tracks[key] ?? []).map(k => (k.id === id ? { ...k, curve } : k)),
    }));
  };

  // Double-click-to-add on a ParamTrackRow's own track — mirrors the
  // unified TimelineBar's addKeyframeAt (seek-then-add) convention, but
  // these rows never scrub video, so there's no seek involved: the new
  // keyframe's value is whatever the track already resolves to at that
  // time (so adding one causes zero visible change, same rationale as the
  // stopwatch's own turn-on behavior), landing exactly at the clicked time.
  const addParamKeyframeAt = (key: AnimatableParamKey, time: number) => {
    const track = paramTracksRef.current[key] ?? [];
    const id = `pkf_${nextParamKfId++}`;
    const clamped = clampKeyframeTime(track, id, time, duration);
    // Same fallback-correctness fix as toggleParamAnimation: resolve the
    // actually-active value (the unified timeline's, if it currently
    // governs this field) rather than raw params[key], which can be
    // stale relative to what's actually rendering. Currently unreachable
    // in practice — AnimatedParamsPanel only wires onAddAt for a key whose
    // track already has >=1 keyframe, so this fallback is never actually
    // consulted by resolveParamValue today — but fixed anyway for
    // consistency/defensiveness in case that invariant ever changes.
    const unified = keyframesRef.current.length > 0
      ? resolveActiveParams(keyframesRef.current, clamped, paramsRef.current)
      : paramsRef.current;
    const value = resolveParamValue(track, clamped, unified[key] as number | string);
    const newKf: ParamKeyframe = { id, time: clamped, value, curve: 'hold' };
    setParamTracks(tracks => ({ ...tracks, [key]: [...(tracks[key] ?? []), newKf] }));
    setSelectedParamKeyframeIds(sel => ({ ...sel, [key]: id }));
  };

  const selectParamKeyframe = (key: AnimatableParamKey, id: string | null) => {
    setSelectedParamKeyframeIds(sel => ({ ...sel, [key]: id }));
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
      <video ref={videoRef} src={videoSrc || undefined} loop playsInline style={{ display: 'none' }} />
      <canvas
        ref={canvasRef}
        className={`main-canvas ${isRecording ? 'recording' : ''}`}
        style={previewSize ? { width: previewSize.w, height: previewSize.h } : undefined}
        onClick={togglePlay}
      />
      {videoSrc && showUI && dockVisible && (
        <TransportDock
          isPaused={isPaused}
          onTogglePlay={togglePlay}
          onRestart={restart}
          currentTime={currentTime}
          duration={duration}
          onSeek={seekTo}
          keyframes={keyframes}
          selectedId={selectedKeyframeId}
          onSelect={setSelectedKeyframeId}
          onDelete={deleteKeyframe}
          onRetime={retimeKeyframe}
          onAddKeyframe={addKeyframe}
          disabled={isRecording || isEncoding}
          paramTracks={paramTracks}
          selectedParamKeyframeIds={selectedParamKeyframeIds}
          onSelectParamKeyframe={selectParamKeyframe}
          onRetimeParamKeyframe={retimeParamKeyframe}
          onDeleteParamKeyframe={deleteParamKeyframe}
          onAddParamKeyframeAt={addParamKeyframeAt}
          onSetParamKeyframeCurve={setParamKeyframeCurve}
          pos={dockPos}
          onPosChange={setDockPos}
          onHide={() => setDockVisible(false)}
        />
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
              <span className="panel-ver panel-hide-btn" onClick={() => setShowUI(false)} title="Hide UI (Ctrl+K)">⌃K HIDE</span>
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
                  <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
                    <StopwatchToggle active={!!paramTracks.renderMode?.length} onClick={() => toggleParamAnimation('renderMode')} paramLabel="RENDER MODE" />
                  </div>
                  <div className="mode-grid">
                    {MODES.map(m => (
                      <button key={m.id} className={`mode-btn${activeRenderMode === m.id ? ' active' : ''}`}
                        onClick={() => setAnimatableParam('renderMode', m.id)}>{m.label}</button>
                    ))}
                  </div>
                  {activeRenderMode === 'ASCII_BOX' && (
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
                    {activeRenderMode !== 'TRAIL_PATH' && (
                      <ColorRow
                        label="STROKE"
                        value={animatedDisplay.strokeColor as string}
                        onChange={v => setAnimatableParam('strokeColor', v)}
                        animated={!!paramTracks.strokeColor?.length}
                        onToggleAnimate={() => toggleParamAnimation('strokeColor')}
                      />
                    )}
                    <ColorRow label="TEXT" value={displayParams.textColor} onChange={v => setDisplayParam('textColor', v)} />
                  </Row2>
                  <Row2>
                    {activeRenderMode !== 'TRAIL_PATH' && (
                      <BrutSlider
                        label="STROKE W"
                        value={animatedDisplay.strokeWidth as number}
                        min={0.5} max={8} step={0.5}
                        onChange={v => setAnimatableParam('strokeWidth', v)}
                        animated={!!paramTracks.strokeWidth?.length}
                        onToggleAnimate={() => toggleParamAnimation('strokeWidth')}
                      />
                    )}
                    <BrutSlider label="FONT PX" value={displayParams.fontSize} min={6} max={48} step={1} onChange={v => setDisplayParam('fontSize', v)} />
                  </Row2>
                  {activeRenderMode !== 'TRAIL_PATH' && <BrutSlider label="LINKS" value={displayParams.neighborLinks} min={0} max={12} step={1} onChange={v => setDisplayParam('neighborLinks', v)} />}
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
                    <BrutSlider label="BRIGHTNESS" value={animatedDisplay.brightness as number} min={0} max={2} step={0.05} onChange={v => setAnimatableParam('brightness', v)} animated={!!paramTracks.brightness?.length} onToggleAnimate={() => toggleParamAnimation('brightness')} />
                    <BrutSlider label="CONTRAST" value={animatedDisplay.contrast as number} min={0} max={2} step={0.05} onChange={v => setAnimatableParam('contrast', v)} animated={!!paramTracks.contrast?.length} onToggleAnimate={() => toggleParamAnimation('contrast')} />
                  </Row2>
                  <Row2>
                    <BrutSlider label="SATURATION" value={animatedDisplay.saturation as number} min={0} max={2} step={0.05} onChange={v => setAnimatableParam('saturation', v)} animated={!!paramTracks.saturation?.length} onToggleAnimate={() => toggleParamAnimation('saturation')} />
                    <BrutSlider label="HUE" value={animatedDisplay.hue as number} min={-180} max={180} step={1} onChange={v => setAnimatableParam('hue', v)} animated={!!paramTracks.hue?.length} onToggleAnimate={() => toggleParamAnimation('hue')} />
                  </Row2>
                  <Row2>
                    <BrutSlider label="GAMMA" value={animatedDisplay.gamma as number} min={0.2} max={3} step={0.05} onChange={v => setAnimatableParam('gamma', v)} animated={!!paramTracks.gamma?.length} onToggleAnimate={() => toggleParamAnimation('gamma')} />
                    <BrutSlider label="TEMPERATURE" value={animatedDisplay.temperature as number} min={-1} max={1} step={0.05} onChange={v => setAnimatableParam('temperature', v)} animated={!!paramTracks.temperature?.length} onToggleAnimate={() => toggleParamAnimation('temperature')} />
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
                  <div className="toggle-row"><span>SHOW TRANSPORT DOCK</span><BrutToggle value={dockVisible} onChange={setDockVisible} /></div>
                  <div className="hint-text">
                    {keyframes.length === 0
                      ? 'No keyframes — export uses the static settings above. Use the dock at the bottom of the screen to add one.'
                      : `${keyframes.length} keyframe${keyframes.length > 1 ? 's' : ''} — use the dock at the bottom of the screen to navigate, add, retime, or delete.`}
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

            {videoError && (
              <div className="empty-hint error-hint">
                {videoError}<br />
                Try re-exporting as MP4 (H.264) or WebM (VP9). There's no
                enforced file-size limit, but very large files may still
                fail or run slowly depending on your browser/hardware.
              </div>
            )}

            {!videoSrc && !videoError && (
              <div className="empty-hint">
                Load a video to start.<br />
                Blobs track real motion regions.<br />
                <kbd>CTRL+K</kbd> hides everything.
                <div className="hint-text" style={{ marginTop: 10 }}>
                  Performance (preview smoothness, export speed) depends on
                  your device, browser, and screen resolution — heavier
                  render modes and color grading cost more.
                </div>
                <div className="hint-text" style={{ marginTop: 6 }}>
                  For best performance: use Chrome or Edge (fastest hardware
                  video decode/encode), close other GPU-heavy tabs/apps,
                  avoid battery-saver mode on laptops, pick a lower export
                  resolution if it's slow, and keep color grading + heavy
                  modes (GHOST_TRAIL, MESH_TRIANGULATE) off unless needed.
                </div>
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

function BrutSlider({ label, value, min, max, step, onChange, hint, invert, animated, onToggleAnimate }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: string) => void; hint?: string; invert?: boolean;
  /** Present only for one of the 9 per-parameter-animatable fields — renders the stopwatch toggle inline with the label. */
  animated?: boolean; onToggleAnimate?: () => void;
}) {
  const display = invert
    ? (max + min - value).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)
    : typeof value === 'number' ? value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0) : value;
  return (
    <div className="brut-slider" title={hint}>
      <div className="brut-slider-header">
        <span className="row gap-4">
          {onToggleAnimate && <StopwatchToggle active={!!animated} onClick={onToggleAnimate} paramLabel={label} />}
          <span>{label}</span>
        </span>
        <span className="val">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function ColorRow({ label, value, onChange, animated, onToggleAnimate }: {
  label: string; value: string; onChange: (v: string) => void;
  animated?: boolean; onToggleAnimate?: () => void;
}) {
  return (
    <div className="color-row">
      <span className="row gap-4">
        {onToggleAnimate && <StopwatchToggle active={!!animated} onClick={onToggleAnimate} paramLabel={label} />}
        <span>{label}</span>
      </span>
      <div className="color-right">
        <span className="color-hex">{value.toUpperCase()}</span>
        <input type="color" value={value} onChange={e => onChange(e.target.value)} className="color-input" />
      </div>
    </div>
  );
}

/** Small clock-icon stopwatch button — turns a parameter's own keyframe track on/off, Premiere-style. See toggleParamAnimation in App.tsx for the on/off semantics. */
function StopwatchToggle({ active, onClick, paramLabel }: { active: boolean; onClick: () => void; paramLabel: string }) {
  return (
    <button
      type="button"
      className={`stopwatch-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={active ? `Animated — click to remove all keyframes for ${paramLabel}` : `Click to animate ${paramLabel} over time`}
    >
      <Clock size={11} />
    </button>
  );
}

function BrutToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`brut-toggle${value ? ' on' : ''}`} onClick={() => onChange(!value)}>
      {value ? 'ON' : 'OFF'}
    </button>
  );
}
