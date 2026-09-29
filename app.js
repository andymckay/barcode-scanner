/* =============================================================================
   Barcode Restorer
   -----------------------------------------------------------------------------
   A client-side-only single page app: take a photo of a barcode, decode it,
   then rebuild a clean, high-resolution barcode from the decoded data.

   Everything happens in this browser tab. No network calls, no storage beyond
   an optional localStorage entry holding the UI preferences.

   Sections
     1.  Helpers
     2.  Symbology tables
     3.  State
     4.  Source loading (file / clipboard / camera)
     5.  Preview sizing
     6.  Greyscale maths and image transforms
     7.  Decode pipeline
     8.  Results rendering
     9.  Barcode generation (JsBarcode for 1D, qrcode-generator for 2D)
     10. Render + export (SVG / PNG / clipboard / print)
     11. Saved barcode library (localStorage)
     12. Wiring and init
   ========================================================================== */

'use strict';

/* =============================================================================
   1. Helpers
   ========================================================================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Yield to the browser so the long pipeline does not freeze the UI.
 * requestAnimationFrame is paused in background tabs, so a timer races it —
 * otherwise a decode started just before switching tabs would never finish.
 */
const nextFrame = () => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
  setTimeout(finish, 60);
});

const round1 = (n) => Math.round(n * 10) / 10;

