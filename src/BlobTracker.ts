/**
 * BlobTracker.ts — Real blob tracking + 8 render modes
 *
 * Algorithm:
 *  1. Frame differencing (luminance-weighted per-pixel diff on proxy canvas)
 *  2. Union-Find connected component labeling on motion mask
 *  3. Hungarian-style nearest-centroid assignment across frames
 *  4. Per-track trail history maintained for trajectory modes
 *  5. Heatmap accumulation canvas (separate overlay)
 *
 * Modes (inspired by BlobTracking.jl + nouses_kou aesthetic):
 *  BOX_INVERT    Classic inverted fill bounding box
 *  OUTLINE       Outline only + subtle fill
 *  CENTROID_NET  Curved centroid network (quadratic bezier links)
 *  GHOST_TRAIL   Decaying motion trail (fading boxes)
 *  CROSS_HAIR    Military targeting reticle
 *  ELLIPSE       Covariance-style concentric ellipses (Kalman aesthetic)
 *  TRAIL_PATH    Full trajectory: spawn=green, path=blue, active=red (BlobTracking.jl)
 *  HEATMAP       Persistent density accumulation overlay
 */

export type RenderMode =
  | 'BOX_INVERT'
  | 'ASCII_BOX'
  | 'OUTLINE'
  | 'CENTROID_NET'
  | 'GHOST_TRAIL'
  | 'ELLIPSE'
  | 'TRAIL_PATH';

export interface TrackedBlob {
  id: number;
  cx: number;
  cy: number;
  x: number; y: number; w: number; h: number;
  area: number;
  life: number;
  spawnX: number; spawnY: number;
  trail: { x: number; y: number }[];
}

export interface TrackerParams {
  // Motion detection
  diffThreshold: number;
  minArea: number;
  maxArea: number;
  maxBlobs: number;
  lifeFrames: number;
  jitter: number;
  maxBlobDim: number;     // Max width OR height of a blob in proxy-pixels (caps blob size)
  // Density
  subdivide: number;       // split each detected blob into NxN sub-boxes (1=off, 2=4 boxes, 3=9, etc.)
  // Visual
  renderMode: RenderMode;
  neighborLinks: number;
  strokeColor: string;
  textColor: string;
  strokeWidth: number;
  fontSize: number;
  fontFamily: string;
  asciiContrast: number;   // for ASCII_BOX: brightness gamma 0.5–3
  showCoordinates: boolean;
  showId: boolean;
  showSize: boolean;
  showLabelBG: boolean;
}

let nextId = 1;
const PROXY_W = 320;

export class BlobTracker {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private proxyCanvas: HTMLCanvasElement;
  private proxyCtx: CanvasRenderingContext2D;

  private prevData: Uint8ClampedArray | null = null;
  private currFramePixels: Uint8ClampedArray | null = null;
  private blobs: TrackedBlob[] = [];
  private baseParams: TrackerParams;
  private params: TrackerParams;

