// CoffeeShot result tab: pulls the capture from the worker, stitches or crops
// it, lets you draw on it, then copies or saves the PNG.

const $ = (s) => document.querySelector(s);
const base = $("#base"), ink = $("#ink");
const bctx = base.getContext("2d"), ictx = ink.getContext("2d");
const id = location.hash.slice(1);
const MAX_SIDE = 16384;   // memory and encode-time budget; Blink's own side limit is 65,535 px

let ready = false, saving = false, ops = [], cur = null, tool = "pen", color = "#e53935", stroke = 3;
let live = null, frame = 0;   // bounds of the shape being dragged, and its queued frame
let inkSized = false;         // the ink layer is only allocated once you draw
let inkRect = null;           // cached canvas rect, so pointer moves read no layout
let actions = [];             // undo stack: "stroke", or a crop with the image it replaced

const status = (t) => { $("#status").textContent = t; };
const ask = (msg) => chrome.runtime.sendMessage({ id, ...msg });
const bitmap = async (dataUrl) => createImageBitmap(await (await fetch(dataUrl)).blob());

function pad(n) { return String(n).padStart(2, "0"); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function disableAll() {
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
}

// The ink layer matches the capture, which for a full page is tens of
// millions of pixels. Most captures are copied or saved without a single
// stroke, so its buffer is not allocated until the first one.
function sizeInk() {
  if (inkSized) return;
  ink.width = base.width;
  ink.height = base.height;
  inkSized = true;
}

function setSize(w, h) {
  base.width = w;
  base.height = h;
  $("#wrap").style.width = Math.round(w / devicePixelRatio) + "px";
  $("#wrap").classList.add("ready");
  stroke = Math.max(3, Math.round(w / 600));
}

async function strip(i) {
  const r = await ask({ type: "strip", index: i });
  if (!r || !r.ok || !r.dataUrl) throw new Error("the capture is gone");
  return bitmap(r.dataUrl);
}

// ---- build the image ------------------------------------------------------

async function load() {
  let job;
  try { job = await ask({ type: "job" }); } catch { job = null; }
  if (!job || !job.ok) {
    status("Nothing to show. This capture is gone; take it again.");
    disableAll();
    return;
  }
  if (job.note) { $("#note").textContent = job.note; $("#note").hidden = false; }
  if (job.mode === "error") { status("No capture."); disableAll(); return; }
  status("Loading…");
  try {
    if (job.mode === "full") await buildFull(job);
    else await buildOne(job);
  } catch (err) {
    status(`Could not build the image: ${err.message}`);
    disableAll();
    return;
  }
  ready = true;
  document.title = `CoffeeShot ${base.width}×${base.height}`;
  status(job.mode === "full" && job.meta && job.meta.capped ? "Stopped at 40 screens." : "");
  // The page refused the in-page picker, so the area is picked here instead.
  // On any other page that would be a second way to do what the picker did,
  // so the control stays hidden.
  if (job.pick) {
    $("#crop").hidden = false;
    pickTool("crop");
    status("Drag to pick the area.");
    // Fit the whole snapshot on screen while picking, so the drag never
    // needs a scroll. The crop's setSize puts the image back to true size.
    const room = innerHeight - $("header").offsetHeight - 24 - ($("#note").hidden ? 0 : $("#note").offsetHeight + 10);
    const fit = Math.min(base.width / devicePixelRatio, room * base.width / base.height);
    $("#wrap").style.width = Math.max(200, Math.round(fit)) + "px";
    inkRect = null;
  }
  // Keep the worker, and with it this capture, around while the tab is open,
  // so a reload can rebuild the image.
  setInterval(() => ask({ type: "ping" }).catch(() => {}), 25000);
}

async function buildOne(job) {
  const bm = await strip(0);
  if (job.mode === "area") {
    const { rect, vw } = job.meta;
    const scale = bm.width / vw;
    const sx = Math.round(rect.x * scale), sy = Math.round(rect.y * scale);
    const sw = Math.min(bm.width - sx, Math.round((rect.x + rect.w) * scale) - sx);
    const sh = Math.min(bm.height - sy, Math.round((rect.y + rect.h) * scale) - sy);
    setSize(sw, sh);
    bctx.drawImage(bm, sx, sy, sw, sh, 0, 0, sw, sh);
  } else {
    setSize(bm.width, bm.height);
    bctx.drawImage(bm, 0, 0);
  }
  bm.close();
}

async function buildFull(job) {
  const m = job.meta, ys = job.ys, n = job.count;
  const first = await strip(0);
  const scale = first.width / m.vw;                                   // device px per CSS px
  const covered = m.capped ? Math.min(m.total, ys[n - 1] + m.clipH) : m.total;
  const tail = m.inner && !m.capped ? Math.max(0, m.vh - m.clipTop - m.clipH) : 0;   // page below an inner scroller
  const fullH = m.clipTop + covered + tail;                           // CSS px
  const width = Math.min(m.clientWidth, m.vw);                        // drops the scrollbar column
  let f = 1;
  if (fullH * scale > MAX_SIDE) f = MAX_SIDE / (fullH * scale);
  if (width * scale * f > MAX_SIDE) f = MAX_SIDE / (width * scale);
  const W = Math.round(width * scale * f), H = Math.round(fullH * scale * f);
  setSize(W, H);
  bctx.imageSmoothingQuality = "high";
  const dy = (css) => Math.round(css * scale * f);
  // Source rows [sy0, sy1) of a viewport shot (CSS px) land at page row dy0 (CSS px).
  const draw = (bm, sy0, sy1, dy0) => {
    const sY = Math.round(sy0 * scale), sH = Math.round(sy1 * scale) - sY;
    const dY = dy(dy0), dH = dy(dy0 + (sy1 - sy0)) - dY;
    if (sH > 0 && dH > 0) bctx.drawImage(bm, 0, sY, Math.round(width * scale), sH, 0, dY, W, dH);
  };
  if (m.clipTop > 0) draw(first, 0, m.clipTop, 0);
  if (tail > 0) draw(first, m.clipTop + m.clipH, m.vh, m.clipTop + covered);
  // Each screen is requested and decoded while the previous one is still being
  // drawn, so the transfer and the painting overlap instead of taking turns.
  let prevBottom = -Infinity, pending = null;
  for (let i = 0; i < n; i++) {
    status(`Stitching ${i + 1} of ${n}…`);
    const bm = i === 0 ? first : await pending;
    pending = i + 1 < n ? strip(i + 1) : null;
    // Rows already drawn keep what an earlier strip showed there (the first
    // strip is the one with the fixed header), so only new rows are painted.
    const skip = Math.max(0, prevBottom - ys[i]);
    if (skip < m.clipH) draw(bm, m.clipTop + skip, m.clipTop + m.clipH, m.clipTop + ys[i] + skip);
    prevBottom = ys[i] + m.clipH;
    bm.close();
  }
}

// ---- markup ---------------------------------------------------------------

function drawOp(ctx, op) {
  ctx.strokeStyle = op.color; ctx.fillStyle = op.color;
  ctx.lineWidth = op.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const p = op.pts;
  if (op.tool === "pen") {
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  } else if (op.tool === "rect") {
    const [[x0, y0], [x1, y1]] = p;
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (op.tool === "arrow") {
    const [[x0, y0], [x1, y1]] = p;
    const a = Math.atan2(y1 - y0, x1 - x0), h = op.width * 4;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - h * Math.cos(a - 0.5), y1 - h * Math.sin(a - 0.5));
    ctx.lineTo(x1 - h * Math.cos(a + 0.5), y1 - h * Math.sin(a + 0.5));
    ctx.closePath(); ctx.fill();
  } else if (op.tool === "crop") {
    // a marquee: dark line under a white dashed one, readable on anything
    const [[x0, y0], [x1, y1]] = p;
    const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.save();
    ctx.lineWidth = Math.max(2, op.width * 0.6);
    ctx.strokeStyle = "rgba(0,0,0,.65)";
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([op.width * 2, op.width * 2]);
    ctx.strokeStyle = "#fff";
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

// A full-page canvas runs to tens of millions of pixels, so clearing and
// replaying every stroke on each pointer move is far too expensive. Pen
// strokes are extended one segment at a time, and the shapes that change
// shape as you drag only repaint the rectangle they occupy.

function redrawAll() {
  ictx.clearRect(0, 0, ink.width, ink.height);
  for (const op of ops) drawOp(ictx, op);
  if (cur) drawOp(ictx, cur);
  live = null;
}

function bounds(op) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of op.pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const pad = op.width * 5 + 4;   // round caps, joins and the arrow head
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

// Clear one rectangle and put back only the committed strokes that cross it.
function repaint(box) {
  const [x0, y0, x1, y1] = box;
  ictx.save();
  ictx.beginPath();
  ictx.rect(x0, y0, x1 - x0, y1 - y0);
  ictx.clip();
  ictx.clearRect(x0, y0, x1 - x0, y1 - y0);
  for (const op of ops) {
    const b = op.box;
    if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
    drawOp(ictx, op);
  }
  ictx.restore();
}

function paintLive() {
  frame = 0;
  if (!cur || cur.tool === "pen") return;
  const box = bounds(cur);
  repaint(live ? union(live, box) : box);
  drawOp(ictx, cur);
  live = box;
  if (cur.tool === "crop") {
    const [[ax, ay], [bx, by]] = cur.pts;
    status(`${Math.round(Math.abs(bx - ax))} × ${Math.round(Math.abs(by - ay))}`);
  }
}

// Crop the capture to the dragged rectangle. Strokes move with it, and the
// uncropped image is kept so Ctrl+Z can bring it back.
function applyCrop(op) {
  const [[ax, ay], [bx, by]] = op.pts;
  const x = Math.max(0, Math.round(Math.min(ax, bx))), y = Math.max(0, Math.round(Math.min(ay, by)));
  const w = Math.min(base.width - x, Math.round(Math.abs(bx - ax)));
  const h = Math.min(base.height - y, Math.round(Math.abs(by - ay)));
  if (w < 4 || h < 4) { status("Drag to pick the area."); return; }
  const keep = document.createElement("canvas");
  keep.width = base.width; keep.height = base.height;
  keep.getContext("2d").drawImage(base, 0, 0);
  actions.push({ image: keep, ops: ops.map((o) => ({ ...o, pts: o.pts.map((q) => q.slice()) })) });
  const cut = document.createElement("canvas");
  cut.width = w; cut.height = h;
  cut.getContext("2d").drawImage(base, x, y, w, h, 0, 0, w, h);
  const pen = stroke;                 // line weight belongs to the image, not the crop
  setSize(w, h);
  stroke = pen;
  bctx.drawImage(cut, 0, 0);
  for (const o of ops) { o.pts = o.pts.map(([px, py]) => [px - x, py - y]); o.box = bounds(o); }
  if (inkSized) { ink.width = w; ink.height = h; redrawAll(); }
  inkRect = null;
  document.title = `CoffeeShot ${w}×${h}`;
  status(`Cropped to ${w} × ${h}. Enter saves, Ctrl+C copies, Ctrl+Z restores the whole tab.`);
  pickTool("pen");
}

function undo() {
  const a = actions.pop();
  if (!a) return;
  if (a === "stroke") { ops.pop(); redrawAll(); return; }
  const pen = stroke;
  setSize(a.image.width, a.image.height);
  stroke = pen;
  bctx.drawImage(a.image, 0, 0);
  ops = a.ops;
  if (inkSized) { ink.width = base.width; ink.height = base.height; redrawAll(); }
  inkRect = null;
  document.title = `CoffeeShot ${base.width}×${base.height}`;
  status("Crop undone.");
}

// Extend a pen stroke by its newest segment, leaving everything else alone.
function drawSegment(op) {
  const n = op.pts.length;
  if (n < 2) return;
  ictx.strokeStyle = op.color;
  ictx.lineWidth = op.width;
  ictx.lineCap = "round";
  ictx.lineJoin = "round";
  ictx.beginPath();
  ictx.moveTo(op.pts[n - 2][0], op.pts[n - 2][1]);
  ictx.lineTo(op.pts[n - 1][0], op.pts[n - 1][1]);
  ictx.stroke();
}

// Measured once per stroke rather than on every move, since reading it forces
// the browser to settle layout. Scrolling or resizing drops the cached value.
function pt(e) {
  if (!inkRect) inkRect = ink.getBoundingClientRect();
  return [(e.clientX - inkRect.left) * ink.width / inkRect.width, (e.clientY - inkRect.top) * ink.height / inkRect.height];
}
const dropRect = () => { inkRect = null; };
addEventListener("scroll", dropRect, { passive: true, capture: true });
addEventListener("resize", dropRect, { passive: true });

function commit() {
  if (!cur) return;
  if (cur.tool === "crop") {
    const c = cur;
    cur = null;
    if (live) { repaint(live); live = null; }   // take the marquee off first
    applyCrop(c);
    return;
  }
  if (cur.tool !== "pen") paintLive();   // a queued frame may not have run yet
  cur.box = bounds(cur);
  ops.push(cur);
  actions.push("stroke");
  cur = null;
  live = null;
}

ink.addEventListener("pointerdown", (e) => {
  if (!ready || e.button !== 0 || cur) return;
  sizeInk();
  ink.setPointerCapture(e.pointerId);
  const p = pt(e);
  cur = { tool, color, width: stroke, pts: [p, p] };
  live = null;
});
ink.addEventListener("pointermove", (e) => {
  if (!cur) return;
  const p = pt(e);
  if (cur.tool === "pen") {
    cur.pts.push(p);
    drawSegment(cur);
  } else {
    cur.pts[1] = p;
    if (!frame) frame = requestAnimationFrame(paintLive);
  }
});
for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.addEventListener(t, commit);

function pickTool(value) {
  tool = value;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === value));
}

// The swatches and the colour input share one selected state, so whichever
// was touched last is the one that draws.
function pickColor(value, el) {
  color = value;
  document.querySelectorAll(".colors > *").forEach((b) => b.classList.toggle("on", b === el));
}

document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => pickTool(b.dataset.tool)));
document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => pickColor(b.dataset.color, b)));
const custom = $("#custom");
for (const t of ["input", "change", "click"]) custom.addEventListener(t, () => pickColor(custom.value, custom));
$("#undo").addEventListener("click", undo);

