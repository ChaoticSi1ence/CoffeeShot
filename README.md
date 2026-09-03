# CoffeeShot

Screenshot the visible tab, a dragged area, or the full page. Mark it up,
then copy it or save it as a PNG. A Brave extension made of plain files, with
no network access.

It is plain Manifest V3 with no Brave-specific APIs, so it should run in Chrome
and other Chromium browsers too. Brave is the only one it has been tested in.

## Use

Click the cup. The page freezes under a picker:

- **Drag** a rectangle. A small toolbar appears under its bottom-right corner:
  **Copy** puts the PNG on the clipboard, **Save** writes it to Downloads, and
  **Edit** opens it in a CoffeeShot tab for markup. Copy and Save finish on the
  page itself, with no tab in between. The keys are **C**, **S** and **E**, and
  **Esc** clears the selection so you can drag again.
- **F** captures the full page. The page scrolls itself, about two screens a
  second, and the cup counts the screens.
- **V** captures the visible tab.
- **S** saves the visible tab to Downloads right away.
- **Esc** cancels.

Edit, full page and visible tab open a CoffeeShot tab next to the page. Draw on
it with the pen (**P**), rectangle (**R**) or arrow (**A**) in four colours, or
pick any colour you like from the swatch at the end of the row. **Ctrl+Z**
undoes. **Copy** (Ctrl+C) puts the PNG on the clipboard and **Save** (Enter or
Ctrl+S) writes `coffeeshot-YYYY-MM-DD_HH-MM-SS.png` to Downloads. The tab
closes itself once you have copied or saved.

Right-click a page and you get one **CoffeeShot** entry, not a submenu, which
opens the same picker. Right-click the cup itself for the three captures
without the picker, plus **Save visible tab now**: straight to Downloads, no
tab, a green OK on the cup. That is what 1.0 did on every click.

(Chrome collapses two or more of an extension's items into a submenu and has
no way to opt out, so the page menu keeps a single entry on purpose.)

No keys are bound by default, because Brave uses Ctrl+Shift+S for its own
screenshot tool. There are two to bind at `brave://extensions/shortcuts`: one
opens the picker, the other saves the visible tab straight away. Alt+Shift+S
and Alt+Shift+D are free. To put CoffeeShot on Ctrl+Shift+S, first clear
Brave's "Sharing hub screenshot" binding at
`brave://settings/system/shortcuts`.

The overlay, the toolbars and the markup tab ease in rather than appearing
cold. With "reduce motion" turned on in Windows, none of that animation runs.

## Install

From a release:

1. Download `CoffeeShot-<version>.zip` from
   [Releases](https://github.com/ChaoticSi1ence/CoffeeShot/releases) and
   **Extract All** somewhere you will keep it (Brave loads it from there).
2. Open `brave://extensions`.
3. Turn on **Developer mode** (top right) and leave it on. Brave switches
   unpacked extensions off when that toggle goes off.
4. Click **Load unpacked** and pick the extracted folder (the one with
   `manifest.json` in it).
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to
   "CoffeeShot".

From a checkout: same steps, pick this folder in step 4.

There is no `.crx`. Brave, like Chrome, only installs packaged extensions
from the Chrome Web Store. A self-signed `.crx` dropped on
`brave://extensions` just gets downloaded again.

## Limits, stated plainly

- One capture at a time. Clicking the cup while a picker is waiting in another
  tab closes that picker and starts here; while a full-page capture is
  running you get a "..." badge instead.
- `brave://` pages, the Web Store and other extensions' pages do not allow
  the picker or full page, and the PDF viewer cannot be scrolled for you. On
  those you get the visible tab with a note saying so.
- `file://` pages need "Allow access to file URLs" for CoffeeShot on
  `brave://extensions`; otherwise Brave refuses the capture and the result tab
  tells you.
- Copy straight from the selection needs a secure page. On a plain `http://`
  site the browser gives no clipboard to the extension, so Copy opens the
  CoffeeShot tab and you press Copy there instead.
- Full page hides fixed and pinned sticky elements after the first screen so
  headers appear once, stops at 40 screens, and is scaled so no side exceeds
  16,384 px (a memory budget; Blink's own limit is 65,535). Pages that scroll
  inside a panel are captured from the panel under the middle of the window;
  nested scrollers and lazy-loading pages can come out incomplete.
- The result tab keeps its capture while it is open; reloading it rebuilds
  the image but not your drawings.
- Clicking the cup on a CoffeeShot tab flashes a red `!` and does nothing. It
  will not screenshot itself.
- If Brave is set to "Ask where to save each file before downloading", you
  get the save dialog.

## Permissions

- `activeTab` - the tab you invoked CoffeeShot on, only while you do.
- `scripting` - puts the picker and the scroll helper into that one tab.
- `contextMenus` - the right-click entries.
- `downloads` - saves the PNG to your Downloads folder.

No host permissions, no network, no analytics. Nothing leaves the browser.

## Files

- `manifest.json`
- `background.js` - service worker; the only thing that takes screenshots.
- `capture.js` - injected on demand: the picker and the full-page scroll loop.
- `result.html`, `result.css`, `result.js` - the result tab: stitch, draw,
  copy, save.
- `build.ps1` - makes the release zip in `dist/`.
- `icons/` - the white cup for the toolbar; `icons/app/` is the same cup on a
  coffee-brown tile for the extensions page and the store.
