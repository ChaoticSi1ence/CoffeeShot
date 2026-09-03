// CoffeeShot service worker. The only place that calls captureVisibleTab.
//
// Entry points: the toolbar cup (or its shortcut) opens the in-page picker,
// the right-click menu picks a mode directly, and "Save visible tab now" is
// the one-gesture save from 1.0. Captured strips wait here until the result
// tab has pulled them; a job lives as long as its result tab does.

const STEP_MS = 550;        // Chromium allows 2 captureVisibleTab calls per second
const MAX_STRIPS = 40;      // full-page cap; the 16,384 px side cap lives in result.js
const IDLE_MS = 90 * 1000;  // a picker that stops pinging for this long is gone

const jobs = new Map();     // id -> job
let busyTab = null;         // one capture at a time; the capture quota is per extension
let lastShot = 0;
let nextId = 1;

const MENU = [
  ["area", "Capture area"],
  ["full", "Capture full page"],
  ["visible", "Capture visible tab"],
  ["save-visible", "Save visible tab now"],
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of MENU) {
      chrome.contextMenus.create({ id, title, contexts: ["all"] });
    }
  });
});

chrome.action.onClicked.addListener((tab) => start(tab, "pick"));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "save-visible") quickSave(tab);
  else start(tab, String(info.menuItemId));
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "save-visible") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) quickSave(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const job of jobs.values()) {
    if (job.resultTabId === tabId) jobs.delete(job.id);
    else if (job.tabId === tabId && !job.opened) drop(job);
  }
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  const job = pending(removedTabId);
  if (job) drop(job);
});

// "loading" also fires for same-document navigations (pushState, hashes).
// Only a page that no longer answers has really lost its script.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "loading") return;
  const job = pending(tabId);
  if (!job) return;
  const alive = await chrome.tabs.sendMessage(tabId, { type: "alive" }).catch(() => null);
  if (!alive && jobs.has(job.id) && !job.opened) drop(job);
});

function pending(tabId) {
  for (const job of jobs.values()) {
    if (job.tabId === tabId && !job.opened) return job;
  }
  return null;
}

function newJob(tab, mode) {
  const job = {
    id: `${Date.now().toString(36)}-${(nextId++).toString(36)}`,
    tabId: tab.id, windowId: tab.windowId, index: tab.index,
    mode, strips: [], ys: [], meta: null, note: "",
    opened: false, timer: null, resultTabId: null,
  };
  jobs.set(job.id, job);
  return job;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function timestamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function badge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function flash(tabId, text, color) {
  badge(tabId, text, color);
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 1500);
}

// One capture, paced to the quota, with a single retry if the quota bites anyway.
async function shot(windowId) {
  const wait = lastShot + STEP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    lastShot = Date.now();
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    if (!/quota/i.test(String(err && err.message))) throw err;
    await sleep(1000);
    lastShot = Date.now();
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  }
}

// The page script pings while its picker is open and reports every strip;
// silence for IDLE_MS means it is gone.
function touch(job) {
  clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    if (!jobs.has(job.id) || job.opened) return;
    chrome.tabs.sendMessage(job.tabId, { type: "close", id: job.id }).catch(() => {});
    drop(job);
  }, IDLE_MS);
}

function drop(job) {
  clearTimeout(job.timer);
  jobs.delete(job.id);
  if (busyTab === job.tabId) busyTab = null;
  chrome.action.setBadgeText({ tabId: job.tabId, text: "" }).catch(() => {});
}

// One capture at a time. An idle picker in another tab gives way; a running
// full-page capture does not.
function preempt(tab) {
  if (busyTab === null) return true;
  const job = pending(busyTab);
  if (!job) { busyTab = null; return true; }
  if (job.mode === "full") { flash(tab.id, "...", "#455a64"); return false; }
  chrome.tabs.sendMessage(job.tabId, { type: "close", id: job.id }).catch(() => {});
  drop(job);
  return true;
}

function refusal(tab, err) {
  if (/^file:/i.test(tab.url || "")) {
    return "Brave refused the capture. Local files need \"Allow access to file URLs\" for CoffeeShot, on brave://extensions.";
  }
  return `Brave refused the capture: ${(err && err.message) || err}`;
}

