# render.ps1 - rebuild every store image from the sources in this folder.
#
# Nothing here touches a real browser profile: headless Edge renders two web
# pages into work\ (a Wikipedia article for the picker shots, an MDN page for
# the full-page one), then local HTML that layers the extension's own picker
# CSS and result.css over them, then the captioned slides and tiles. Outputs:
# store\screenshot-1..5.png (1280x800), promo-small-440x280.png,
# promo-marquee-1400x560.png, all 24-bit PNG as the store asks. The icon
# itself comes from icons\source\make-icons.ps1, which also writes sticker.png.
#
#   powershell -ExecutionPolicy Bypass -File store\source\render.ps1 [-Refresh]
#
# -Refresh fetches the two web pages again; without it, cached renders in
# work\ are reused so the slides can be tweaked offline.
param([switch]$Refresh)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = $PSScriptRoot
$root = (Resolve-Path (Join-Path $src '..\..')).Path
$store = Join-Path $root 'store'
$work = Join-Path $src 'work'
New-Item -ItemType Directory -Force $work | Out-Null
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { throw "render: Edge not found at $edge" }

function Render($target, $png, $w, $h, $scale = 1, $budget = 6000) {
  $tag = [IO.Path]::GetFileNameWithoutExtension($png)
  $profile = Join-Path $work "profile-$tag"
  $url = if ($target -match '^https?://') { $target } else { 'file:///' + ($target -replace '\\', '/') }
  $args = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files',
            "--user-data-dir=$profile", "--window-size=$w,$h", '--hide-scrollbars', "--force-device-scale-factor=$scale",
            "--virtual-time-budget=$budget", '--timeout=30000', "--screenshot=$png", $url)
  $p = Start-Process -FilePath $edge -ArgumentList $args -PassThru
  $deadline = (Get-Date).AddSeconds(75)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  if (-not $p.HasExited) {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*profile-$tag*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
    throw "render: $tag timed out"
  }
  if (-not (Test-Path $png)) { throw "render: $tag produced nothing (exit $($p.ExitCode))" }
  Write-Host ("{0,-28} {1}" -f (Split-Path $png -Leaf), (Get-Item $png).Length)
}

# The store wants 24-bit PNG with no alpha channel; the screenshots carry one.
function Flatten($png) {
  $img = [System.Drawing.Image]::FromFile($png)
  $flat = New-Object System.Drawing.Bitmap $img.Width, $img.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($flat); $g.DrawImage($img, 0, 0, $img.Width, $img.Height); $g.Dispose()
  $img.Dispose()
  $flat.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $flat.Dispose()
}

# 1. The picker's stylesheet, lifted from capture.js so the mock uses the real
#    rules. In the extension the :host rule is composed in mount(); here it is
#    a plain class on a div.
$js = Get-Content (Join-Path $root 'capture.js') -Raw
$m = [regex]::Match($js, 'const HOST = "([^"]*)";'); $HOSTCSS = $m.Groups[1].Value
$m = [regex]::Match($js, 'const PANEL = "([^"]*)";'); $PANEL = $m.Groups[1].Value
$m = [regex]::Match($js, 'const CSS = `(.*?)`;', 'Singleline'); $css = $m.Groups[1].Value
if (-not $HOSTCSS -or -not $PANEL -or -not $css) { throw 'render: could not find HOST, PANEL and CSS in capture.js' }
$css = $css.Replace('${PANEL}', $PANEL).Replace(':host', '.host')
$css = ".host { $HOSTCSS inset: 0 !important; cursor: crosshair !important; user-select: none !important; }`n" + $css
[IO.File]::WriteAllText((Join-Path $work 'picker.css'), $css, (New-Object Text.UTF8Encoding $false))

# 2. Two real pages. Cached unless -Refresh.
$page = Join-Path $work 'page.png'; $page2x = Join-Path $work 'page2x.png'; $tall = Join-Path $work 'page-tall.png'
if ($Refresh -or -not (Test-Path $page))   { Render 'https://en.wikipedia.org/wiki/Coffee' $page 1280 800 1 8000 }
if ($Refresh -or -not (Test-Path $page2x)) { Render 'https://en.wikipedia.org/wiki/Coffee' $page2x 1280 800 2 8000 }
if ($Refresh -or -not (Test-Path $tall))   { Render 'https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API' $tall 1280 3400 1 10000 }

# 3. The extension's surfaces over them. The 2x picker mock is the 1x one
#    pointed at the 2x page; it lives in work\ so its paths lose the prefix.
$mock2x = Join-Path $work 'mock-picker-2x.html'
(Get-Content (Join-Path $src 'mock-picker.html') -Raw).Replace('work/page.png', 'page2x.png').Replace('work/picker.css', 'picker.css') |
  Set-Content $mock2x -Encoding UTF8
Render (Join-Path $src 'mock-picker.html') (Join-Path $work 'shot-picker.png') 1280 800
Render $mock2x (Join-Path $work 'shot-picker-2x.png') 1280 800 2
Render (Join-Path $src 'mock-result.html') (Join-Path $work 'shot-markup.png') 1280 800
Render (Join-Path $src 'tab-tall.html') (Join-Path $work 'tab-tall.png') 1280 800

# 4. The listing.
foreach ($n in 1..5) { $out = Join-Path $store "screenshot-$n.png"; Render (Join-Path $src "s$n.html") $out 1280 800; Flatten $out }
$out = Join-Path $store 'promo-small-440x280.png';   Render (Join-Path $src 'tile-small.html') $out 440 280;   Flatten $out
$out = Join-Path $store 'promo-marquee-1400x560.png'; Render (Join-Path $src 'tile-marquee.html') $out 1400 560; Flatten $out