/** Bytes, with a sensible unit. */
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${round1(n / 1024)} kB`;
  return `${round1(n / (1024 * 1024))} MB`;
}

let toastTimer = null;
function toast(message, ms) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 250);
  }, ms || 2600);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** A filesystem-safe stem for downloads, derived from the decoded payload. */
function slugify(text) {
  const s = String(text || 'barcode')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'barcode';
}

/* =============================================================================
   2. Symbology tables
   ========================================================================== */

/**
 * Every format ZXing can decode, keyed by its ZXing enum name.
 *   id        stable key used by this app
 *   label     human name
 *   kind      '1d' | '2d'
 *   encoder   JsBarcode module name, 'QR', or null when we cannot rebuild it
 *   minMm     recommended minimum X-dimension (narrow bar / module) in mm
 */
const SYMBOLOGIES = {
  CODE_128:      { id: 'CODE128',    label: 'Code 128',       kind: '1d', encoder: 'CODE128',    minMm: 0.19 },
  CODE_39:       { id: 'CODE39',     label: 'Code 39',        kind: '1d', encoder: 'CODE39',     minMm: 0.19 },
  CODE_93:       { id: 'CODE93',     label: 'Code 93',        kind: '1d', encoder: null,         minMm: 0.19 },
  CODABAR:       { id: 'CODABAR',    label: 'Codabar',        kind: '1d', encoder: 'codabar',    minMm: 0.19 },
  EAN_13:        { id: 'EAN13',      label: 'EAN-13',         kind: '1d', encoder: 'EAN13',      minMm: 0.264 },
  EAN_8:         { id: 'EAN8',       label: 'EAN-8',          kind: '1d', encoder: 'EAN8',       minMm: 0.264 },
  UPC_A:         { id: 'UPCA',       label: 'UPC-A',          kind: '1d', encoder: 'UPC',        minMm: 0.264 },
  UPC_E:         { id: 'UPCE',       label: 'UPC-E',          kind: '1d', encoder: 'UPCE',       minMm: 0.264 },
  ITF:           { id: 'ITF',        label: 'ITF (Interleaved 2 of 5)', kind: '1d', encoder: 'ITF', minMm: 0.19 },
  QR_CODE:       { id: 'QR',         label: 'QR Code',        kind: '2d', encoder: 'QR',         minMm: 0.3 },
  DATA_MATRIX:   { id: 'DATAMATRIX', label: 'Data Matrix',    kind: '2d', encoder: null,         minMm: 0.3 },
  PDF_417:       { id: 'PDF417',     label: 'PDF417',         kind: '2d', encoder: null,         minMm: 0.25 },
  AZTEC:         { id: 'AZTEC',      label: 'Aztec',          kind: '2d', encoder: null,         minMm: 0.3 },
  MAXICODE:      { id: 'MAXICODE',   label: 'MaxiCode',       kind: '2d', encoder: null,         minMm: 0.35 },
  RSS_14:        { id: 'RSS14',      label: 'GS1 DataBar',    kind: '1d', encoder: null,         minMm: 0.2 },
  RSS_EXPANDED:  { id: 'RSS_EXPANDED', label: 'GS1 DataBar Expanded', kind: '1d', encoder: null, minMm: 0.2 },
  UPC_EAN_EXTENSION: { id: 'UPCEXT', label: 'UPC/EAN add-on', kind: '1d', encoder: null,         minMm: 0.264 },
};

/** Extra formats we can *produce* even though ZXing never reports them. */
const EXTRA_ENCODERS = [
  { id: 'ITF14',      label: 'ITF-14',           encoder: 'ITF14',      kind: '1d', minMm: 0.19 },
  { id: 'EAN5',       label: 'EAN-5 add-on',     encoder: 'EAN5',       kind: '1d', minMm: 0.264 },
  { id: 'EAN2',       label: 'EAN-2 add-on',     encoder: 'EAN2',       kind: '1d', minMm: 0.264 },
  { id: 'MSI',        label: 'MSI',              encoder: 'MSI',        kind: '1d', minMm: 0.19 },
  { id: 'pharmacode', label: 'Pharmacode',       encoder: 'pharmacode', kind: '1d', minMm: 0.19 },
  { id: 'CODE128A',   label: 'Code 128-A',       encoder: 'CODE128A',   kind: '1d', minMm: 0.19 },
  { id: 'CODE128B',   label: 'Code 128-B',       encoder: 'CODE128B',   kind: '1d', minMm: 0.19 },
  { id: 'CODE128C',   label: 'Code 128-C',       encoder: 'CODE128C',   kind: '1d', minMm: 0.19 },
];

/** Formats excluded unless "include rare formats" is ticked — they are slow
 *  and, in the case of the DataBar family, prone to false positives on noise. */
const RARE_FORMATS = ['RSS_14', 'RSS_EXPANDED', 'MAXICODE'];

/** Print width used when the user hits Print, in mm. */
const PRINT_WIDTH_MM = 60;

const LIB = {
  zxing: window.ZXing || null,
  jsBarcode: typeof window.JsBarcode === 'function' ? window.JsBarcode : null,
  qrcode: typeof window.qrcode === 'function' ? window.qrcode : null,
};

/** Formats we can actually rebuild, in the order shown in the dropdown. */
function buildEncoderList() {
  const out = [];
  const seen = new Set();

  // Symbologies ZXing can report and that we can re-encode.
  Object.values(SYMBOLOGIES).forEach((s) => {
    if (!s.encoder || seen.has(s.id)) return;
    if (!canEncodeWith(s.encoder)) return;
    seen.add(s.id);
    out.push({ id: s.id, label: s.label, encoder: s.encoder, kind: s.kind, minMm: s.minMm });
  });

  // Encode-only extras.
  EXTRA_ENCODERS.forEach((s) => {
    if (seen.has(s.id) || !canEncodeWith(s.encoder)) return;
    seen.add(s.id);
    out.push(s);
  });

  return out;
}

function canEncodeWith(encoder) {
  if (!encoder) return false;
  if (encoder === 'QR') return !!LIB.qrcode;
  return !!(LIB.jsBarcode && LIB.jsBarcode.getModule && LIB.jsBarcode.getModule(encoder));
}

/* =============================================================================
   3. State
   ========================================================================== */

const MAX_WORK_DIM = 3000;   // cap on the working resolution of a loaded photo

const state = {
  /** @type {HTMLCanvasElement|null} the loaded photo, possibly downscaled */
  source: null,
  sourceName: '',
  sourceInfo: null,
  /** @type {{gray: Uint8ClampedArray, width: number, height: number}|null} */
  baseGray: null,
  /** @type {Array} decode hits, best first */
  results: [],
  selected: 0,
  /** @type {object|null} last successful render, for exports */
  render: null,
  /** whether a symbol is on screen — drives the save + options panels */
  hasSymbol: false,
  /** @type {'scan'|'viewing'|'editing'} which view the page is showing */
  mode: 'scan',
  decodeToken: 0,
  busy: false,
};

/* =============================================================================
   4. Source loading
   ========================================================================== */

/** Decode a File into an ImageBitmap, honouring EXIF orientation where supported. */
async function fileToBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      try {
        return await createImageBitmap(file);
      } catch (_) { /* fall through to the <img> path */ }
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}

/** Draw any drawable source into the working canvas, downscaling if enormous. */
function setSourceFromDrawable(drawable, name) {
  const nw = drawable.width || drawable.naturalWidth;
  const nh = drawable.height || drawable.naturalHeight;
  if (!nw || !nh) throw new Error('That image has no usable pixels.');

  const scale = Math.min(1, MAX_WORK_DIM / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));

  const canvas = $('#preview-canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(drawable, 0, 0, w, h);

  state.source = canvas;
  state.sourceName = name || 'image';
  state.sourceInfo = { originalW: nw, originalH: nh, w, h, downscaled: scale < 1 };
  state.baseGray = null;
  state.results = [];
  state.selected = 0;

  // A new photo replaces everything, including a scan still running on the
  // previous one: bumping the token makes that loop bail out at its next step.
  state.decodeToken++;
  state.busy = false;

  fitPreview();

  const pct = Math.round(scale * 100);
  const noteEl = $('#source-note');
  if (scale < 1) {
    noteEl.textContent =
      `Large photo downscaled to ${pct}% (${w}\u00d7${h} px) so scanning stays responsive. ` +
      'If a tiny code is missed, crop the photo around it and load that instead.';
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  // A photo arriving by any route (picker, drop or paste) means the user wants
  // to scan, even if they were looking at a saved barcode a moment ago.
  setMode('scan');

  $('#source-panel').hidden = false;
  $('#results-panel').hidden = true;
  setOutputVisible(false);

  $('#preview-meta').textContent =
    `${state.sourceName} \u00b7 ${nw}\u00d7${nh} px` + (scale < 1 ? ` \u2192 working at ${w}\u00d7${h} px` : '');
  $('#dropzone-status').textContent = '';
}

async function loadFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i.test(file.name)) {
    toast('That does not look like an image file.');
    return;
  }
  try {
    $('#dropzone-status').textContent = `Reading ${file.name} (${formatBytes(file.size)})…`;
    const bitmap = await fileToBitmap(file);
    setSourceFromDrawable(bitmap, file.name);
    if (bitmap.close) bitmap.close();
    $('#dropzone-status').textContent = '';
    // No press needed — loading a photo is itself the request to read it.
    startRead();
  } catch (err) {
    $('#dropzone-status').textContent = '';
    toast(err.message || 'Could not load that image.');
  }
}

/* =============================================================================
   5. Preview sizing
   ========================================================================== */

function fitPreview() {
  const src = state.source;
  if (!src) return;
  const col = $('#preview-col');
  const avail = Math.max(120, col.clientWidth || 320);
  const maxH = Math.max(160, Math.round(window.innerHeight * 0.6));
  const scale = Math.min(avail / src.width, maxH / src.height, 1);
  src.style.width = `${Math.round(src.width * scale)}px`;
  src.style.height = `${Math.round(src.height * scale)}px`;
}

/* =============================================================================
   6. Greyscale maths and image transforms
   ========================================================================== */

function imageDataToGray(imgData) {
  const { data, width, height } = imgData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Rec. 601 luma — the same weighting the standard scanner pipeline uses.
    gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return { gray, width, height };
}

function ensureBaseGray() {
  if (state.baseGray) return state.baseGray;
  const canvas = state.source;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  state.baseGray = imageDataToGray(ctx.getImageData(0, 0, canvas.width, canvas.height));
  return state.baseGray;
}

/** Otsu's method: the threshold that maximises between-class variance. */
function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0, weightB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/** Percentile-based contrast stretch — rescues faded or hazy photos. */
function contrastStretch(src, lowPct = 0.02, highPct = 0.98) {
  const { gray } = src;
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let acc = 0, lo = 0, hi = 255;
  for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= total * lowPct) { lo = t; break; } }
  acc = 0;
  for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= total * (1 - highPct)) { hi = t; break; } }
  if (hi - lo < 8) return src;

  const span = hi - lo;
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) {
    let v = ((gray[i] - lo) * 255) / span;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return { gray: out, width: src.width, height: src.height };
}

function binarize(src, threshold) {
  const out = new Uint8ClampedArray(src.gray.length);
  const g = src.gray;
  for (let i = 0; i < g.length; i++) out[i] = g[i] <= threshold ? 0 : 255;
  return { gray: out, width: src.width, height: src.height };
}

function invertGray(src) {
  const out = new Uint8ClampedArray(src.gray.length);
  const g = src.gray;
  for (let i = 0; i < g.length; i++) out[i] = 255 - g[i];
  return { gray: out, width: src.width, height: src.height };
}

function cropGray(src, rect) {
  const x = clamp(Math.round(rect.x), 0, src.width - 1);
  const y = clamp(Math.round(rect.y), 0, src.height - 1);
  const w = clamp(Math.round(rect.w), 1, src.width - x);
  const h = clamp(Math.round(rect.h), 1, src.height - y);
  if (x === 0 && y === 0 && w === src.width && h === src.height) return src;

  const out = new Uint8ClampedArray(w * h);
  for (let row = 0; row < h; row++) {
    out.set(src.gray.subarray((y + row) * src.width + x, (y + row) * src.width + x + w), row * w);
  }
  return { gray: out, width: w, height: h };
}

/**
 * Resample with bilinear interpolation, optionally rotating (clockwise, y-down).
 */
function resampleGray(src, scale = 1, angleDeg = 0) {
  if (scale === 1 && angleDeg === 0) return src;

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { width: srcW, height: srcH, gray: sg } = src;

  const rotW = Math.abs(srcW * cos) + Math.abs(srcH * sin);
  const rotH = Math.abs(srcW * sin) + Math.abs(srcH * cos);
  const destW = Math.max(1, Math.round(rotW * scale));
  const destH = Math.max(1, Math.round(rotH * scale));

  const out = new Uint8ClampedArray(destW * destH);
  out.fill(255); // pad introduced by rotation reads as white paper

  const scx = srcW / 2, scy = srcH / 2;
  const dcx = destW / 2, dcy = destH / 2;

  for (let y = 0; y < destH; y++) {
    const v = (y + 0.5 - dcy) / scale;
    for (let x = 0; x < destW; x++) {
      const u = (x + 0.5 - dcx) / scale;
      const sx = u * cos + v * sin + scx;
      const sy = -u * sin + v * cos + scy;
      if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH) continue;

      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 + 1 < srcW ? x0 + 1 : x0;
      const y1 = y0 + 1 < srcH ? y0 + 1 : y0;
      const fx = sx - x0, fy = sy - y0;

      const a = sg[y0 * srcW + x0];
      const b = sg[y0 * srcW + x1];
      const c = sg[y1 * srcW + x0];
      const d = sg[y1 * srcW + x1];
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      out[y * destW + x] = top + (bottom - top) * fy;
    }
  }

  return { gray: out, width: destW, height: destH };
}

/** Overlapping tiles, so a small code in a big frame still gets full resolution. */
function makeTiles(w, h, cols, rows, overlap = 0.12) {
  const tiles = [];
  const tw = Math.ceil(w / cols);
  const th = Math.ceil(h / rows);
  const ox = Math.round(tw * overlap);
  const oy = Math.round(th * overlap);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.max(0, c * tw - ox);
      const y = Math.max(0, r * th - oy);
      const width = Math.min(w - x, tw + 2 * ox);
      const height = Math.min(h - y, th + 2 * oy);
      if (width < 32 || height < 32) continue;
      tiles.push({ x, y, w: width, h: height, label: `tile ${tiles.length + 1}` });
    }
  }
  return tiles;
}

/* =============================================================================
   7. Decode pipeline
   ========================================================================== */

function buildHints() {
  const names = Object.keys(SYMBOLOGIES);
  const includeRare = $('#rare-formats').checked;
  const formats = names
    .filter((n) => includeRare || RARE_FORMATS.indexOf(n) === -1)
    .map((n) => LIB.zxing.BarcodeFormat[n])
    .filter((v) => typeof v === 'number');

  const hints = new Map();
  hints.set(LIB.zxing.DecodeHintType.POSSIBLE_FORMATS, formats);
  hints.set(LIB.zxing.DecodeHintType.TRY_HARDER, true);
  if (LIB.zxing.DecodeHintType.CHARACTER_SET) {
    hints.set(LIB.zxing.DecodeHintType.CHARACTER_SET, 'UTF-8');
  }
  return hints;
}

/**
 * The ordered list of things to try. Cheapest and most likely first, so the
 * common case finishes in a few hundred milliseconds.
 */
function planTiers(mode, view) {
  const whole = { crop: null, scale: 1, angle: 0 };
  const tiers = [];

  const tier = (name, attempts) => tiers.push({ name, attempts });

  // --- tier 1: the plain reading of the image -------------------------------
  tier('reading the image', [
    Object.assign({}, whole, { label: 'full', enhance: 'none', bin: 'hybrid' }),
    Object.assign({}, whole, { label: 'contrast boost', enhance: 'stretch', bin: 'hybrid' }),
    Object.assign({}, whole, { label: 'binary', enhance: 'otsu', bin: 'hybrid' }),
    Object.assign({}, whole, { label: 'global threshold', enhance: 'none', bin: 'global' }),
    Object.assign({}, whole, { label: 'light-on-dark', enhance: 'otsu', invert: true, bin: 'hybrid' }),
  ]);

  if (mode === 'more') {
    // Only look for *additional* codes.
    tier('extra tiles', tileAttempts(view, 3, 3, [['none', 'hybrid']]));
    return tiers;
  }

  // --- tier 2: upscaling rescues small codes --------------------------------
  tier('upscaling', [
    Object.assign({}, whole, { label: '2\u00d7', scale: 2, enhance: 'none', bin: 'hybrid' }),
    Object.assign({}, whole, { label: '3\u00d7', scale: 3, enhance: 'none', bin: 'hybrid' }),
    Object.assign({}, whole, { label: '2\u00d7 contrast', scale: 2, enhance: 'stretch', bin: 'hybrid' }),
    Object.assign({}, whole, { label: '2\u00d7 binary', scale: 2, enhance: 'otsu', bin: 'hybrid' }),
  ]);

  // --- tier 3: the photo may be sideways ------------------------------------
  tier('rotation', [
    Object.assign({}, whole, { label: '90\u00b0', angle: 90, enhance: 'none', bin: 'hybrid' }),
    Object.assign({}, whole, { label: '270\u00b0', angle: 270, enhance: 'none', bin: 'hybrid' }),
    Object.assign({}, whole, { label: '180\u00b0', angle: 180, enhance: 'none', bin: 'hybrid' }),
  ]);

  // --- tier 4: hunt for small codes / several codes -------------------------
  tier('tiles', tileAttempts(view, 2, 2, [['none', 'hybrid'], ['stretch', 'hybrid']]));
  tier('fine tiles', tileAttempts(view, 3, 3, [['none', 'hybrid'], ['stretch', 'hybrid']]));

  if (mode === 'deep') {
    // --- tier 5: brute force for stubborn photos ---------------------------
    tier('skew', [-8, -4, 4, 8, -14, 14, -20, 20].map((a) => Object.assign({}, whole, {
      label: `${a}\u00b0`, angle: a, enhance: 'none', bin: 'hybrid',
    })));
    tier('skew + binary', [-6, 6, -12, 12].map((a) => Object.assign({}, whole, {
      label: `${a}\u00b0 binary`, angle: a, enhance: 'otsu', bin: 'hybrid',
    })));
    tier('extreme upscale', [
      Object.assign({}, whole, { label: '4\u00d7', scale: 4, enhance: 'none', bin: 'hybrid' }),
      Object.assign({}, whole, { label: '4\u00d7 binary', scale: 4, enhance: 'otsu', bin: 'hybrid' }),
      Object.assign({}, whole, { label: '3\u00d7 inverted', scale: 3, enhance: 'otsu', invert: true, bin: 'hybrid' }),
    ]);
    tier('fine tiles, rotated', [90, 270].map((a) => Object.assign({}, whole, {
      label: `${a}\u00b0`, angle: a, enhance: 'none', bin: 'hybrid',
    })).concat(
      tileAttempts(view, 3, 3, [['otsu', 'hybrid']]).slice(0, 9)
    ));
  }

  return tiers;
}

function tileAttempts(view, cols, rows, variants) {
  const tiles = makeTiles(view.w, view.h, cols, rows);
  const out = [];
  tiles.forEach((t) => {
    variants.forEach(([enhance, bin]) => {
      out.push({
        crop: { x: view.x + t.x, y: view.y + t.y, w: t.w, h: t.h },
        scale: 1,
        angle: 0,
        label: t.label,
        enhance,
        bin,
      });
    });
  });
  return out;
}

/** Run one attempt; returns a hit or null. */
function executeAttempt(attempt, hints) {
  const base = ensureBaseGray();
  const sliced = attempt.crop ? cropGray(base, attempt.crop) : base;
  const resampled = resampleGray(sliced, attempt.scale || 1, attempt.angle || 0);

  let work = resampled;
  if (attempt.enhance === 'stretch') work = contrastStretch(resampled);
  else if (attempt.enhance === 'otsu') work = binarize(resampled, otsuThreshold(resampled.gray));
  if (attempt.invert) work = invertGray(work);

  // ZXing-js's RGBLuminanceSource takes one luminance byte per pixel.
  const source = new LIB.zxing.RGBLuminanceSource(work.gray, work.width, work.height);
  const binarizer = attempt.bin === 'global'
    ? new LIB.zxing.GlobalHistogramBinarizer(source)
    : new LIB.zxing.HybridBinarizer(source);
  const bitmap = new LIB.zxing.BinaryBitmap(binarizer);

  const reader = new LIB.zxing.MultiFormatReader();
  reader.setHints(hints);
  const result = reader.decode(bitmap, hints);

  const formatName = LIB.zxing.BarcodeFormat[result.getBarcodeFormat()];

  return {
    key: `${formatName}\u0000${result.getText()}`,
    formatName,
    text: result.getText(),
    label: attempt.label,
  };
}

function setProgress(fraction, text) {
  $('#progress').hidden = false;
  $('#progress-bar').style.width = `${clamp(fraction, 0, 1) * 100}%`;
  $('#progress-text').textContent = text;
}

function hideProgress() {
  $('#progress').hidden = true;
  $('#progress-bar').style.width = '0%';
  $('#progress-text').textContent = '';
}

async function runDecode(mode) {
  if (state.busy || !state.source) return;
  if (!state.baseGray) {
    setProgress(0.02, 'Preparing pixels…');
    await nextFrame();
    ensureBaseGray();
  }

  const token = ++state.decodeToken;
  state.busy = true;
  setBusy(true);

  const hints = buildHints();
  const deep = mode === 'deep';
  const view = { x: 0, y: 0, w: state.source.width, h: state.source.height };

  const tiers = planTiers(deep ? 'deep' : mode === 'more' ? 'more' : 'normal', view);
  const total = tiers.reduce((n, t) => n + t.attempts.length, 0);

  const found = mode === 'more' ? state.results.slice() : [];
  const seen = new Set(found.map((h) => h.key));
  let done = 0;
  const started = performance.now();

  try {
    for (let ti = 0; ti < tiers.length; ti++) {
      const tierDef = tiers[ti];
      let tierHits = 0;

      for (const attempt of tierDef.attempts) {
        if (token !== state.decodeToken) return; // superseded by a newer run
        done++;
        setProgress(done / total, `${tierDef.name}: ${attempt.label} \u00b7 ${done}/${total}`);
        await nextFrame();

        let hit = null;
        try {
          hit = executeAttempt(attempt, hints);
        } catch (err) {
          // NotFoundException is the normal "nothing here" outcome.
          hit = null;
        }

        if (hit && !seen.has(hit.key)) {
          seen.add(hit.key);
          found.push(hit);
          tierHits++;
        }
      }

      if (tierHits > 0 && mode === 'normal') break; // good enough, stop early
    }
  } finally {
    if (token === state.decodeToken) {
      state.busy = false;
      setBusy(false);
      hideProgress();
    }
  }

  const ms = Math.round(performance.now() - started);
  state.results = rankResults(found);
  state.selected = 0;
  renderResults(ms, mode);
}

/**
 * Single entry point for starting a read: used by the buttons and by the
 * automatic read that follows loading a photo. Picks the mode from the Deep
 * scan toggle unless one is given, and guarantees the busy state is released
 * even if something unexpected throws.
 */
function startRead(mode) {
  if (!state.source || state.busy) return;
  const chosen = mode || ($('#deep-scan').checked ? 'deep' : 'normal');
  runDecode(chosen).catch(() => {
    state.busy = false;
    setBusy(false);
    hideProgress();
  });
}

/**
 * Score hits so the most trustworthy one is first: a plausible symbology, found
 * in the plain reading, is better than a lucky tile hit.
 */
function rankResults(hits) {
  const scored = hits.map((hit, index) => {
    let score = 0;
    const sym = SYMBOLOGIES[hit.formatName] || null;

    if (sym) score += sym.kind === '2d' ? 12 : 10;
    if (sym && sym.encoder) score += 4;          // we can rebuild it
    if (hit.label === 'full') score += 6;
    if (hit.label === 'contrast boost') score += 5;
    if (hit.label === 'binary') score += 4;
    if (/tile/.test(hit.label)) score -= 3;
    if (/°/.test(hit.label)) score -= 2;
    if (/×/.test(hit.label)) score -= 1;
    if (hit.text && hit.text.length) score += 1;

    return { hit, score, index };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));

  return scored.map((s) => s.hit);
}

/* =============================================================================
   8. Results rendering
   ========================================================================== */

function renderResults(ms, mode) {
  const panel = $('#results-panel');
  const body = $('#results-body');
  body.textContent = '';
  panel.hidden = false;

  const hits = state.results;

  if (!hits.length) {
    const n = document.createElement('p');
    n.className = 'notice notice--warn';
    n.innerHTML =
      '<strong>No barcode found.</strong> Things that usually help, in order:<br>' +
      '1. Crop the photo tightly around the barcode, then load that instead.<br>' +
      '2. Tick <em>Deep scan</em> — it retries with rotation, upscaling and fine skew correction.<br>' +
      '3. Try a sharper shot: avoid glare, shadows across the bars, and motion blur.';
    body.appendChild(n);
    setOutputVisible(false);
    $('#find-more-btn').hidden = !state.source;
    return;
  }

  const head = document.createElement('p');
  head.className = 'meta meta--strong';
  head.textContent = `${hits.length} barcode${hits.length === 1 ? '' : 's'} found in ${ms} ms`
    + (mode === 'deep' ? ' (deep scan)' : '');
  body.appendChild(head);

  const list = document.createElement('div');
  list.style.marginTop = '10px';

  hits.forEach((hit, i) => {
    const sym = SYMBOLOGIES[hit.formatName] || null;
    const canRebuild = !!(sym && sym.encoder);

    const card = document.createElement('label');
    card.className = `result-card${i === state.selected ? ' is-selected' : ''}`;
    card.dataset.index = String(i);

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'result';
    radio.checked = i === state.selected;
    radio.addEventListener('change', () => selectResult(i));

    const bodyEl = document.createElement('div');
    bodyEl.className = 'result-card__body';

    const headEl = document.createElement('div');
    headEl.className = 'result-card__head';

    const badge = (text, cls) => {
      const s = document.createElement('span');
      s.className = `badge${cls ? ' ' + cls : ''}`;
      s.textContent = text;
      return s;
    };

    headEl.appendChild(badge(sym ? sym.label : hit.formatName));
    headEl.appendChild(badge(
      canRebuild ? 'rebuildable' : 'photo only',
      canRebuild ? 'badge--ok' : 'badge--warn'
    ));
    if (i === 0) headEl.appendChild(badge('best match', 'badge--ok'));
    headEl.appendChild(badge(hit.label, 'badge--muted'));

    const len = document.createElement('span');
    len.className = 'meta';
    len.textContent = `${hit.text.length} char${hit.text.length === 1 ? '' : 's'}`;
    headEl.appendChild(len);

    const payload = document.createElement('div');
    payload.className = 'payload';
    payload.textContent = hit.text.length > 400 ? `${hit.text.slice(0, 400)}…` : hit.text;

    bodyEl.appendChild(headEl);
    bodyEl.appendChild(payload);
    card.appendChild(radio);
    card.appendChild(bodyEl);
    list.appendChild(card);
  });

  body.appendChild(list);

  const copyRow = document.createElement('div');
  copyRow.className = 'btn-row';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn';
  copyBtn.textContent = 'Copy decoded text';
  copyBtn.addEventListener('click', async () => {
    const hit = state.results[state.selected];
    if (!hit) return;
    try {
      await navigator.clipboard.writeText(hit.text);
      toast('Decoded text copied.');
    } catch (_) {
      toast('Clipboard blocked by the browser — select the text manually.');
    }
  });
  copyRow.appendChild(copyBtn);
  body.appendChild(copyRow);

  $('#find-more-btn').hidden = false;

  selectResult(state.selected, true);
}

function selectResult(index, silent) {
  state.selected = index;
  $$('.result-card').forEach((el) => {
    el.classList.toggle('is-selected', Number(el.dataset.index) === index);
  });

  const hit = state.results[index];
  if (!hit) return;

  setOutputVisible(true);
  setMode('scan');
  $('#data-input').value = hit.text;

  // This is a freshly decoded barcode, so the next Save starts a new record
  // rather than overwriting whatever was open before.
  library.editingId = null;
  $('#save-name').value = '';
  syncSaveControls();
  highlightLibrary();

  // Pick the closest encodable symbology, defaulting to Code 128, or QR when
  // the source format cannot be rebuilt locally.
  const sym = SYMBOLOGIES[hit.formatName] || null;
  const target = sym && sym.encoder ? sym.id : 'QR';
  if ($(`#format-select option[value="${target}"]`)) {
    $('#format-select').value = target;
  }

  const notice = $('#format-notice');
  if (sym && !sym.encoder) {
    notice.textContent = `${sym.label} cannot be rebuilt offline, so a QR code carrying the same data is offered instead. `
      + 'Pick “QR Code” above to keep the payload, or type the digits in yourself if you can read them from the photo.';
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }

  renderBarcode();
  if (!silent) toast(`Using the ${sym ? sym.label : hit.formatName} result.`);
}