  private isPlaying = false;
  width = 0; height = 0;
  private liveParamsResolver: ((time: number) => TrackerParams) | null = null;
  private proxyH = 0;
  private scaleX = 1; private scaleY = 1;
  private lastFrameTime = 0;

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, params: TrackerParams) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.baseParams = params;
    this.params = params;

    this.proxyCanvas = document.createElement('canvas');
    this.proxyCtx = this.proxyCanvas.getContext('2d', { willReadFrequently: true })!;

    this.resize();
  }

  public updateParams(p: Partial<TrackerParams>) {
    this.baseParams = { ...this.baseParams, ...p };
    if (!this.liveParamsResolver) this.params = this.baseParams;
  }

  /**
   * When set, called with the video's current time on every rendered
   * frame; the returned params replace `this.params` for that frame. Used
   * by the keyframe system so preview and export stay in sync. Pass null
   * to go back to static params driven only by updateParams().
   */
  public setLiveParamsResolver(fn: ((time: number) => TrackerParams) | null) {
    this.liveParamsResolver = fn;
    if (!fn) this.params = this.baseParams;
  }

  public resize(w?: number, h?: number, bypassCap = false) {
    const isExport = bypassCap && w !== undefined && h !== undefined;

    if (isExport) {
      this.width = w!;
      this.height = h!;
    } else {
      // Fit canvas to viewport while preserving video aspect ratio
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const videoW = this.video.videoWidth || 1920;
      const videoH = this.video.videoHeight || 1080;
      const aspect = videoW / videoH;

      if (vw / vh > aspect) {
        this.height = vh;
        this.width = Math.round(vh * aspect);
      } else {
        this.width = vw;
        this.height = Math.round(vw / aspect);
      }
    }

    // DPR=1 for export (exact pixels); capped at 2 for preview
    const dpr = isExport ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const oldPH = this.proxyH;
    const videoAspect = (this.video.videoHeight || 1080) / (this.video.videoWidth || 1920);
    this.proxyH = Math.max(1, Math.round(PROXY_W * videoAspect));
    this.proxyCanvas.width  = PROXY_W;
    this.proxyCanvas.height = this.proxyH;

    this.scaleX = this.width / PROXY_W;
    this.scaleY = this.height / this.proxyH;

    // Preserve tracking state if proxy resolution is identical
    if (this.proxyH !== oldPH) {
      this.prevData = null;
    }
  }

  public toSVG(): string {
    const p = this.params;
    const blobs = this.getDisplayBlobs();
    const s = this.getS();
    
    let svg = `<svg viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">`;
    
    // Add background rect if in certain modes
    if (p.renderMode === 'BOX_INVERT') {
      svg += `<rect width="100%" height="100%" fill="black" />`;
    }

    // Helper for labels
    const getLabelSVG = (b: TrackedBlob, lx: number, ly: number) => {
      const lines: string[] = [];
      if (p.showId)          lines.push(`ID ${b.id}`);
      if (p.showCoordinates) lines.push(`${Math.floor(b.cx)}  ${Math.floor(b.cy)}`);
      if (p.showSize)        lines.push(`${Math.floor(b.w)}×${Math.floor(b.h)}`);
      if (!lines.length) return '';

      const fh = (p.fontSize + 3) * s;
      const padding = 5 * s;
      const totalH = (lines.length * fh) + (4 * s);
      let finalY = ly - (2 * s);
      if (finalY - totalH < 0) finalY = ly + totalH + (2 * s);

      let labelSvg = '';
      lines.forEach((line, i) => {
        const ty = Math.round(finalY - (4 * s) - (i * fh));
        labelSvg += `<text x="${lx + padding}" y="${ty}" fill="${p.textColor}" font-family="${p.fontFamily}" font-size="${p.fontSize * s}" font-weight="bold">${line}</text>`;
      });
      return labelSvg;
    };

    // Render modes to SVG
    if (p.neighborLinks > 0) {
      for (let i = 0; i < this.blobs.length; i++) {
        const bi = this.blobs[i];
        this.blobs
          .map((bj, j) => ({ d: Math.hypot(bi.cx-bj.cx, bi.cy-bj.cy), j }))
          .filter(d => d.j !== i).sort((a,b) => a.d-b.d)
          .slice(0, p.neighborLinks)
          .forEach(({ j }) => {
            const bj = this.blobs[j];
            svg += `<line x1="${bi.cx}" y1="${bi.cy}" x2="${bj.cx}" y2="${bj.cy}" stroke="${p.strokeColor}" stroke-width="${p.strokeWidth * 0.55 * s}" />`;
          });
      }
    }

    switch (p.renderMode) {
      case 'BOX_INVERT':
        for (const b of blobs) {
          svg += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="white" />`;
          svg += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="${p.strokeColor}" stroke-width="${p.strokeWidth * s}" />`;
          if (b.id < 1000 || b.id % 1000 === 0) svg += getLabelSVG(b, b.x, b.y);
        }
        break;
      case 'OUTLINE':
        for (const b of blobs) {
          svg += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${this.rgba(p.strokeColor, 0.08)}" stroke="${p.strokeColor}" stroke-width="${p.strokeWidth * s}" />`;
          if (b.id < 1000 || b.id % 1000 === 0) svg += getLabelSVG(b, b.x, b.y);
        }
        break;
      case 'CENTROID_NET':
        for (const b of blobs) {
          const r = Math.max(2, Math.round(b.w / 8));
          svg += `<circle cx="${b.cx}" cy="${b.cy}" r="${r}" fill="${p.strokeColor}" />`;
          svg += `<circle cx="${b.cx}" cy="${b.cy}" r="${r*2.8}" fill="none" stroke="${p.strokeColor}" stroke-width="${p.strokeWidth * s}" />`;
          if (b.id < 1000 || b.id % 1000 === 0) svg += getLabelSVG(b, b.cx + (10 * s), b.cy - (p.fontSize * s));
        }
        break;
      case 'ELLIPSE':
        for (const b of blobs) {
          const r = (b.w + b.h) / 4;
          svg += `<circle cx="${b.cx}" cy="${b.cy}" r="${r * 1.2}" fill="${this.rgba(p.strokeColor, 0.1)}" />`;
          for (let i = 0; i < 3; i++) {
            const rs = 0.5 + i * 0.25;
            svg += `<circle cx="${b.cx}" cy="${b.cy}" r="${r * 2 * rs}" fill="none" stroke="${p.strokeColor}" stroke-width="${p.strokeWidth * s}" />`;
          }
          svg += getLabelSVG(b, b.cx + r * 1.4 + 6, b.cy - p.fontSize);
        }
        break;
      case 'TRAIL_PATH':
        for (const b of blobs) {
          svg += `<circle cx="${b.spawnX}" cy="${b.spawnY}" r="${Math.max(4, p.strokeWidth * 2.5)}" fill="#00ff66" />`;
          svg += `<circle cx="${b.cx}" cy="${b.cy}" r="${Math.max(5, p.strokeWidth * 3)}" fill="#ff2d00" />`;
          svg += getLabelSVG(b, b.cx + 10, b.cy - p.fontSize);
        }
        break;
    }

    svg += '</svg>';
    return svg;
  }

  public start() {
    this.isPlaying = true;
    // Use requestVideoFrameCallback for frame-accurate processing (no wasted cycles)
    if ('requestVideoFrameCallback' in this.video) {
      (this.video as any).requestVideoFrameCallback(this.rvfcLoop);
    } else {
      this.loop();
    }
  }
  public stop() { this.isPlaying = false; }

  /** Repaints the current frame with current params, without motion detection or blob aging. Used to refresh the preview after a param edit while paused. */
  public renderOnce() {
    if (!this.width || !this.height) return;
    if (this.liveParamsResolver) {
      this.params = this.liveParamsResolver(this.video.currentTime);
    }
    this.drawVideoFrame();
    this.renderBlobs();
  }

  private rvfcLoop = () => {
    if (!this.isPlaying) return;
    this.processFrame();
    (this.video as any).requestVideoFrameCallback(this.rvfcLoop);
  };

  private loop = () => {
    if (!this.isPlaying) return;
    requestAnimationFrame(this.loop);
    // Throttle to ~30fps to avoid processing duplicate video frames
    const now = performance.now();
    if (now - this.lastFrameTime < 30) return;
    this.lastFrameTime = now;
    this.processFrame();
  };

  // ─── PIPELINE ─────────────────────────────────────────────────────────────

  // Scaling helper for resolution-independent detail (baseline 1280px)
  private getS() { return this.width / 1280; }

  private drawVideoFrame() {
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    const isMonoMode = (this.params.renderMode === 'TRAIL_PATH' || this.params.renderMode === 'ASCII_BOX');
    this.ctx.filter = isMonoMode ? 'grayscale(100%) brightness(1.0) contrast(1.5)' : 'none';
    this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    this.ctx.filter = 'none';

    // Set smoothing to false for sharp brutalist graphics/text
    this.ctx.imageSmoothingEnabled = false;
  }

  private processFrame() {
    if (!this.width || !this.height) return;

    if (this.liveParamsResolver) {
      this.params = this.liveParamsResolver(this.video.currentTime);
    }

    this.drawVideoFrame();

    this.proxyCtx.drawImage(this.video, 0, 0, PROXY_W, this.proxyH);

    const frame = this.proxyCtx.getImageData(0, 0, PROXY_W, this.proxyH);
    const curr  = frame.data;

    if (!this.prevData || this.prevData.length !== curr.length) {
      this.prevData = new Uint8ClampedArray(curr); return;
    }

    const mask     = this.diffMask(curr, this.prevData);
    const detected = this.labelComponents(mask, PROXY_W, this.proxyH);
    this.matchAndUpdate(detected);

    // Age out
    for (let i = this.blobs.length - 1; i >= 0; i--) {
      if (--this.blobs[i].life <= 0) this.blobs.splice(i, 1);
    }

    this.prevData.set(curr);
    this.currFramePixels = curr;

    this.renderBlobs();
  }

  // ─── MOTION DETECTION ─────────────────────────────────────────────────────

  private diffMask(curr: Uint8ClampedArray, prev: Uint8ClampedArray): Uint8ClampedArray {
    const n   = curr.length >> 2;
    const out = new Uint8ClampedArray(n);
    const thr = this.params.diffThreshold;
    for (let i = 0; i < n; i++) {
      const p = i << 2;
      const d = 0.299 * Math.abs(curr[p]-prev[p]) + 0.587 * Math.abs(curr[p+1]-prev[p+1]) + 0.114 * Math.abs(curr[p+2]-prev[p+2]);
      out[i] = d > thr ? 1 : 0;
    }
    return out;
  }

  private labelComponents(mask: Uint8ClampedArray, w: number, h: number) {
    const labels = new Int32Array(mask.length);
    const parent: number[] = [0];

    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x;
    };
    const unite = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

    let nl = 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y*w+x; if (!mask[idx]) continue;
        const up = y > 0 ? labels[(y-1)*w+x] : 0;
        const lf = x > 0 ? labels[y*w+x-1] : 0;
        if (!up && !lf) { labels[idx] = nl; parent.push(nl); nl++; }
        else if (up && !lf) labels[idx] = find(up);
        else if (!up && lf) labels[idx] = find(lf);
        else { unite(up,lf); labels[idx] = find(up); }
      }
    }

    type S = { sx:number; sy:number; area:number; x1:number; y1:number; x2:number; y2:number };
    const stats = new Map<number, S>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y*w+x; if (!labels[idx]) continue;
        const r = find(labels[idx]);
        let s = stats.get(r);
        if (!s) { s = { sx:0,sy:0,area:0,x1:x,y1:y,x2:x,y2:y }; stats.set(r, s); }
        s.sx += x; s.sy += y; s.area++;
        if (x<s.x1) s.x1=x; if (x>s.x2) s.x2=x; if (y<s.y1) s.y1=y; if (y>s.y2) s.y2=y;
      }
    }

    return Array.from(stats.values())
      .filter(s => s.area >= this.params.minArea && s.area <= this.params.maxArea)
      .sort((a,b) => b.area - a.area)
      .slice(0, this.params.maxBlobs * 2)
      .map(s => ({
        cx: s.sx/s.area, cy: s.sy/s.area,
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, area: s.area
      }));
  }

  private matchAndUpdate(detected: Array<{ cx:number; cy:number; x1:number; y1:number; x2:number; y2:number; area:number }>) {
    const maxDist = 80;
    const matched = new Set<number>();

    for (const det of detected) {
      const fcx = det.cx * this.scaleX, fcy = det.cy * this.scaleY;
      const fw  = (det.x2 - det.x1) * this.scaleX, fh = (det.y2 - det.y1) * this.scaleY;

      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < this.blobs.length; i++) {
        if (matched.has(i)) continue;
        const d = Math.hypot(fcx - this.blobs[i].cx, fcy - this.blobs[i].cy);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }

      if (bestIdx >= 0 && bestDist < maxDist * this.scaleX) {
        const b = this.blobs[bestIdx];
        b.trail.push({ x: b.cx, y: b.cy });
        if (b.trail.length > 60) b.trail.shift();
        
        b.cx = fcx; 
        b.cy = fcy;
        b.w = Math.min(fw, this.params.maxBlobDim * this.scaleX);
        b.h = Math.min(fh, this.params.maxBlobDim * this.scaleY);
        b.x = fcx - b.w / 2;
        b.y = fcy - b.h / 2;
        
        b.area = det.area;
        b.life = this.params.lifeFrames;
        matched.add(bestIdx);
      } else if (this.blobs.length < this.params.maxBlobs) {
        const w = Math.min(fw, this.params.maxBlobDim * this.scaleX);
        const h = Math.min(fh, this.params.maxBlobDim * this.scaleY);
        this.blobs.push({ 
          id: nextId++, 
          cx: fcx, cy: fcy, 
          x: fcx - w / 2, y: fcy - h / 2, 
          w, h, 
          area: det.area,
          life: this.params.lifeFrames, 
          spawnX: fcx, spawnY: fcy, 
          trail: [] 
        });
      }
    }

  }

  private getDisplayBlobs(): TrackedBlob[] {
    const n = Math.floor(this.params.subdivide);
    if (n <= 1) return this.blobs;

    const subBlobs: TrackedBlob[] = [];
    for (const b of this.blobs) {
      if (b.w <= 0 || b.h <= 0) { subBlobs.push(b); continue; }
      const sw = b.w / n, sh = b.h / n;
      if (sw < 1 || sh < 1) { subBlobs.push(b); continue; }
      
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const sx = b.x + col * sw, sy = b.y + row * sh;
          const scx = sx + sw / 2, scy = sy + sh / 2;
          subBlobs.push({
            ...b,
            id: b.id * 1000 + row * n + col,
            cx: scx, cy: scy, x: sx, y: sy, w: sw, h: sh,
            area: b.area / (n * n),
          });
        }
      }
    }
    return subBlobs;
  }

  // ─── RENDER DISPATCH ──────────────────────────────────────────────────────

  private renderBlobs() {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;

    const displayBlobs = this.getDisplayBlobs();

    switch (this.params.renderMode) {
      case 'BOX_INVERT':    this.renderBoxInvert(displayBlobs);   break;
      case 'ASCII_BOX':     this.renderASCIIBox(displayBlobs);    break;
      case 'OUTLINE':       this.renderOutline(displayBlobs);      break;
      case 'CENTROID_NET':  this.renderCentroidNet(displayBlobs);  break;
      case 'GHOST_TRAIL':   this.renderGhostTrail(displayBlobs);   break;
      case 'ELLIPSE':       this.renderEllipse(displayBlobs);      break;
      case 'TRAIL_PATH':    this.renderTrailPath(displayBlobs);    break;
    }

    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';
  }

  // ─── MODE: BOX_INVERT ─────────────────────────────────────────────────────

  private renderBoxInvert(displayBlobs: TrackedBlob[]) {
    this.prepFont();

    // Step 1: full-strength inversion fill (alpha=1 = true bitwise NOT like cv2.bitwise_not)
    this.ctx.globalCompositeOperation = 'difference';
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#ffffff';
    for (const b of displayBlobs) {
      if (b.w > 0 && b.h > 0) this.ctx.fillRect(b.x, b.y, b.w, b.h);
    }

    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.drawLinks();

    this.ctx.strokeStyle = this.params.strokeColor;
    this.ctx.lineWidth   = this.params.strokeWidth * this.getS();
    this.ctx.lineJoin    = 'miter'; 
    for (let i = 0; i < displayBlobs.length; i++) {
      const b = displayBlobs[i];
      if (b.w > 0 && b.h > 0) {
        this.ctx.strokeRect(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h));
        // Label check: show if it's the primary blob or the first sub-blob
        if (b.id < 1000 || b.id % 1000 === 0) {
          this.drawLabel(b, Math.round(b.x), Math.round(b.y));
        }
      }
    }
  }

  // ─── MODE: ASCII_BOX ──────────────────────────────────────────────────────

  private renderASCIIBox(displayBlobs: TrackedBlob[]) {
    // ASCII ramp: dark (dense) → bright (sparse)
    const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
    const p    = this.params;
    const gamma = Math.max(0.3, p.asciiContrast ?? 1);

    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;

    for (const b of displayBlobs) {
      if (b.w <= 0 || b.h <= 0) continue;

      const cellSize     = 16; 
      const cols         = Math.max(1, Math.floor(b.w / cellSize));
      const rows         = Math.max(1, Math.floor(b.h / cellSize));
      const cw           = b.w / cols;
      const ch           = b.h / rows;
      const charFontSize = 14; 

      this.ctx.font         = `bold ${charFontSize}px monospace`;
      this.ctx.textAlign    = 'center';
      this.ctx.textBaseline = 'middle';

      if (!this.currFramePixels) continue;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const px = b.x + col * cw + cw / 2;
          const py = b.y + row * ch + ch / 2;

          const ox = Math.min(PROXY_W - 1, Math.floor(px / this.scaleX));
          const oy = Math.min(this.proxyH - 1, Math.floor(py / this.scaleY));
          
          // Fast read from stored frame buffer
          const pIdx = (oy * PROXY_W + ox) * 4;
          const r = this.currFramePixels[pIdx];
          const g = this.currFramePixels[pIdx + 1];
          const b_ = this.currFramePixels[pIdx + 2];
          
          let lum  = (0.299 * r + 0.587 * g + 0.114 * b_) / 255;
          lum = Math.pow(lum, 1 / gamma);

          const charIdx = Math.floor(lum * (RAMP.length - 1));
          const ch_str  = RAMP[charIdx];

          this.ctx.fillStyle = '#000000';
          this.ctx.fillText(ch_str, px + 0.6, py + 0.6);
          this.ctx.fillStyle = '#ffffff';
          this.ctx.fillText(ch_str, px, py);
        }
      }
    }

    // Draw links and labels last
    this.ctx.font = `bold ${p.fontSize}px "${p.fontFamily}", monospace`;
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'bottom';
    this.drawLinks();
    for (const b of displayBlobs) {
      if (Math.floor(b.id) % 1000 === 0) {
        this.drawLabel(b, b.x, b.y);
      }
    }
  }

  // ─── MODE: OUTLINE ────────────────────────────────────────────────────────

  private renderOutline(displayBlobs: TrackedBlob[]) {
    this.drawLinks();
    this.prepFont();
    for (const b of displayBlobs) {
      const a = Math.min(1, b.life / this.params.lifeFrames);
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = a;
      this.ctx.strokeStyle = this.params.strokeColor;
      this.ctx.lineWidth = this.params.strokeWidth * this.getS();
      this.ctx.strokeRect(b.x, b.y, b.w, b.h);
      this.ctx.fillStyle = this.rgba(this.params.strokeColor, 0.08);
      this.ctx.fillRect(b.x, b.y, b.w, b.h);
      this.ctx.globalAlpha = 1;
      this.ctx.globalAlpha = 1;
      if (b.id < 1000 || b.id % 1000 === 0) {
        this.drawLabel(b, b.x, b.y);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  // ─── MODE: CENTROID_NET ───────────────────────────────────────────────────

  private renderCentroidNet(blobs: TrackedBlob[]) {
    this.ctx.globalCompositeOperation = 'source-over';
    const p = this.params;

    for (let i = 0; i < blobs.length; i++) {
      const bi = blobs[i];
      const nearest = blobs
        .map((bj, j) => ({ d: Math.hypot(bi.cx-bj.cx, bi.cy-bj.cy), j }))
        .filter(d => d.j !== i).sort((a,b) => a.d-b.d).slice(0, p.neighborLinks);

      for (const { j } of nearest) {
        const bj = blobs[j];
        const a  = Math.min(1, bi.life / p.lifeFrames) * 0.8;
        const mx = (bi.cx+bj.cx)/2, my = (bi.cy+bj.cy)/2;
        const cx = mx + (bi.cy-bj.cy)*0.3, cy = my - (bi.cx-bj.cx)*0.3;
        this.ctx.globalAlpha = a;
        this.ctx.strokeStyle = p.strokeColor;
        this.ctx.lineWidth   = p.strokeWidth * this.getS();
        this.ctx.beginPath();
        this.ctx.moveTo(bi.cx, bi.cy);
        this.ctx.quadraticCurveTo(cx, cy, bj.cx, bj.cy);
        this.ctx.stroke();
      }
    }
    this.ctx.globalAlpha = 1;
    this.prepFont();

    for (const b of blobs) {
      const a = Math.min(1, b.life / p.lifeFrames);
      const r = Math.max(2, Math.round(b.w / 8));
      this.ctx.globalAlpha = a;
      this.ctx.fillStyle   = p.strokeColor;
      this.ctx.beginPath(); this.ctx.arc(Math.round(b.cx), Math.round(b.cy), r, 0, Math.PI*2); this.ctx.fill();
      this.ctx.strokeStyle = p.strokeColor; this.ctx.lineWidth = p.strokeWidth * this.getS();
      this.ctx.beginPath(); this.ctx.arc(Math.round(b.cx), Math.round(b.cy), r*2.8, 0, Math.PI*2); this.ctx.stroke();
      // Primary blob labels only
      if (b.id < 1000 || b.id % 1000 === 0) {
        this.drawLabel(b, Math.round(b.cx + (10 * this.getS())), Math.round(b.cy - (this.params.fontSize * this.getS())));
      }
    }
    this.ctx.globalAlpha = 1;
  }

  // ─── MODE: GHOST_TRAIL ────────────────────────────────────────────────────

  private renderGhostTrail(displayBlobs: TrackedBlob[]) {
    this.prepFont();
    for (const b of displayBlobs) {
      const a = Math.min(1, b.life / this.params.lifeFrames);
      for (let t = 0; t < b.trail.length; t++) {
        const tp = b.trail[t];
        const ta = (t / b.trail.length) * a * 0.35;
        const ts = Math.max(4, b.w * (t/b.trail.length) * 0.75);
        const th = Math.max(4, b.h * (t/b.trail.length) * 0.75);
        this.ctx.globalCompositeOperation = 'difference';
        this.ctx.globalAlpha = ta;
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(tp.x-ts/2, tp.y-th/2, ts, th);
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.globalAlpha = ta * 2;
        this.ctx.strokeStyle = this.params.strokeColor;
        this.ctx.lineWidth = this.params.strokeWidth * 0.5 * this.getS();
        this.ctx.strokeRect(tp.x-ts/2, tp.y-th/2, ts, th);
      }
      this.ctx.globalCompositeOperation = 'difference';
      this.ctx.globalAlpha = a * 0.9;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(b.x, b.y, b.w, b.h);
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = 1;
      this.ctx.strokeStyle = this.params.strokeColor;
      this.ctx.lineWidth = this.params.strokeWidth;
      this.ctx.lineWidth = this.params.strokeWidth;
      this.ctx.strokeRect(b.x, b.y, b.w, b.h);
      if (Math.floor(b.id) % 1000 === 0) {
        this.drawLabel(b, b.x, b.y);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  // ─── MODE: ELLIPSE (Kalman covariance aesthetic) ──────────────────────────

  private renderEllipse(blobs: TrackedBlob[]) {
    this.drawLinks();
    this.prepFont();
    for (const b of blobs) {
      // True-circle radius: average of width/height halves, so the shape
      // is a circle regardless of the blob's bounding-box aspect ratio
      // (previously used b.w/b.h independently, which drew a distorted oval).
      const r = (b.w + b.h) / 4;
      const a = Math.min(1, b.life / this.params.lifeFrames);

      this.ctx.globalAlpha = a;
      this.ctx.strokeStyle = this.params.strokeColor;
      this.ctx.lineWidth   = this.params.strokeWidth * this.getS();

      this.ctx.fillStyle = this.rgba(this.params.strokeColor, 0.1);
      this.ctx.beginPath(); this.ctx.arc(b.cx, b.cy, r * 1.2, 0, Math.PI*2); this.ctx.fill();

      for (let i = 0; i < 3; i++) {
        const ringScale = 0.5 + i * 0.25;
        this.ctx.beginPath();
        this.ctx.arc(b.cx, b.cy, r * 2 * ringScale, 0, Math.PI*2);
        this.ctx.stroke();
      }

      this.ctx.globalAlpha = 1;
      // Centroid crosshair axes
      this.ctx.globalAlpha = a * 0.8;
      this.ctx.lineWidth   = this.params.strokeWidth * 0.8;
      this.ctx.beginPath();
      this.ctx.moveTo(b.cx - r * 0.4, b.cy); this.ctx.lineTo(b.cx + r * 0.4, b.cy);
      this.ctx.moveTo(b.cx, b.cy - r * 0.4); this.ctx.lineTo(b.cx, b.cy + r * 0.4);
      this.ctx.stroke();

      this.ctx.setLineDash([]);
      this.ctx.globalAlpha = 1;
      this.drawLabel(b, b.cx + r * 1.4 + 6, b.cy - this.params.fontSize);
    }
    this.ctx.setLineDash([]);
    this.ctx.globalAlpha = 1;
  }

  // ─── MODE: TRAIL_PATH (BlobTracking.jl style) ─────────────────────────────
  //  spawn dot = green, path = blue/strokeColor, current pos dot = red, lost = orange

  private renderTrailPath(blobs: TrackedBlob[]) {
    this.prepFont();
    for (const b of blobs) {
      const a = Math.min(1, b.life / this.params.lifeFrames);

      // No lines drawn, only point markers as requested

      // Spawn dot (green) — where blob was born
      this.ctx.globalAlpha = a * 0.9;
      this.ctx.fillStyle = '#00ff66';
      this.ctx.beginPath();
      this.ctx.arc(b.spawnX, b.spawnY, Math.max(4, this.params.strokeWidth * 2.5), 0, Math.PI*2);
      this.ctx.fill();

      // Current position dot (red = active, orange = fading)
      const isActive = b.life > this.params.lifeFrames * 0.5;
      this.ctx.fillStyle = isActive ? '#ff2d00' : '#ff8800';
      this.ctx.beginPath();
      this.ctx.arc(b.cx, b.cy, Math.max(5, this.params.strokeWidth * 3), 0, Math.PI*2);
      this.ctx.fill();

      this.ctx.globalAlpha = 1;
      this.drawLabel(b, b.cx + 10, b.cy - this.params.fontSize);
    }
    this.ctx.globalAlpha = 1;
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  private drawLinks() {
    const p = this.params;
    if (!p.neighborLinks) return;
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.strokeStyle = p.strokeColor;
    this.ctx.lineWidth   = p.strokeWidth * 0.55 * this.getS();
    this.ctx.beginPath();
    for (let i = 0; i < this.blobs.length; i++) {
      const bi = this.blobs[i];
      this.blobs
        .map((bj, j) => ({ d: Math.hypot(bi.cx-bj.cx, bi.cy-bj.cy), j }))
        .filter(d => d.j !== i).sort((a,b) => a.d-b.d)
        .slice(0, p.neighborLinks)
        .forEach(({ j }) => {
          this.ctx.moveTo(bi.cx, bi.cy);
          this.ctx.lineTo(this.blobs[j].cx, this.blobs[j].cy);
        });
    }
    this.ctx.stroke();
  }

  private prepFont() {
    const p = this.params;
    const s = this.getS();
    this.ctx.font         = `bold ${Math.round(p.fontSize * s)}px "${p.fontFamily}", monospace`;
    this.ctx.textAlign    = 'left';
    this.ctx.textBaseline = 'bottom';
  }

  private drawLabel(b: TrackedBlob, lx: number, ly: number) {
    const p = this.params;
    const s = this.getS();
    const lines: string[] = [];
    if (p.showId)          lines.push(`ID ${b.id}`);
    if (p.showCoordinates) lines.push(`${Math.floor(b.cx)}  ${Math.floor(b.cy)}`);
    if (p.showSize)        lines.push(`${Math.floor(b.w)}×${Math.floor(b.h)}`);
    if (!lines.length) return;

    const a  = Math.min(1, b.life / p.lifeFrames);
    const fh = (p.fontSize + 3) * s;
    const padding = 5 * s; // Tighter padding for small boxes
    
    // Calculate box metrics
    const totalH = (lines.length * fh) + (4 * s);
    
    // Safety: If blob is at top edge, shift label INSIDE the box
    let finalY = ly - (2 * s);
    if (finalY - totalH < 0) finalY = ly + totalH + (2 * s);

    // 2. Pure text (No decorations)
    this.ctx.globalAlpha = a;
    this.ctx.globalCompositeOperation = 'source-over';
    
    // IF INVERT MODE: Use difference to ensure visibility on white
    if (this.params.renderMode === 'BOX_INVERT') {
        this.ctx.globalCompositeOperation = 'difference';
    }

    lines.forEach((line, i) => {
      const ty = Math.round(finalY - (4 * s) - (i * fh));
      this.ctx.fillStyle = p.textColor;
      this.ctx.fillText(line, Math.round(lx + padding), ty);
    });
    
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';
  }

  private rgba(hex: string, a: number): string {
    const m = hex.match(/^#([0-9a-f]{6})$/i);
    if (!m) return hex;
    return `rgba(${parseInt(m[1].slice(0,2),16)},${parseInt(m[1].slice(2,4),16)},${parseInt(m[1].slice(4,6),16)},${a})`;
  }
}
