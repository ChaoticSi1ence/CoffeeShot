// CoffeeShot page helper, injected on demand into the tab you clicked on.
// Shows the picker on a frozen snapshot of the tab and drives full-page
// capture. It only talks to background.js; it never touches the page's own
// scripts, and everything it adds is removed again when it is done.

(() => {
  if (window.__coffeeshot) return;
  const S = (window.__coffeeshot = { close: null });

  const LOST = "CoffeeShot lost the capture. Click the cup again.";
  const NO_COPY = "This page could not copy directly, so it opened here. Press Copy.";
  const PICK_ACTION = { f: "full", v: "visible", s: "save" };   // pill buttons and their keys
  const SEL_ACTION = { c: "copy", s: "save", e: "edit" };       // selection toolbar and its keys
  // The worker is shut down after 30 s without events, and the capture lives
  // only in its memory, so an open picker keeps nudging it.
  const KEEPALIVE_MS = 20000;

  const send = (m) => chrome.runtime.sendMessage(m).catch(() => ({ ok: false, error: "lost" }));
  const gone = (r) => r.error === "expired" || r.error === "lost";
  const saved = (r) => toast(r.ok ? "Saved to Downloads." : gone(r) ? LOST : `Save failed: ${r.error}`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "alive") { reply({ ok: true }); return; }
    if (msg.type === "close") {
      if (S.close) S.close();
      // Answer once the overlay is off the screen: the caller's next shot may
      // be of this tab. A hidden tab gets no frames, so it answers at once.
      (document.hidden ? Promise.resolve() : frames(2)).then(() => reply({ ok: true }));
      return true;
    }
    if (msg.type !== "start") return;
    if (S.close) S.close();                      // a stale picker gives way
    if (isPdfViewer()) { reply({ ok: false, error: "pdf" }); return; }
    if (msg.mode === "full") { reply({ ok: true }); fullPage(msg.id); return; }
    try {
      picker(msg);
      reply({ ok: true });
    } catch {
      reply({ ok: false, error: "unsupported" });   // XML/SVG documents cannot host the picker
    }
  });

  // The PDF viewer's page is a bare <embed>; it accepts the script but nothing
  // in it scrolls for us.
  function isPdfViewer() {
    const b = document.body;
    const only = b && b.childElementCount === 1 ? b.firstElementChild : null;
    return !!only && only.tagName === "EMBED" && /pdf/i.test(only.type || "");
  }

  // A host element whose shadow tree the page's stylesheets cannot reach.
  // Every :host declaration is !important because, for the host element,
  // ordinary page rules would otherwise win over the shadow stylesheet.
  function mount(hostCss, html) {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>:host { ${HOST} ${hostCss} } ${CSS}</style>${html}`;
    document.documentElement.appendChild(host);
    return { host, root };
  }

  const HOST = "all: initial !important; position: fixed !important; z-index: 2147483647 !important; outline: none !important;";
  const PANEL = "background: #222; color: #fff; font: 14px system-ui, sans-serif;";

  // One stylesheet for everything the page ever shows: the picker and the
  // toast, which outlives it. Animations run on entrance only. The overlay is
  // torn down synchronously, because a fading overlay could still be on screen
  // when the next captureVisibleTab fires during a full-page run.
  const CSS = `
    canvas { position: absolute; left: 0; top: 0; width: 100vw; height: 100vh; display: block; }
    .dim { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
    /* Four plain rectangles dim everything outside the selection. One huge
       box-shadow would repaint the entire window on every mouse move. */
    .masks > div { position: absolute; background: rgba(0,0,0,.45); }
    .masks > div:nth-child(-n+2) { left: 0; width: 100%; }   /* above and below span the width */
    .masks > div:nth-child(1) { top: 0; }
    .sel { position: absolute; border: 1px solid #fff; }
    /* One shape for every control in the extension: a capsule. */
    .size { position: absolute; ${PANEL} font-size: 12px; padding: 2px 6px; border-radius: 999px;
            animation: cs-fade .1s ease-out both; }
    .pill, .bar, .toast { position: absolute; ${PANEL} box-shadow: 0 4px 16px rgba(0,0,0,.4); border-radius: 999px; }
    .pill, .bar { display: flex; gap: 8px; align-items: center; cursor: default; white-space: nowrap; }
    .pill, .toast { top: 16px; left: 0; right: 0; margin: auto; width: fit-content;
                    animation: cs-drop .2s cubic-bezier(.2,.8,.3,1) both; }
    .pill { padding: 6px 16px; }
    .toast { padding: 8px 14px; }
    .toast.out { animation: cs-out .3s ease-in both; }
    .bar { padding: 6px; transform-origin: 100% 0;
           animation: cs-pop .2s cubic-bezier(.2,.8,.3,1) both; }
    .pill button, .bar button { all: initial; font: inherit; color: inherit; background: #444;
                                cursor: pointer; padding: 6px 12px; border-radius: 999px;
                                transition: background .12s ease, transform .12s ease, opacity .12s ease; }
    .pill button:hover, .bar button:hover { background: #666; }
    .pill button:active, .bar button:active { transform: scale(.96); }
    .pill button:focus-visible, .bar button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .bar button.primary { background: #1e88e5; }
    .bar button.primary:hover { background: #1976d2; }
    /* The buttons dim, not the bar: cs-pop's fill mode pins the bar's opacity. */
    .bar.busy button { opacity: .6; pointer-events: none; }
    .pill span { opacity: .7; }
    [hidden] { display: none !important; }
    @keyframes cs-fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes cs-drop { from { opacity: 0; transform: translateY(-12px) } to { opacity: 1; transform: none } }
    @keyframes cs-pop { from { opacity: 0; transform: translateY(-6px) scale(.94) } to { opacity: 1; transform: none } }
    @keyframes cs-out { from { opacity: 1; transform: none } to { opacity: 0; transform: translateY(-8px) } }
    @media (prefers-reduced-motion: reduce) {
      :host { animation: none !important; }
      * { animation: none !important; transition: none !important }
    }
  `;

  function toast(text) {
    const { host, root } = mount("inset: 0 !important; pointer-events: none !important;", `<div class="toast"></div>`);
    const el = root.querySelector(".toast");
    el.textContent = text;
    setTimeout(() => el.classList.add("out"), 3600);
    setTimeout(() => host.remove(), 3950);
  }

  function toBlob(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  }

  // ---- picker -------------------------------------------------------------

  function picker({ id, mode, snapshot }) {
    const { host, root } = mount(
      "inset: 0 !important; cursor: crosshair !important; user-select: none !important; animation: cs-fade .13s ease-out both !important;",
      `<canvas></canvas><div class="dim"></div>` +
      `<div class="masks" hidden><div></div><div></div><div></div><div></div></div>` +
      `<div class="sel" hidden></div><div class="size" hidden></div>` +
      `<div class="bar" hidden><button data-a="copy" class="primary">Copy (C)</button><button data-a="save">Save (S)</button><button data-a="edit">Edit (E)</button></div>` +
      `<div class="pill">Drag to capture an area` +
      (mode === "pick"
        ? `<button data-k="f">Full page (F)</button><button data-k="v">Visible tab (V)</button><button data-k="s">Save visible tab (S)</button>`
        : ``) +
      `<span>Esc to cancel</span></div>`);
    const canvas = root.querySelector("canvas"), dim = root.querySelector(".dim");
    const sel = root.querySelector(".sel"), size = root.querySelector(".size");
    const masks = root.querySelector(".masks"), mask = masks.children;
    const pill = root.querySelector(".pill"), bar = root.querySelector(".bar");
    const prevFocus = document.activeElement;
    let start = null, selRect = null, closed = false, busy = false;

    // Keys go to the focused document, which may be an iframe; take focus so
    // the shortcuts reach us, and give it back afterwards.
    host.tabIndex = -1;
    host.focus({ preventScroll: true });

    const ping = setInterval(async () => {
      if (!(await send({ type: "ping", id })).ok) { close(); toast(LOST); }
    }, KEEPALIVE_MS);

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      for (const t of ["keydown", "keyup", "keypress"]) window.removeEventListener(t, onKey, true);
      host.remove();
      S.close = null;
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    };
    S.close = close;

    // The rest happens in a CoffeeShot tab; the picker's part is over. The
    // tab is the answer, so nothing is said here unless the hand-off fails.
    const handoff = (m) => {
      close();
      send({ type: "open", id, ...m }).then((r) => { if (!r.ok) toast(LOST); });
    };

    // ---- whole-tab choices from the pill ----
    const finish = async (action) => {
      if (action === "cancel") { close(); send({ type: "cancel", id }); return; }
      if (action === "save") { close(); saved(await send({ type: "save", id })); return; }
      if (action === "visible") { handoff({ mode: "visible" }); return; }
      close();
      const r = await send({ type: "full-start", id });
      if (r.ok) fullPage(id); else toast(LOST);
    };

    // ---- selection choices from the toolbar ----
    // Copy and Save finish here. Only Edit opens the CoffeeShot tab.
    const act = (action) => {
      if (busy || !selRect) return;
      busy = true;
      const meta = { rect: selRect, vw: innerWidth };
      if (action === "edit") { handoff({ mode: "area", meta }); return; }
      if (action === "save") { close(); send({ type: "save", id, meta }).then(saved); return; }

      // Copy. navigator.clipboard exists only in a secure context, so plain
      // http:// pages hand the crop to the CoffeeShot tab, which says why.
      if (!window.isSecureContext || !navigator.clipboard || !window.ClipboardItem) {
        handoff({ mode: "area", meta, note: NO_COPY });
        return;
      }
      bar.classList.add("busy");
      // write() is called inside the click with the PNG still pending, so the
      // crop can take as long as it likes without losing the user gesture.
      const png = (async () => {
        const r = await send({ type: "crop", id, meta });
        if (!r.ok || !r.dataUrl) throw new Error(r.error || "expired");
        return toBlob(r.dataUrl);
      })();
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
        () => { close(); toast("Copied to clipboard."); send({ type: "cancel", id }); },
        () => handoff({ mode: "area", meta, note: NO_COPY })
      );
    };

    const onKey = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.type !== "keydown" || e.altKey) return;
      if (e.key === "Escape") { if (selRect) reset(); else finish("cancel"); return; }
      const k = e.key.toLowerCase();
      // Ctrl+C and Ctrl+S mean the same as C and S; every other chord stays swallowed.
      if ((e.ctrlKey || e.metaKey) && k !== "c" && k !== "s") return;
      if (selRect) {
        const a = SEL_ACTION[k];
        if (typeof a === "string") act(a);
        return;
      }
      if (mode !== "pick") return;
      const a = PICK_ACTION[k];
      if (typeof a === "string") finish(a);
    };
    for (const t of ["keydown", "keyup", "keypress"]) window.addEventListener(t, onKey, true);

    for (const el of [pill, bar]) el.addEventListener("mousedown", (e) => e.stopPropagation());
    pill.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(PICK_ACTION[b.dataset.k]);
    }));
    bar.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      act(b.dataset.a);
    }));
    for (const t of ["wheel", "contextmenu", "dblclick"]) host.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); });

    root.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || busy) return;
      e.preventDefault(); e.stopPropagation();
      selRect = null;
      bar.hidden = true;
      pill.hidden = false;
      start = [e.clientX, e.clientY];
      dim.hidden = true; masks.hidden = false; sel.hidden = false; size.hidden = false;
      place(e);
    });
    root.addEventListener("mousemove", (e) => { if (start) place(e); });
    root.addEventListener("mouseup", (e) => {
      if (!start || e.button !== 0) return;
      const r = rect(e);
      start = null;
      if (r.w < 4 || r.h < 4) { reset(); return; }
      selRect = r;
      pill.hidden = true;
      showBar(r);
    });

    function reset() {
      selRect = null;
      dim.hidden = false; masks.hidden = true; sel.hidden = true; size.hidden = true; bar.hidden = true;
      pill.hidden = false;
    }

    // The toolbar sits under the selection's bottom-right corner, its right
    // edge flush with the selection's, flipping above or clamping inward when
    // there is no room.
    function showBar(r) {
      bar.hidden = false;
      const bw = bar.offsetWidth, bh = bar.offsetHeight;
      let y = r.y + r.h + 8;
      if (y + bh > innerHeight - 4) y = r.y - bh - 8;
      if (y < 4) y = Math.max(4, Math.min(innerHeight - bh - 4, r.y + r.h + 8));
      const x = Math.max(4, Math.min(r.x + r.w - bw, innerWidth - bw - 4));
      bar.style.left = x + "px";
      bar.style.top = y + "px";
    }

    function rect(e) {
      const x = Math.max(0, Math.min(start[0], e.clientX)), y = Math.max(0, Math.min(start[1], e.clientY));
      const x2 = Math.min(innerWidth, Math.max(start[0], e.clientX)), y2 = Math.min(innerHeight, Math.max(start[1], e.clientY));
      return { x, y, w: x2 - x, h: y2 - y };
    }
    function box(el, x, y, w, h) {
      el.style.left = x + "px"; el.style.top = y + "px";
      el.style.width = Math.max(0, w) + "px"; el.style.height = Math.max(0, h) + "px";
    }
    function place(e) {
      const r = rect(e);
      sel.style.left = r.x + "px"; sel.style.top = r.y + "px"; sel.style.width = r.w + "px"; sel.style.height = r.h + "px";
      // The full-width strips get their left and width from CSS, so only the
      // edges that actually move are written.
      mask[0].style.height = r.y + "px";                                     // above
      mask[1].style.top = (r.y + r.h) + "px";                                // below
      mask[1].style.height = Math.max(0, innerHeight - r.y - r.h) + "px";
      box(mask[2], 0, r.y, r.x, r.h);                                        // left
      box(mask[3], r.x + r.w, r.y, innerWidth - r.x - r.w, r.h);             // right
      size.textContent = `${r.w} × ${r.h}`;
      size.style.left = r.x + "px";
      size.style.top = (r.y - 24 < 4 ? r.y + 4 : r.y - 24) + "px";
    }

    // The frozen frame. It covers the whole tab including the scrollbar, so it
    // is sized in vw/vh, not to the host box; the surplus hides under the bar.
    if (snapshot) {
      createImageBitmap(toBlob(snapshot)).then((bm) => {
        if (closed) { bm.close(); return; }
        canvas.width = bm.width; canvas.height = bm.height;
        canvas.getContext("2d").drawImage(bm, 0, 0);
        bm.close();
      }).catch(() => { /* no frozen frame; the live page shows through the dim */ });
    }
  }

  // ---- full page ----------------------------------------------------------

  // The document usually scrolls. Some app layouts scroll an inner element
  // instead; take the one under the middle of the viewport.
  function findScroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 1) return null;
    let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (n && n !== document.body && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
      n = n.parentElement;
    }
    return null;
  }

  // Fixed and pinned sticky elements would repeat in every strip. Collect the
  // candidates at the top of the page with where they sit...
  // getComputedStyle is the expensive part, so anything that cannot carry a
  // useful position is filtered out with plain property reads first. SVG
  // internals are skipped but the <svg> element itself is not.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "NOSCRIPT", "TEMPLATE",
    "BR", "OPTION", "OPTGROUP", "SOURCE", "TRACK", "PARAM", "COL", "COLGROUP", "HEAD"]);

  function pinnedCandidates(scroller) {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      if (el === document.documentElement || el === document.head || el === document.body) continue;
      if (SKIP.has(el.tagName)) continue;
      if (el.parentNode && el.parentNode.namespaceURI === SVG_NS) continue;
      if (scroller && (el === scroller || el.contains(scroller))) continue;
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") out.push([el, pos, el.getBoundingClientRect().top]);
    }
    return out;
  }

  // ...and after the first scroll hide the ones that did not move with the
  // content. In-flow sticky headers (tables, sections) travel and are kept.
  function hidePinned(candidates, hidden) {
    for (const [el, pos, top] of candidates) {
      if (pos === "sticky" && Math.abs(el.getBoundingClientRect().top - top) >= 1) continue;
      hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
      el.style.setProperty("visibility", "hidden", "important");
    }
  }

  async function fullPage(id) {
    const doc = document.scrollingElement || document.documentElement;
    const rootEl = document.documentElement;
    const el = findScroller();
    const scroller = el || doc;
    const viewH = rootEl.clientHeight;             // layout viewport, minus any horizontal scrollbar
    let clipTop = 0, clipH = viewH;
    if (el) {
      const box = el.getBoundingClientRect();
      clipTop = Math.max(0, Math.round(box.top + el.clientTop));
      clipH = Math.max(1, Math.min(Math.round(box.top + el.clientTop + el.clientHeight), viewH) - clipTop);
    }
    const saved = { x: scroller.scrollLeft, y: scroller.scrollTop };
    const styled = [], hidden = [];
    const force = (node, prop, value) => {
      styled.push([node, prop, node.style.getPropertyValue(prop), node.style.getPropertyPriority(prop)]);
      node.style.setProperty(prop, value, "important");
    };
    let capped = false, cancelled = false;
    // Esc stops the run. A listener only: anything added to the page would be
    // in the strips.
    const onKey = (e) => { if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); cancelled = true; } };
    const check = () => { if (cancelled) throw new Error("cancelled"); };
    window.addEventListener("keydown", onKey, true);
    try {
      // Smooth scrolling and scroll snapping would move the page under the shots.
      for (const n of el ? [rootEl, el] : [rootEl]) { force(n, "scroll-behavior", "auto"); force(n, "scroll-snap-type", "none"); }
      // Nudge lazy-loaded content: bottom, then back to top.
      scroller.scrollTop = scroller.scrollHeight; await sleep(250);
      scroller.scrollTop = 0;
      // Scan for pinned elements while the page settles rather than after it,
      // so on a heavy document the scan costs no extra wall time.
      const settle = sleep(250);
      await frames(1);
      const candidates = pinnedCandidates(el);
      await settle;
      check();
      const total = scroller.scrollHeight;
      let y = 0, prev = -1;
      for (let i = 0; ; i++) {
        scroller.scrollTop = y;
        await frames(2); await sleep(120);
        check();
        const actual = Math.round(scroller.scrollTop);
        if (actual <= prev) break;                 // cannot advance: nothing more to capture
        prev = actual;
        if (i === 1) { hidePinned(candidates, hidden); await frames(2); }
        const r = await send({ type: "shot", id, y: actual });
        if (!r.ok) {
          if (r.error === "cap") { capped = true; break; }
          throw new Error(gone(r) ? LOST : r.error);
        }
        if (actual + clipH >= total - 1) break;
        y = actual + clipH;
      }
      const meta = { vw: innerWidth, vh: viewH, clipTop, clipH, total, clientWidth: rootEl.clientWidth, inner: !!el, capped };
      const r = await send({ type: "open", id, mode: "full", meta });
      if (!r.ok) throw new Error(LOST);
    } catch (err) {
      send({ type: "cancel", id });
      if (!cancelled) toast(String((err && err.message) || err));
    } finally {
      window.removeEventListener("keydown", onKey, true);
      for (const [n, v, p] of hidden) n.style.setProperty("visibility", v, p);
      for (const [n, prop, v, p] of styled) n.style.setProperty(prop, v, p);
      scroller.scrollTop = saved.y; scroller.scrollLeft = saved.x;
    }
  }
})();