/* =============================================================================
   9. Barcode generation
   ========================================================================== */

function currentEncoder() {
  const id = $('#format-select').value;
  const all = buildEncoderList();
  return all.find((f) => f.id === id) || all[0] || null;
}

/** Sensible starting point for every render option. */
const DEFAULT_RENDER_OPTIONS = {
  moduleWidth: 6,
  height: 140,
  quiet: 10,
  showText: true,
  fontSize: 20,
  transparent: false,
  lineColor: '#000000',
  bgColor: '#ffffff',
  ecc: 'M',
};

/** Fill in anything a stored (or partial) option set is missing. */
function normalizeOptions(o) {
  return Object.assign({}, DEFAULT_RENDER_OPTIONS, o || {});
}

/** Snapshot the render controls. */
function readRenderOptions() {
  return {
    moduleWidth: Number($('#opt-module-width').value),
    height: Number($('#opt-height').value),
    quiet: Number($('#opt-quiet').value),
    showText: $('#opt-showtext').checked,
    fontSize: Number($('#opt-fontsize').value),
    transparent: $('#opt-transparent').checked,
    lineColor: $('#opt-line-color').value,
    bgColor: $('#opt-bg-color').value,
    ecc: $('#opt-ecc').value,
  };
}

/** Push a saved option set back into the controls. */
function applyRenderOptions(raw) {
  const o = normalizeOptions(raw);
  $('#opt-module-width').value = o.moduleWidth;
  $('#opt-height').value = o.height;
  $('#opt-quiet').value = o.quiet;
  $('#opt-showtext').checked = o.showText;
  $('#opt-fontsize').value = o.fontSize;
  $('#opt-transparent').checked = o.transparent;
  $('#opt-line-color').value = o.lineColor;
  $('#opt-bg-color').value = o.bgColor;
  $('#opt-ecc').value = o.ecc;
}

