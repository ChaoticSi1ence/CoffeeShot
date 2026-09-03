# CoffeeShot

A one-button Brave extension. Click the cup in the toolbar and it saves a PNG
of the visible part of the current tab into your Downloads folder, named like
`coffeeshot-2026-09-02_14-05-33.png`. A green **OK** flashes on the cup for a
second when the file is saved. A red **!** means it was not.

That's all it does. No popup, no settings, no network access.

## Install

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top right) and leave it on. Brave switches
   unpacked extensions off when that toggle goes off.
3. Click **Load unpacked** and pick this folder.
4. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to
   "CoffeeShot".

## Notes

- Brave already has its own screenshot tool on Ctrl+Shift+S (drag to pick an
  area, then download or copy). CoffeeShot is the no-questions version: the
  visible tab, straight to Downloads, nothing on the clipboard. It does not
  take that shortcut. If you want a key for CoffeeShot, set one at
  `brave://extensions/shortcuts`.
- It captures what is on screen in the tab, not the browser frame. Zoom and
  scroll position are what you see.
- It works on ordinary pages and on `brave://` pages too. A red **!** means
  the browser refused the capture or the download: a `file://` page (turn on
  "Allow access to file URLs" for the extension), a site blocked by policy,
  or a window that is not visible on screen. Details are in the service
  worker console on `brave://extensions`.
- If Brave is set to "Ask where to save each file before downloading", you
  get the save dialog. Turn that off in `brave://settings/downloads` if you
  want it silent.

## Files

- `manifest.json` - permissions are `activeTab` (the tab you clicked on,
  only while you click) and `downloads` (to save the file).
- `background.js` - the whole thing, about 50 lines.
- `icons/` - generated coffee cup icons.