// The capture is complete (or failed with something to say): hand it to a
// result tab next to the source tab.
async function open(job) {
  job.opened = true;
  clearTimeout(job.timer);
  if (busyTab === job.tabId) busyTab = null;
  chrome.action.setBadgeText({ tabId: job.tabId, text: "" }).catch(() => {});
  const url = chrome.runtime.getURL(`result.html#${job.id}`);
  let t = null;
  try {
    t = await chrome.tabs.create({ url, windowId: job.windowId, index: job.index + 1, openerTabId: job.tabId });
  } catch {
    t = await chrome.tabs.create({ url }).catch(() => null);
  }
  if (t) job.resultTabId = t.id;
}

// mode: "pick" (toolbar click), or "area" / "full" / "visible" (context menu)
async function start(tab, mode) {
  if ((tab.url || "").startsWith(chrome.runtime.getURL(""))) return flash(tab.id, "!", "#c62828");
  if (!preempt(tab)) return;
  busyTab = tab.id;
  const job = newJob(tab, mode);
  try {
    // Snapshot first, so the picker shows a frozen frame and never appears in the shot.
    if (mode !== "full") job.strips.push(await shot(tab.windowId));
    if (mode === "visible") return open(job);
    let r = null;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture.js"] });
      r = await chrome.tabs.sendMessage(tab.id, { type: "start", id: job.id, mode, snapshot: job.strips[0] || null });
    } catch {
      r = null;
    }
    if (!r || !r.ok) {
      // brave://, the Web Store, other extensions' pages and non-HTML documents
      // refuse the page script; the PDF viewer takes it but cannot scroll for
      // us. The visible tab still works everywhere activeTab reaches.
      if (!job.strips.length) job.strips.push(await shot(tab.windowId));
      job.mode = "visible";
      job.note = r && r.reason === "pdf"
        ? "Brave's PDF viewer only allows the visible page, so here it is."
        : "This page does not allow the area picker or full-page capture, so this is the visible tab.";
      return open(job);
    }
    touch(job);   // the page script drives from here
  } catch (err) {
    console.error("CoffeeShot failed:", err);
    job.mode = "error";
    job.note = refusal(tab, err);
    job.strips = [];
    open(job);
  }
}

// 1.0's path: visible tab straight to Downloads, no result tab.
async function quickSave(tab) {
  if (!preempt(tab)) return;
  try {
    const dataUrl = await shot(tab.windowId);
    await chrome.downloads.download({
      url: dataUrl,
      filename: `coffeeshot-${timestamp()}.png`,
      saveAs: false,
      conflictAction: "uniquify",
    });
    flash(tab.id, "OK", "#2e7d32");
  } catch (err) {
    console.error("CoffeeShot failed:", err);
    const job = newJob(tab, "error");
    job.note = refusal(tab, err);
    open(job);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg).then(reply, (err) => reply({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function handle(msg) {
  const job = jobs.get(msg.id);
  if (!job) return { ok: false, error: "expired" };
  switch (msg.type) {
    // from capture.js, and the result tab's keep-alive
    case "ping":
      if (!job.opened) touch(job);
      return { ok: true };
    case "cancel":
      drop(job);
      return { ok: true };
    case "visible":
      job.mode = "visible";
      open(job);
      return { ok: true };
    case "area":
      job.mode = "area";
      job.meta = msg.meta;
      open(job);
      return { ok: true };
    case "full-start":
      job.mode = "full";
      job.strips = [];
      job.ys = [];
      touch(job);
      return { ok: true };
    case "shot": {
      if (job.strips.length >= MAX_STRIPS) return { ok: false, error: "cap" };
      const t = await chrome.tabs.get(job.tabId);
      if (!t.active || t.windowId !== job.windowId) throw new Error("The tab is no longer in front.");
      job.strips.push(await shot(job.windowId));
      job.ys.push(msg.y);
      touch(job);
      badge(job.tabId, String(job.strips.length), "#455a64");
      return { ok: true, count: job.strips.length };
    }
    case "done":
      job.meta = msg.meta;
      open(job);
      return { ok: true };
    // from result.js
    case "job":
      return { ok: true, mode: job.mode, meta: job.meta, note: job.note, count: job.strips.length, ys: job.ys };
    case "strip":
      return { ok: true, dataUrl: job.strips[msg.index] || null };
    default:
      return { ok: false, error: "unknown message" };
  }
}