/**
 * Render the barcode described by the controls.
 * Returns { svg, canvas, modules, widthPx, heightPx, entry } or throws.
 */
function generateBarcode() {
  const entry = currentEncoder();
  if (!entry) throw new Error('No barcode symbology is available.');

  const text = $('#data-input').value;
  if (!text) throw new Error('Enter the data to encode.');

  return generateSymbol(entry, text, readRenderOptions(), { raster: true });
}

/**
 * Encode `text` as `entry` with explicit options.
 * `raster: false` skips the canvas so thumbnails stay cheap.
 */
function generateSymbol(entry, text, options, opts) {
  const o = normalizeOptions(options);
  const raster = !opts || opts.raster !== false;
  return entry.kind === '2d'
    ? generateQr(entry, text, o, raster)
    : generate1d(entry, text, o, raster);
}

function generate1d(entry, text, o, raster) {
  const options = {
    format: entry.encoder,
    width: o.moduleWidth,
    height: o.height,
    margin: o.quiet * o.moduleWidth,
    displayValue: o.showText,
    fontSize: o.fontSize,
    textMargin: Math.max(2, Math.round(o.fontSize * 0.35)),
    font: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontOptions: 'bold',
    textAlign: 'center',
    textPosition: 'bottom',
    lineColor: o.lineColor,
    background: o.transparent ? 'transparent' : o.bgColor,
  };

  // Render to SVG for the vector export and preview.
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  let renderError = null;
  try {
    LIB.jsBarcode(svgEl, text, Object.assign({}, options, {
      valid: (valid) => { if (!valid) renderError = 'invalid'; },
    }));
  } catch (err) {
    renderError = err.message || 'invalid';
  }

  const widthPx = Number.parseFloat(svgEl.getAttribute('width')) || 0;
  const heightPx = Number.parseFloat(svgEl.getAttribute('height')) || o.height;
  if (renderError || !widthPx || !svgEl.childNodes.length) {
    throw new Error(
      `“${text}” is not valid for ${entry.label}. ` +
      'Check the expected character set and length (some formats need a specific number of digits).'
    );
  }

  // A viewBox makes the file resolution-independent (and lets the preview scale
  // to the container without distorting the bars).
  if (!svgEl.getAttribute('viewBox')) {
    svgEl.setAttribute('viewBox', `0 0 ${widthPx} ${heightPx}`);
  }

  const svg = svgEl.outerHTML;

  // Same options, rasterised by JsBarcode's canvas renderer. Skipped when the
  // caller only needs the vector (library thumbnails, for instance).
  let canvas = null;
  if (raster !== false) {
    canvas = document.createElement('canvas');
    LIB.jsBarcode(canvas, text, options);
  }

  const modules = Math.round(widthPx / o.moduleWidth) - o.quiet * 2;

  return {
    entry,
    svg,
    canvas,
    modules,
    quiet: o.quiet,
    moduleWidth: o.moduleWidth,
    widthPx,
    heightPx,
    barModules: modules,
  };
}