// ---- output ---------------------------------------------------------------

// This tab exists to mark the shot up. Once it has been copied or saved,
// its job is done, so it gets out of the way.
function closeSoon() {
  setTimeout(async () => {
    const tab = await chrome.tabs.getCurrent().catch(() => null);
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }, 900);
}

// With no markup there is nothing to merge, so the capture is encoded straight
// from its own canvas instead of being copied into a second full-size one.
function exportBlob() {
  let src = base;
  if (inkSized) {
    src = document.createElement("canvas");
    src.width = base.width; src.height = base.height;
    const ctx = src.getContext("2d");
    ctx.drawImage(base, 0, 0);
    ctx.drawImage(ink, 0, 0);
  }
  return new Promise((resolve, reject) => src.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"));
}

// The clipboard write must start inside the click. The blob is passed as a
// promise so encoding time cannot outlive the user activation.
function copy() {
  if (!ready) return;
  status("Copying…");
  navigator.clipboard.write([new ClipboardItem({ "image/png": exportBlob() })]).then(
    () => { status("Copied to clipboard."); closeSoon(); },
    (err) => status(`Copy failed (${err.name}). Click Copy again, or use Save.`)
  );
}

async function save() {
  if (!ready || saving) return;
  saving = true;
  status("Saving…");
  const url = URL.createObjectURL(await exportBlob());
  const filename = `coffeeshot-${timestamp()}.png`;
  let dlId = null;
  const done = () => {
    saving = false;
    chrome.downloads.onChanged.removeListener(onChanged);
    URL.revokeObjectURL(url);
  };
  const onChanged = async (d) => {
    if (d.id !== dlId || !d.state) return;
    if (d.state.current === "complete") {
      const [item] = await chrome.downloads.search({ id: dlId });
      const name = item && item.filename ? item.filename.split(/[\\/]/).pop() : filename;
      status(`Saved as ${name}`);
      done();
      closeSoon();
    } else if (d.state.current === "interrupted") {
      status(`Brave did not save the file (${(d.error && d.error.current) || "interrupted"}).`);
      done();
    }
  };
  chrome.downloads.onChanged.addListener(onChanged);
  try {
    dlId = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    setTimeout(() => {
      if (!saving) return;
      status("Save not confirmed. Check Brave's download bubble.");
      done();
    }, 60000);
  } catch (err) {
    status(`Save failed: ${err.message}`);
    done();
  }
}

$("#copy").addEventListener("click", copy);
$("#save").addEventListener("click", save);

document.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); undo(); }
  else if (e.key === "Escape" && cur) {
    const t = cur.tool;
    cur = null;
    if (t === "pen") redrawAll(); else if (live) { repaint(live); live = null; }
    if (t === "crop") status("Drag to pick the area.");
  }
  else if (mod && k === "s") { e.preventDefault(); save(); }
  else if (mod && k === "c") {
    const s = getSelection();
    if (s && !s.isCollapsed) return;          // let selected text copy as text
    e.preventDefault(); copy();
  } else if (!mod && !e.altKey) {
    if (e.key === "Enter") { if (!(e.target instanceof HTMLButtonElement)) { e.preventDefault(); save(); } }
    else if (k === "p") pickTool("pen"); else if (k === "r") pickTool("rect"); else if (k === "a") pickTool("arrow");
    else if (k === "x" && !$("#crop").hidden) pickTool("crop");
  }
});

load();
