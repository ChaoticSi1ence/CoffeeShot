// CoffeeShot - clicking the toolbar cup captures the visible part of the
// current tab and saves it as a PNG in the Downloads folder.
// No options, no popup, no network access.

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

// Short badge on the toolbar icon so you know it worked (or didn't).
async function flashBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    // The tab may be gone by the time this fires; that is fine.
    setTimeout(
      () => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}),
      1500
    );
  } catch {
    // Tab may have closed; nothing to show.
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    await chrome.downloads.download({
      url: dataUrl,
      filename: `coffeeshot-${timestamp()}.png`,
      saveAs: false,
      conflictAction: "uniquify",
    });
    flashBadge(tab.id, "OK", "#2e7d32");
  } catch (err) {
    // The browser refused the capture or the download. Usual causes: a
    // file:// page without "Allow access to file URLs", a site blocked by
    // policy, or a window that is not visible on screen.
    console.error("CoffeeShot failed:", err);
    flashBadge(tab.id, "!", "#c62828");
  }
});