function generateQr(entry, text, o, raster) {
  const qr = LIB.qrcode(0, o.ecc);
  qr.addData(text);
  try {
    qr.make();
  } catch (err) {
    throw new Error('That payload is too large for a QR code. Shorten the data or use a lower error-correction level.');
  }

  const n = qr.getModuleCount();
  const m = o.moduleWidth;
  const quiet = Math.max(4, o.quiet);
  const total = (n + quiet * 2) * m;

  // Vector output: merge each row into horizontal runs to keep it compact.
  const parts = [];
  if (!o.transparent) parts.push(`<rect width="${total}" height="${total}" fill="${o.bgColor}"/>`);
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) { c++; continue; }
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      parts.push(`<rect x="${(c + quiet) * m}" y="${(r + quiet) * m}" width="${run * m}" height="${m}"/>`);
      c += run;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" `
    + `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<g fill="${o.lineColor}">${parts.join('')}</g></svg>`;

  // Raster output: exact integer modules, no resampling.
  let canvas = null;
  if (raster !== false) {
    canvas = document.createElement('canvas');
    canvas.width = total;
    canvas.height = total;
    const ctx = canvas.getContext('2d');
    if (!o.transparent) {
      ctx.fillStyle = o.bgColor;
      ctx.fillRect(0, 0, total, total);
    }
    ctx.fillStyle = o.lineColor;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * m, (r + quiet) * m, m, m);
      }
    }
  }

  return {
    entry,
    svg,
    canvas,
    modules: n,
    quiet,
    moduleWidth: m,
    widthPx: total,
    heightPx: total,
    barModules: n,
  };
}

/* =============================================================================
   10. Render + export
   ========================================================================== */

function renderBarcode() {
  const errorEl = $('#render-error');
  const frame = $('#render-frame');

  let rendered = null;
  try {
    rendered = generateBarcode();
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    errorEl.className = 'notice notice--error';
    frame.textContent = '';
    $('#render-meta').textContent = '';
    $('#render-warning').hidden = true;
    state.render = null;
    // Nothing to show full screen any more, so hand the interface back.
    syncFullscreenSymbol();
    return;
  }

  state.render = rendered;

  // Preview: always the vector, scaled to fit by CSS.
  frame.textContent = '';
  const svgEl = svgForDisplay(rendered.svg);
  if (svgEl) {
    svgEl.style.width = '100%';
    svgEl.style.maxWidth = `${rendered.widthPx}px`;
    svgEl.style.height = 'auto';
    frame.appendChild(svgEl);
  }

  updateRenderMeta(rendered);
  // A fresh symbol means the full-screen copy (if one is on screen) is stale.
  syncFullscreenSymbol();
}

/**
 * Turn generated SVG markup into an element that scales to whatever box it is
 * placed in. Dropping width/height while keeping the viewBox is what makes the
 * symbol resolution-independent.
 */
function svgForDisplay(markup) {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  const svg = holder.firstElementChild;
  if (!svg) return null;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return svg;
}

function updateRenderMeta(r) {
  const modulesAcross = r.modules + r.quiet * 2;
  const sym = SYMBOLOGIES[r.entry.id] || r.entry;
  const minMm = (r.entry.minMm || (sym && sym.minMm) || 0.19);

  const minPrintMm = Math.max(12, modulesAcross * minMm);
  const barMmAtPrint = PRINT_WIDTH_MM / modulesAcross;

  const pxW = r.canvas ? r.canvas.width : r.widthPx;
  const pxH = r.canvas ? r.canvas.height : r.heightPx;

  $('#render-meta').textContent =
    `${r.entry.label} \u00b7 ${r.modules} modules`
    + ` + ${r.quiet * 2} quiet \u00b7 ${pxW}\u00d7${pxH} px`
    + ` \u00b7 prints cleanly at \u2265 ${round1(minPrintMm)} mm wide`
    + ` (bars \u2265 ${round1(minMm * 10) / 10} mm)`;

  const warnEl = $('#render-warning');
  warnEl.className = 'notice notice--warn';

  if (r.entry.kind === '2d') {
    // QR modules want to be reasonably large for phone cameras.
    const moduleMm = minPrintMm / modulesAcross;
    if (moduleMm < minMm) {
      warnEl.textContent = `Very dense symbol: each module is only ${round1(moduleMm * 100) / 100} mm at ${PRINT_WIDTH_MM} mm wide. Print larger for reliable scanning.`;
      warnEl.hidden = false;
    } else {
      warnEl.hidden = true;
    }
    return;
  }

  if (barMmAtPrint < minMm) {
    warnEl.textContent =
      `At ${PRINT_WIDTH_MM} mm wide each bar would be ${round1(barMmAtPrint * 100) / 100} mm, `
      + `below the ${minMm} mm recommended minimum for ${r.entry.label}. `
      + `Print at least ${round1(minPrintMm)} mm wide.`;
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
  }
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed.'))), 'image/png');
    } else {
      try {
        const url = canvas.toDataURL('image/png');
        const bin = atob(url.split(',')[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (err) { reject(err); }
    }
  });
}

async function exportPng() {
  if (!state.render) return;
  try {
    const blob = await canvasToPngBlob(state.render.canvas);
    downloadBlob(blob, `${slugify(state.render.entry.id)}-${slugify($('#data-input').value)}.png`);
    toast(`PNG downloaded (${state.render.canvas.width}\u00d7${state.render.canvas.height} px).`);
  } catch (err) {
    toast('Could not create the PNG.');
  }
}

function exportSvg() {
  if (!state.render) return;
  const blob = new Blob([state.render.svg], { type: 'image/svg+xml;charset=utf-8' });
  downloadBlob(blob, `${slugify(state.render.entry.id)}-${slugify($('#data-input').value)}.svg`);
  toast('SVG downloaded — infinitely scalable, ideal for print.');
}

async function copyImage() {
  if (!state.render) return;
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('unsupported');
    }
    const blob = await canvasToPngBlob(state.render.canvas);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Barcode copied to the clipboard.');
  } catch (err) {
    toast('This browser will not copy images — use Download PNG instead.');
  }
}

function printBarcode() {
  if (!state.render) return;
  const r = state.render;
  const modulesAcross = r.modules + r.quiet * 2;
  const minMm = (r.entry.minMm || 0.19);
  const widthMm = clamp(Math.max(PRINT_WIDTH_MM, modulesAcross * minMm), 20, 200);
  const heightMm = (r.heightPx / r.widthPx) * widthMm;

  const area = $('#print-area');
  area.innerHTML = r.svg;

  const svgEl = area.firstElementChild;
  if (svgEl) {
    svgEl.setAttribute('width', `${round1(widthMm)}mm`);
    svgEl.setAttribute('height', `${round1(heightMm)}mm`);
    svgEl.setAttribute('viewBox', `0 0 ${r.widthPx} ${r.heightPx}`);
    svgEl.style.width = `${round1(widthMm)}mm`;
    svgEl.style.height = `${round1(heightMm)}mm`;
  }

  toast(`Printing at ${round1(widthMm)} mm wide.`);
  setTimeout(() => window.print(), 120);
}

/* =============================================================================
   11. Saved barcode library (localStorage)
   -----------------------------------------------------------------------------
   Only the payload text and the render settings are stored — never the photo
   and never a bitmap. Symbols are regenerated from that data on demand, so a
   saved barcode stays perfectly sharp at any size and costs almost nothing to
   keep around.
   ========================================================================== */

const LIBRARY_KEY = 'barcode-restorer:library:v1';
const LIBRARY_LIMIT = 500;

const library = {
  /** @type {Array<object>} newest first */
  items: [],
  /** id of the record currently open in the output panel, or null */
  editingId: null,
};

function isSaneEntry(e) {
  return !!e && typeof e === 'object'
    && typeof e.id === 'string' && e.id
    && typeof e.text === 'string'
    && typeof e.format === 'string' && e.format;
}

