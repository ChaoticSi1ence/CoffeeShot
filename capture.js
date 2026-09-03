// CoffeeShot page helper, injected on demand into the tab you clicked on.
// Shows the picker on a frozen snapshot of the tab and drives full-page
// capture. It only talks to background.js; it never touches the page's own
// scripts, and everything it adds is removed again when it is done.

(() => {
  if (window.__coffeeshot) return;
  const S = (window.__coffeeshot = { close: null });

  const LOST = "CoffeeShot lost the capture. Click the cup again.";
  const PICK_ACTION = { f: "full", v: "visible", s: "save-visible" };   // pill buttons and their keys
  const SEL_ACTION = { c: "copy", s: "save", e: "edit" };               // selection toolbar and its keys

  const send = (m) => chrome.runtime.sendMessage(m).catch(() => ({ ok: false, error: "lost" }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "alive") { reply({ ok: true }); return; }
    if (msg.type === "close") { if (S.close) S.close(); reply({ ok: true }); return; }
    if (msg.type !== "start") return;
    if (S.close) S.close();                      // a stale picker gives way
    if (isPdfViewer()) { reply({ ok: false, reason: "pdf" }); return; }
    if (msg.mode === "full") { reply({ ok: true }); fullPage(msg.id); return; }
    try {
      picker(msg);
      reply({ ok: true });
    } catch {
      reply({ ok: false, reason: "unsupported" });   // XML/SVG documents cannot host the picker
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
  function mount(css, html) {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${css}</style>${html}`;
    document.documentElement.appendChild(host);
    return { host, root };
  }

  const HOST = "all: initial !important; position: fixed !important; z-index: 2147483647 !important; outline: none !important;";

  function toast(text) {
    const { host, root } = mount(
      `:host { ${HOST} left: 0 !important; right: 0 !important; top: 16px !important; display: flex !important; justify-content: center !important; pointer-events: none !important; }
       div { background: #222; color: #fff; font: 14px system-ui, sans-serif; padding: 8px 14px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }`,
      `<div></div>`
    );
    root.querySelector("div").textContent = text;
    setTimeout(() => host.remove(), 4000);
  }

  function toBlob(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  }

  // ---- picker -------------------------------------------------------------

  const PICKER_CSS = `
    :host { ${HOST} inset: 0 !important; cursor: crosshair !important; user-select: none !important; }
    canvas { position: absolute; left: 0; top: 0; width: 100vw; height: 100vh; display: block; }
    .dim { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
    .sel { position: absolute; border: 1px solid #fff; box-shadow: 0 0 0 200vmax rgba(0,0,0,.45); }
    .size { position: absolute; background: #222; color: #fff; font: 12px system-ui, sans-serif; padding: 2px 6px; border-radius: 4px; }
    .pill, .bar { position: absolute; display: flex; gap: 8px; align-items: center; background: #222; color: #fff;
                  font: 14px system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.4); cursor: default; white-space: nowrap; }
    .pill { left: 50%; top: 16px; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px; }
    .bar { padding: 6px; border-radius: 8px; }
    .pill button, .bar button { all: initial; font: 14px system-ui, sans-serif; color: #fff; background: #444; cursor: pointer; }
    .pill button { padding: 4px 10px; border-radius: 999px; }
    .bar button { padding: 6px 12px; border-radius: 6px; }
    .pill button:hover, .bar button:hover { background: #666; }
    .bar button.primary { background: #1e88e5; }
    .bar button.primary:hover { background: #1976d2; }
    .pill span { opacity: .7; }
    [hidden] { display: none !important; }
  `;

  function picker({ id, mode, snapshot }) {
    const { host, root } = mount(PICKER_CSS,
      `<canvas></canvas><div class="dim"></div><div class="sel" hidden></div><div class="size" hidden></div>` +
      `<div class="bar" hidden><button data-a="copy" class="primary">Copy</button><button data-a="save">Save</button><button data-a="edit">Edit</button></div>` +
      `<div class="pill">Drag to capture an area` +
      (mode === "pick"
        ? `<button data-k="f">Full page (F)</button><button data-k="v">Visible (V)</button><button data-k="s">Save now (S)</button>`
        : ``) +
      `<span>Esc to cancel</span></div>`);
    const canvas = root.querySelector("canvas"), dim = root.querySelector(".dim");
    const sel = root.querySelector(".sel"), size = root.querySelector(".size");
    const pill = root.querySelector(".pill"), bar = root.querySelector(".bar");
    const prevFocus = document.activeElement;
    let start = null, selRect = null, closed = false, busy = false;

    // Keys go to the focused document, which may be an iframe; take focus so
    // the shortcuts reach us, and give it back afterwards.
    host.tabIndex = -1;
    host.focus({ preventScroll: true });

    const ping = setInterval(async () => {
      if (!(await send({ type: "ping", id })).ok) { close(); toast(LOST); }
    }, 20000);

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

    // ---- whole-tab choices from the pill ----
    const finish = async (action) => {
      close();
      if (action === "cancel") { send({ type: "cancel", id }); return; }
      if (action === "save-visible") {
        const r = await send({ type: "save-visible", id });
        toast(r.ok ? "Saved to Downloads." : (r.error === "expired" || r.error === "lost" ? LOST : `Save failed: ${r.error}`));
        return;
      }
      const r = await send({ type: action === "full" ? "full-start" : "visible", id });
      if (!r.ok) toast(LOST);
      else if (action === "full") fullPage(id);
    };

    // ---- selection choices from the toolbar ----
    // Copy and Save finish here. Only Edit opens the CoffeeShot tab.
    const act = (action) => {
      if (busy || !selRect) return;
      const meta = { rect: selRect, vw: innerWidth, vh: innerHeight };

      if (action === "edit") {
        busy = true;
        close();
        send({ type: "area", id, meta }).then((r) => { if (!r.ok) toast(LOST); });
        return;
      }

      if (action === "save") {
        busy = true;
        close();
        send({ type: "save-area", id, meta }).then((r) => {
          toast(r.ok ? "Saved to Downloads." : (r.error === "expired" || r.error === "lost" ? LOST : `Save failed: ${r.error}`));
        });
        return;
      }

      // Copy. navigator.clipboard exists only in a secure context, so plain
      // http:// pages hand the crop to the CoffeeShot tab instead.
      if (!window.isSecureContext || !navigator.clipboard || !window.ClipboardItem) {
        busy = true;
        close();
        send({ type: "area", id, meta }).then((r) => {
          toast(r.ok ? "This page cannot copy directly, so it opened in a CoffeeShot tab." : LOST);
        });
        return;
      }
      busy = true;
      // write() is called inside the click with the PNG still pending, so the
      // crop can take as long as it likes without losing the user gesture.
      const png = (async () => {
        const r = await send({ type: "crop", id, meta });
        if (!r.ok || !r.dataUrl) throw new Error(r.error || "expired");
        return toBlob(r.dataUrl);
      })();
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
        () => { close(); toast("Copied to clipboard."); send({ type: "cancel", id }); },
        () => {
          close();
          send({ type: "area", id, meta }).then((r) => {
            toast(r.ok ? "Brave blocked the copy, so it opened in a CoffeeShot tab." : LOST);
          });
        }
      );
    };

    const onKey = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.type !== "keydown" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") { if (selRect) reset(); else finish("cancel"); return; }
      const k = e.key.toLowerCase();
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
      dim.hidden = true; sel.hidden = false; size.hidden = false;
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
      dim.hidden = false; sel.hidden = true; size.hidden = true; bar.hidden = true;
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
    function place(e) {
      const r = rect(e);
      sel.style.left = r.x + "px"; sel.style.top = r.y + "px"; sel.style.width = r.w + "px"; sel.style.height = r.h + "px";
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
  function pinnedCandidates(scroller) {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      if (el === document.documentElement || el === document.head || el === document.body) continue;
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
    let capped = false;
    try {
      // Smooth scrolling and scroll snapping would move the page under the shots.
      for (const n of el ? [rootEl, el] : [rootEl]) { force(n, "scroll-behavior", "auto"); force(n, "scroll-snap-type", "none"); }
      // Nudge lazy-loaded content: bottom, then back to top.
      scroller.scrollTop = scroller.scrollHeight; await sleep(250);
      scroller.scrollTop = 0; await sleep(250);
      const total = scroller.scrollHeight;
      const candidates = pinnedCandidates(el);
      let y = 0, prev = -1;
      for (let i = 0; ; i++) {
        scroller.scrollTop = y;
        await frames(2); await sleep(120);
        const actual = Math.round(scroller.scrollTop);
        if (actual <= prev) break;                 // cannot advance: nothing more to capture
        prev = actual;
        if (i === 1) { hidePinned(candidates, hidden); await frames(2); }
        const r = await send({ type: "shot", id, y: actual });
        if (!r.ok) {
          if (r.error === "cap") { capped = true; break; }
          throw new Error(r.error === "expired" || r.error === "lost" ? LOST : r.error);
        }
        if (actual + clipH >= total - 1) break;
        y = actual + clipH;
      }
      const meta = { vw: innerWidth, vh: viewH, clipTop, clipH, total, clientWidth: rootEl.clientWidth, inner: !!el, capped };
      const r = await send({ type: "done", id, meta });
      if (!r.ok) throw new Error(LOST);
    } catch (err) {
      send({ type: "cancel", id });
      toast(String((err && err.message) || err));
    } finally {
      for (const [n, v, p] of hidden) n.style.setProperty("visibility", v, p);
      for (const [n, prop, v, p] of styled) n.style.setProperty(prop, v, p);
      scroller.scrollTop = saved.y; scroller.scrollLeft = saved.x;
    }
  }
})();
