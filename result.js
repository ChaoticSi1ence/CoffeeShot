// CoffeeShot result tab: pulls the capture from the worker, stitches or crops
// it, lets you draw on it, then copies or saves the PNG.

const $ = (s) => document.querySelector(s);
const base = $("#base"), ink = $("#ink");
const bctx = base.getContext("2d"), ictx = ink.getContext("2d");
const id = location.hash.slice(1);
const MAX_SIDE = 16384;   // memory and encode-time budget; Blink's own side limit is 65,535 px

let ready = false, saving = false, ops = [], cur = null, tool = "pen", color = "#e53935", stroke = 3;

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

function setSize(w, h) {
  base.width = ink.width = w;
  base.height = ink.height = h;
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
  let prevBottom = -Infinity;
  for (let i = 0; i < n; i++) {
    status(`Stitching ${i + 1} of ${n}…`);
    const bm = i === 0 ? first : await strip(i);
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
    p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
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
  }
}

function redraw() {
  ictx.clearRect(0, 0, ink.width, ink.height);
  for (const op of ops) drawOp(ictx, op);
  if (cur) drawOp(ictx, cur);
}

function pt(e) {
  const r = ink.getBoundingClientRect();
  return [(e.clientX - r.left) * ink.width / r.width, (e.clientY - r.top) * ink.height / r.height];
}

function commit() {
  if (!cur) return;
  ops.push(cur); cur = null; redraw();
}

ink.addEventListener("pointerdown", (e) => {
  if (!ready || e.button !== 0 || cur) return;
  ink.setPointerCapture(e.pointerId);
  const p = pt(e);
  cur = { tool, color, width: stroke, pts: [p, p] };
  redraw();
});
ink.addEventListener("pointermove", (e) => {
  if (!cur) return;
  const p = pt(e);
  if (cur.tool === "pen") cur.pts.push(p); else cur.pts[1] = p;
  redraw();
});
for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.addEventListener(t, commit);

function pick(kind, value) {
  if (kind === "tool") tool = value; else color = value;
  document.querySelectorAll(`[data-${kind}]`).forEach((b) => b.classList.toggle("on", b.dataset[kind] === value));
}
document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => pick("tool", b.dataset.tool)));
document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => pick("color", b.dataset.color)));
$("#undo").addEventListener("click", () => { ops.pop(); redraw(); });

// ---- output ---------------------------------------------------------------

// This tab exists to mark the shot up. Once it has been copied or saved,
// its job is done, so it gets out of the way.
function closeSoon() {
  setTimeout(async () => {
    const tab = await chrome.tabs.getCurrent().catch(() => null);
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }, 900);
}

function exportBlob() {
  const c = document.createElement("canvas");
  c.width = base.width; c.height = base.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(base, 0, 0);
  ctx.drawImage(ink, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"));
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
  if (mod && k === "z") { e.preventDefault(); ops.pop(); redraw(); }
  else if (mod && k === "s") { e.preventDefault(); save(); }
  else if (mod && k === "c") {
    const s = getSelection();
    if (s && !s.isCollapsed) return;          // let selected text copy as text
    e.preventDefault(); copy();
  } else if (!mod && !e.altKey) {
    if (e.key === "Enter") { if (!(e.target instanceof HTMLButtonElement)) { e.preventDefault(); save(); } }
    else if (k === "p") pick("tool", "pen"); else if (k === "r") pick("tool", "rect"); else if (k === "a") pick("tool", "arrow");
  }
});

load();