function loadLibrary() {
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]');
  } catch (_) {
    parsed = null;
  }
  library.items = Array.isArray(parsed)
    ? parsed.filter(isSaneEntry).map((e) => ({
      id: e.id,
      name: typeof e.name === 'string' && e.name ? e.name : suggestName(e.text),
      text: e.text,
      format: e.format,
      decodedFormat: typeof e.decodedFormat === 'string' ? e.decodedFormat : null,
      options: normalizeOptions(e.options),
      createdAt: e.createdAt || Date.now(),
      updatedAt: e.updatedAt || e.createdAt || Date.now(),
    }))
    : [];
}

function persistLibrary() {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library.items));
    return true;
  } catch (err) {
    toast('Could not write to this browser’s storage — it may be full or blocked.');
    return false;
  }
}

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    try { return window.crypto.randomUUID(); } catch (_) { /* needs a secure context */ }
  }
  return `b${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatSavedAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) {
    return `today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A readable default name, so saving never requires typing. */
function suggestName(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled barcode';
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

function entryForEncoderId(id) {
  return buildEncoderList().find((f) => f.id === id) || null;
}

function currentDecodedFormat() {
  const hit = state.results[state.selected];
  return hit ? hit.formatName : null;
}

function saveCurrentBarcode() {
  if (!state.render) {
    toast('Nothing to save yet — the barcode has to render first.');
    return;
  }
  if (!library.editingId && library.items.length >= LIBRARY_LIMIT) {
    toast(`The library is full (${LIBRARY_LIMIT} entries) — delete some first.`);
    return;
  }

  const entry = state.render.entry;
  const text = $('#data-input').value;
  const typed = $('#save-name').value.trim();
  const name = typed || suggestName(text);
  const now = Date.now();
  const options = readRenderOptions();
  const decodedFormat = currentDecodedFormat();

  let record = library.editingId
    ? library.items.find((i) => i.id === library.editingId)
    : null;

  // Saving something identical twice updates the existing record instead of
  // piling up duplicates the user then has to clean out by hand.
  if (!record) {
    record = library.items.find((i) => i.text === text && i.format === entry.id && i.name === name) || null;
  }

  const updated = !!record;
  if (record) {
    Object.assign(record, { name, text, format: entry.id, options, decodedFormat, updatedAt: now });
  } else {
    record = {
      id: newId(), name, text, format: entry.id, options, decodedFormat,
      createdAt: now, updatedAt: now,
    };
    library.items.unshift(record);
  }

  library.editingId = record.id;
  if (!persistLibrary()) return;

  $('#save-name').value = record.name;
  renderLibrary();
  syncSaveControls();
  toast(updated ? `Updated “${record.name}”.` : `Saved “${record.name}”.`);
}

/** Open a saved record in the output panel, without needing the original photo. */
function openSaved(id) {
  const record = library.items.find((i) => i.id === id);
  if (!record) return;

  library.editingId = id;
  $('#data-input').value = record.text;
  $('#save-name').value = record.name;

  const select = $('#format-select');
  const hasFormat = Array.prototype.some.call(select.options, (o) => o.value === record.format);
  if (hasFormat) select.value = record.format;

  applyRenderOptions(record.options);
  syncReadouts();
  syncControlVisibility();

  setOutputVisible(true);
  renderBarcode();
  highlightLibrary();
  syncSaveControls();
  setMode('viewing');
  $('#output-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });

  toast(hasFormat
    ? `Opened “${record.name}”.`
    : `“${record.format}” is not available in this build — showing the data with the current symbology.`);
}

function deleteSaved(id) {
  const record = library.items.find((i) => i.id === id);
  if (!record) return;
  if (!window.confirm(`Delete “${record.name}”? This cannot be undone.`)) return;

  library.items = library.items.filter((i) => i.id !== id);
  if (library.editingId === id) {
    library.editingId = null;
    $('#save-name').value = '';
  }
  persistLibrary();
  renderLibrary();
  syncSaveControls();
  toast('Deleted.');
}

/* --- rendering the list -------------------------------------------------- */

function libraryRow(rec) {
  const li = document.createElement('li');
  li.className = 'library-item';
  li.dataset.id = rec.id;
  if (rec.id === library.editingId) li.classList.add('is-active');

  const entry = entryForEncoderId(rec.format);

  // Thumbnail: rebuilt from the saved data, not a stored image.
  const thumb = document.createElement('div');
  thumb.className = 'library-item__thumb';
  if (entry) {
    try {
      const symbol = generateSymbol(entry, rec.text, rec.options, { raster: false });
      const svg = svgForDisplay(symbol.svg);
      if (svg) {
        svg.style.width = '100%';
        svg.style.height = '100%';
        thumb.appendChild(svg);
      }
    } catch (err) {
      thumb.classList.add('is-broken');
      thumb.textContent = '!';
      thumb.title = 'This saved data can no longer be encoded.';
    }
  } else {
    thumb.classList.add('is-broken');
    thumb.textContent = '?';
    thumb.title = `Symbology “${rec.format}” is not available in this build.`;
  }

  const body = document.createElement('div');
  body.className = 'library-item__body';

  const head = document.createElement('div');
  head.className = 'library-item__head';

  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'library-item__name';
  nameBtn.textContent = rec.name;
  nameBtn.title = `Open “${rec.name}”`;
  nameBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openSaved(rec.id); });
  head.appendChild(nameBtn);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = entry ? entry.label : rec.format;
  head.appendChild(badge);

  // Show where the data originally came from, but not when that is the same
  // symbology we are already displaying.
  const decoded = rec.decodedFormat ? SYMBOLOGIES[rec.decodedFormat] : null;
  if (decoded && decoded.id !== rec.format) {
    const from = document.createElement('span');
    from.className = 'badge badge--muted';
    from.textContent = `from ${decoded.label}`;
    head.appendChild(from);
  }

  const payload = document.createElement('div');
  payload.className = 'payload';
  payload.textContent = rec.text.length > 180 ? `${rec.text.slice(0, 180)}…` : rec.text;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `saved ${formatSavedAt(rec.updatedAt)}`;

  body.appendChild(head);
  body.appendChild(payload);
  body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'library-item__actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn--sm';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openSaved(rec.id); });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn--sm btn--ghost';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); deleteSaved(rec.id); });

  actions.appendChild(openBtn);
  actions.appendChild(delBtn);

  li.appendChild(thumb);
  li.appendChild(body);
  li.appendChild(actions);

  // Clicking anywhere on the row opens it, which is what people expect from a list.
  li.addEventListener('click', () => openSaved(rec.id));
  return li;
}

function renderLibrary() {
  const list = $('#library-list');
  list.textContent = '';

  const count = library.items.length;
  $('#library-count').textContent = count ? String(count) : '';
  $('#library-empty').hidden = count > 0;

  library.items.forEach((rec) => list.appendChild(libraryRow(rec)));
}

/** Cheap update of just the "currently open" highlight. */
function highlightLibrary() {
  $$('.library-item').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.id === library.editingId);
  });
}

function syncSaveControls() {
  const record = library.editingId
    ? library.items.find((i) => i.id === library.editingId)
    : null;

  $('#save-btn').textContent = record ? 'Update saved barcode' : 'Save barcode';
  $('#save-new-btn').hidden = !record;
  $('#save-mode').textContent = record
    ? `Editing “${record.name}” · saved ${formatSavedAt(record.updatedAt)}`
    : 'Not saved yet';
}

/* =============================================================================
   12. Wiring and init
   ========================================================================== */

/* --- view modes ------------------------------------------------------------ */

/**
 * The page shows one of three things:
 *
 *   scan    — the whole flow: photo picker, decode results, rebuild options.
 *   viewing — a saved barcode, shown read-only with the options hidden.
 *   editing — that same barcode with its options revealed for renaming/tweaking.
 *
 * In both saved modes the photo picker is replaced by a single "add a new
 * barcode" button, so the saved list stays the focus of the page.
 */
const VIEW_MODES = ['scan', 'viewing', 'editing'];

/**
 * Bring the barcode panel to the top of the page while a saved barcode is open,
 * and put it back below the decode results otherwise.
 *
 * The nodes are actually moved rather than reordered with CSS `order`, so the
 * tab order keeps matching what is on screen.
 */
function leadWithOutputPanel(lead) {
  const main = $('.app-main');
  const output = $('#output-panel');
  const save = $('#save-panel');
  const bar = $('#new-barcode-bar');
  const input = $('#input-panel');
  const results = $('#results-panel');

  if (lead) {
    // The barcode leads the page and the add-new button drops to the bottom,
    // so the saved list reads as the main content of the page.
    if (main.firstElementChild !== output) main.insertBefore(output, main.firstElementChild);
    if (main.lastElementChild !== bar) main.appendChild(bar);
  } else {
    // … saved list -> add-new bar -> photo picker -> … -> results -> barcode
    if (results.nextElementSibling !== output) results.after(output);
    if (bar.nextElementSibling !== input) main.insertBefore(bar, input);
  }

  // The save block always sits directly under the barcode it applies to.
  if (output.nextElementSibling !== save) output.after(save);
}

/**
 * Show or hide the symbol-facing panels.
 *
 *   save-panel    whenever a symbol is on screen — the barcode, its exports and
 *                 the name/save controls all live there now.
 *   output-panel  the same, except in the read-only saved view: its controls are
 *                 unavailable there, so the panel would be an empty shell.
 *                 Pressing Edit brings it back.
 */
function setOutputVisible(on) {
  state.hasSymbol = !!on;
  syncOutputPanels();
}

function syncOutputPanels() {
  const show = state.hasSymbol;
  $('#save-panel').hidden = !show;
  $('#output-panel').hidden = !(show && state.mode !== 'viewing');
  // The full-screen view is an alternative presentation of the symbol, so it
  // follows the same on/off switch.
  syncFullscreenSymbol();
}

/**
 * Open or close the advanced options panel. Collapsed by default so the page
 * stays short; a saved barcode forces it open because the symbol *is* the
 * content in that view.
 */
function setOutputExpanded(on) {
  const body = $('#output-body');
  const toggle = $('#output-toggle');
  if (!body || !toggle) return;
  body.hidden = !on;
  toggle.setAttribute('aria-expanded', String(on));
}

function setMode(mode) {
  const previous = state.mode;
  state.mode = VIEW_MODES.indexOf(mode) === -1 ? 'scan' : mode;
  const saved = state.mode !== 'scan';

  // A saved barcode is the focus of the page, so it leads the layout.
  leadWithOutputPanel(saved);

  // Photo picker <-> "add a new barcode" bar.
  $('#input-panel').hidden = saved;
  $('#new-barcode-bar').hidden = !saved;

  // The rebuild options are for editing; a saved barcode is read-only by
  // default, with an explicit Edit button to bring them back. The panel itself
  // is hidden in that view — see syncOutputPanels().
  $('#edit-saved-btn').hidden = state.mode !== 'viewing';

  // The decode panels belong to the scanning flow only.
  if (saved) {
    $('#source-panel').hidden = true;
    $('#results-panel').hidden = true;
  } else {
    $('#source-panel').hidden = !state.source;
    $('#results-panel').hidden = state.results.length === 0;
  }

  // A saved barcode is headed by its name rather than by a step number.
  const record = saved && library.editingId
    ? library.items.find((i) => i.id === library.editingId)
    : null;
  $('#output-step').hidden = saved;
  $('#output-title').textContent = saved && record ? record.name : 'Advanced options';

  // Only react to real mode changes, so a user who opened the panel keeps it
  // open while re-reading or picking a different result.
  if (state.mode !== previous) setOutputExpanded(saved);

  // Entering or leaving the read-only saved view changes whether the options
  // panel is wanted at all.
  syncOutputPanels();
}

/** Leave a saved barcode behind and go back to reading a new one. */
function startNewBarcode() {
  // Detach from the saved record so the next Save creates a new entry.
  library.editingId = null;
  $('#save-name').value = '';
  syncSaveControls();
  highlightLibrary();

  setMode('scan');

  // Only worth showing the output if something is already decoded.
  setOutputVisible(state.results.length > 0);

  const target = state.source ? $('#source-panel') : $('#input-panel');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setBusy(busy) {
  state.busy = busy;
  ['#decode-btn', '#find-more-btn', '#browse-btn', '#camera-btn'].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = busy;
  });
  $('#decode-btn').textContent = busy ? 'Reading…' : 'Read barcode';
}

function populateFormatSelect() {
  const select = $('#format-select');
  const list = buildEncoderList();
  select.textContent = '';

  const groups = [
    { label: 'Linear (1D)', items: list.filter((f) => f.kind === '1d') },
    { label: 'Matrix (2D)', items: list.filter((f) => f.kind === '2d') },
  ];

  groups.forEach((group) => {
    if (!group.items.length) return;
    const og = document.createElement('optgroup');
    og.label = group.label;
    group.items.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.label;
      og.appendChild(opt);
    });
    select.appendChild(og);
  });

  $('#format-hint').textContent = `${list.length} symbologies available offline. QR is always available and can carry any payload.`;
}

function syncControlVisibility() {
  const entry = currentEncoder();
  if (!entry) return;
  const isQr = entry.kind === '2d';

  $('#ecc-field').hidden = !isQr;
  $('#fontsize-field').hidden = isQr;
  $('#opt-showtext').closest('.check').hidden = isQr;
  $('#opt-height').closest('.field--range').hidden = isQr;
}

/* --- settings persistence ------------------------------------------------- */

const SETTINGS_KEY = 'barcode-restorer:settings:v1';

const SETTING_FIELDS = [
  ['#format-select', 'value'],
  ['#opt-module-width', 'value'],
  ['#opt-height', 'value'],
  ['#opt-quiet', 'value'],
  ['#opt-showtext', 'checked'],
  ['#opt-fontsize', 'value'],
  ['#opt-line-color', 'value'],
  ['#opt-bg-color', 'value'],
  ['#opt-transparent', 'checked'],
  ['#opt-ecc', 'value'],
  ['#deep-scan', 'checked'],
  ['#rare-formats', 'checked'],
];

function saveSettings() {
  try {
    const data = {};
    SETTING_FIELDS.forEach(([sel, prop]) => {
      const el = $(sel);
      if (el) data[sel] = el[prop];
    });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch (_) { /* private mode, ignore */ }
}

function loadSettings() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
  } catch (_) { data = null; }
  if (!data) return;
  SETTING_FIELDS.forEach(([sel, prop]) => {
    const el = $(sel);
    if (el && data[sel] !== undefined) el[prop] = data[sel];
  });
}

/** Keep the little <output> readouts in step with their sliders. */
function syncReadouts() {
  $('#out-module-width').textContent = $('#opt-module-width').value;
  $('#out-height').textContent = $('#opt-height').value;
  $('#out-quiet').textContent = $('#opt-quiet').value;
  $('#out-fontsize').textContent = $('#opt-fontsize').value;
}

function wireEvents() {
  /* --- input --- */
  const fileInput = $('#file-input');
  const cameraInput = $('#camera-input');
  const dropzone = $('#dropzone');

  const openFilePicker = () => fileInput.click();

  dropzone.addEventListener('click', openFilePicker);
  dropzone.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openFilePicker(); }
  });
  $('#browse-btn').addEventListener('click', openFilePicker);

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  $('#camera-btn').addEventListener('click', () => cameraInput.click());
  cameraInput.addEventListener('change', () => {
    if (cameraInput.files && cameraInput.files[0]) loadFile(cameraInput.files[0]);
    cameraInput.value = '';
  });

  // Drag & drop, anywhere on the page.
  ['dragenter', 'dragover'].forEach((type) => {
    window.addEventListener(type, (ev) => {
      if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') === -1) return;
      ev.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'dragend'].forEach((type) => {
    window.addEventListener(type, () => dropzone.classList.remove('is-dragover'));
  });
  window.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
    ev.preventDefault();
    dropzone.classList.remove('is-dragover');
    loadFile(ev.dataTransfer.files[0]);
  });

  // Paste an image straight from the clipboard.
  window.addEventListener('paste', (ev) => {
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        const file = items[i].getAsFile();
        if (file) {
          ev.preventDefault();
          loadFile(file);
          return;
        }
      }
    }
  });

  /* --- decode --- */
  $('#decode-btn').addEventListener('click', () => startRead());
  $('#find-more-btn').addEventListener('click', () => startRead('more'));

  /* --- output controls --- */
  const regenerating = ['#opt-module-width', '#opt-height', '#opt-quiet', '#opt-showtext',
    '#opt-fontsize', '#opt-transparent', '#opt-line-color', '#opt-bg-color', '#opt-ecc',
    '#format-select', '#data-input'];

  regenerating.forEach((sel) => {
    const el = $(sel);
    el.addEventListener('input', () => {
      syncReadouts();
      syncControlVisibility();
      saveSettings();
      renderBarcode();
    });
    el.addEventListener('change', () => {
      syncReadouts();
      syncControlVisibility();
      saveSettings();
      renderBarcode();
    });
  });

  ['#deep-scan', '#rare-formats'].forEach((sel) => {
    $(sel).addEventListener('change', saveSettings);
  });

  /* --- exports --- */
  $('#download-png').addEventListener('click', exportPng);
  $('#download-svg').addEventListener('click', exportSvg);
  $('#copy-image').addEventListener('click', copyImage);
  $('#print-btn').addEventListener('click', printBarcode);

  /* --- save + library --- */
  $('#save-btn').addEventListener('click', saveCurrentBarcode);
  $('#save-name').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      saveCurrentBarcode();
    }
  });
  $('#save-new-btn').addEventListener('click', () => {
    // Detach from the open record so the next Save creates a separate entry.
    library.editingId = null;
    $('#save-name').value = '';
    syncSaveControls();
    highlightLibrary();
    $('#save-name').focus();
    toast('Ready to save as a new entry — name it and press Save.');
  });

  /* --- view modes --- */
  $('#output-toggle').addEventListener('click', () => {
    setOutputExpanded($('#output-body').hidden);
  });
  $('#add-new-btn').addEventListener('click', startNewBarcode);
  $('#edit-saved-btn').addEventListener('click', () => setMode('editing'));

  /* --- viewport --- */
  const onResize = () => fitPreview();
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(onResize);
    ro.observe($('#preview-col'));
  }
}

/* --- pull to refresh (touch) ---------------------------------------------- */

const PULL_RESISTANCE = 0.45;  // finger travel -> indicator travel
const PULL_ARM = 44;           // indicator offset at which releasing refreshes
const PULL_MAX = 104;          // clamp, so the indicator stays put

/**
 * Re-read local state and rebuild the view.
 *
 * Deliberately non-destructive. The app is offline, so a browser-style reload
 * would only discard work in progress — a loaded photo, a decode result, a
 * half-typed name — without fetching anything new. This instead picks up
 * anything another tab has written and re-renders.
 */
function refreshView() {
  loadLibrary();
  renderLibrary();
  syncSaveControls();
  if (!$('#save-panel').hidden) renderBarcode();

  const n = library.items.length;
  toast(n
    ? `Refreshed \u00b7 ${n} saved barcode${n === 1 ? '' : 's'}`
    : 'Refreshed \u00b7 nothing saved yet');
}

function initPullToRefresh() {
  const indicator = $('#ptr');
  const label = $('#ptr-label');
  if (!indicator || !label) return;

  let startY = 0;
  let offset = 0;
  let dragging = false;
  let refreshing = false;
  let releaseTimer = null;

  const applyOffset = (px) => {
    offset = px;
    document.documentElement.style.setProperty('--ptr-offset', `${px}px`);
    clearTimeout(releaseTimer);
    if (px > 0) {
      document.body.classList.add('ptr-active');
    } else {
      // Hold the class through the retract transition, then drop it.
      releaseTimer = setTimeout(() => document.body.classList.remove('ptr-active'), 300);
    }
  };

  const setDragging = (on) => {
    dragging = on;
    document.body.classList.toggle('ptr-drag', on);
    indicator.classList.toggle('is-pulling', on);
  };

  const arm = (on) => {
    indicator.classList.toggle('is-armed', on);
    label.textContent = on ? 'Release to refresh' : 'Pull to refresh';
  };

  const reset = () => {
    setDragging(false);
    applyOffset(0);
    arm(false);
  };

  window.addEventListener('touchstart', (ev) => {
    if (refreshing || ev.touches.length !== 1 || window.scrollY > 0) return;
    // Scrollable regions keep the gesture for themselves.
    if (ev.target.closest && ev.target.closest('.payload, #render-frame')) return;
    startY = ev.touches[0].clientY;
    setDragging(true);
    applyOffset(0);
    arm(false);
  }, { passive: true });

  window.addEventListener('touchmove', (ev) => {
    if (!dragging || refreshing) return;
    const delta = ev.touches[0].clientY - startY;

    if (delta <= 0 || window.scrollY > 0) {
      // Not a pull from the top any more — hand the gesture back to the page.
      reset();
      return;
    }

    // Take the gesture over: stops both the rubber-band and the browser's own
    // refresh affordance, so only one indicator is ever on screen.
    if (ev.cancelable) ev.preventDefault();
    applyOffset(Math.min(PULL_MAX, delta * PULL_RESISTANCE));
    arm(offset >= PULL_ARM);
  }, { passive: false });

  const finish = async () => {
    if (!dragging) return;
    const armed = offset >= PULL_ARM;
    setDragging(false);

    if (!armed) { reset(); return; }

    refreshing = true;
    label.textContent = 'Refreshing…';
    indicator.classList.add('is-refreshing');
    applyOffset(0);

    // Let the spinner paint before the (synchronous) work starts. nextFrame()
    // rather than a bare rAF: rAF is paused in a background tab, so pulling and
    // then switching apps would otherwise leave the indicator spinning forever.
    await nextFrame();
    try {
      refreshView();
      label.textContent = 'Refreshed';
    } finally {
      // Always hand the gesture back, even if the refresh threw.
      setTimeout(() => {
        refreshing = false;
        indicator.classList.remove('is-refreshing');
        arm(false);
      }, 600);
    }
  };

  window.addEventListener('touchend', finish, { passive: true });
  window.addEventListener('touchcancel', () => { if (dragging) reset(); }, { passive: true });
}

/* --- landscape full-screen symbol (touch) ---------------------------------- */

/**
 * On a phone, turning it on its side shows the barcode and nothing else: it is
 * the thing being held up to a scanner, and the rest of the interface only
 * steals room and gives the hand something to knock. Turning it back to
 * portrait restores the interface exactly as it was.
 *
 * The symbol is mirrored into its own fixed layer rather than moved out of the
 * preview frame, so the frame is never disturbed and coming back is a matter of
 * hiding the layer again. The `pointer: coarse` test is what stops a wide
 * desktop window from blanking the page.
 */
function isTouchDevice() {
  // The primary pointer being coarse is the one signal that means "phone or
  // tablet". navigator.maxTouchPoints is deliberately NOT used as a fallback:
  // it is also non-zero on a touchscreen laptop, which would blank the page on
  // every landscape window.
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

/** Should the symbol be on screen by itself right now? */
function wantsFullscreenSymbol() {
  return isTouchDevice()
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(orientation: landscape)').matches
    && state.hasSymbol
    && !!state.render;
}

/** Show or hide the full-screen symbol to match the current state. */
function syncFullscreenSymbol() {
  const layer = $('#fullscreen-symbol');
  if (!layer) return;

  if (!wantsFullscreenSymbol()) {
    if (!layer.hidden) {
      layer.textContent = '';
      layer.hidden = true;
      layer.removeAttribute('aria-label');
      document.body.classList.remove('is-symbol-fullscreen');
    }
    return;
  }

  const svg = svgForDisplay(state.render.svg);
  if (!svg) return;

  // Rebuilt from the render state rather than moved out of the preview frame,
  // so the frame still has its copy when portrait comes back.
  layer.textContent = '';
  svg.style.width = '100%';
  svg.style.height = '100%';
  layer.appendChild(svg);
  layer.setAttribute('aria-label', `${state.render.entry.label} barcode`);
  layer.hidden = false;
  document.body.classList.add('is-symbol-fullscreen');
}

function initFullscreenSymbol() {
  if (typeof window.matchMedia !== 'function') return;

  const landscape = window.matchMedia('(orientation: landscape)');
  const onChange = () => syncFullscreenSymbol();

  if (landscape.addEventListener) landscape.addEventListener('change', onChange);
  else if (landscape.addListener) landscape.addListener(onChange);

  // Rotation also arrives as an ordinary resize, which covers browsers that fire
  // it before the layout has settled (and desktop windows being resized).
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
}

function checkLibraries() {
  const missing = [];
  if (!LIB.zxing) missing.push('vendor/zxing.min.js');
  if (!LIB.jsBarcode) missing.push('vendor/JsBarcode.all.min.js');
  if (!LIB.qrcode) missing.push('vendor/qrcode.js');
  if (!missing.length) return true;

  const main = $('.app-main');
  const p = document.createElement('p');
  p.className = 'notice notice--warn notice--error';
  p.textContent = `Missing library file(s): ${missing.join(', ')}. `
    + 'Make sure the vendor folder was downloaded next to index.html.';
  main.insertBefore(p, main.firstChild);
  return false;
}

function init() {
  if (!checkLibraries()) return;

  // The dropdown has to exist before saved preferences can be applied to it.
  populateFormatSelect();
  loadSettings();
  syncReadouts();
  syncControlVisibility();

  // Restore anything saved in a previous visit.
  loadLibrary();
  renderLibrary();
  syncSaveControls();

  // The saved list is the landing view, with the photo picker below it.
  setMode('scan');

  wireEvents();
  initPullToRefresh();
  initFullscreenSymbol();

  const n = library.items.length;
  $('#dropzone-status').textContent = n
    ? `Ready. ${n} saved barcode${n === 1 ? '' : 's'} in this browser — nothing is uploaded.`
    : 'Ready. Nothing is uploaded — decoding happens in this tab.';
}

init();
