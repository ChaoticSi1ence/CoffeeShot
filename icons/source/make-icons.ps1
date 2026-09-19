# make-icons.ps1 - regenerate every icon PNG from icons\source\icon.jpg and
# glyph.svg. Runs make-icons.html in headless Edge (no window) and writes what
# it produces: icons\icon*.png (toolbar glyph), icons\app\icon*.png (the
# tile), store\store-icon-128.png. Needs no node, no ImageMagick.
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$root = Resolve-Path (Join-Path $src '..\..')
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$dom = Join-Path $src 'work-dom.txt'
$url = 'file:///' + ((Join-Path $src 'make-icons.html') -replace '\\', '/')
$p = Start-Process -FilePath $edge -PassThru -Wait -RedirectStandardOutput $dom -RedirectStandardError (Join-Path $src 'work-err.txt') -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
  "--user-data-dir=$src\work-profile", '--virtual-time-budget=10000', '--timeout=30000', '--dump-dom', $url)
$m = [regex]::Match((Get-Content $dom -Raw), '<pre id="out">(.*?)</pre>', 'Singleline')
if (-not $m.Success) { throw 'make-icons: the page left no output' }
$out = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) | ConvertFrom-Json
if ($out.error) { throw "make-icons: $($out.error)" }
Write-Host $out.info
foreach ($prop in $out.PSObject.Properties) {
  if ($prop.Name -eq 'info') { continue }
  $dest = switch ($prop.Name) {
    'store-icon-128.png' { Join-Path $root 'store\store-icon-128.png' }
    'sticker.png'        { Join-Path $root 'store\source\sticker.png' }
    default              { Join-Path $root "icons\$($prop.Name)" }
  }
  $b64 = $prop.Value.Substring($prop.Value.IndexOf(',') + 1)
  [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($b64))
  Write-Host ("{0,-28} {1,7} bytes" -f $prop.Name, (Get-Item $dest).Length)
}
Remove-Item $dom, (Join-Path $src 'work-err.txt') -ErrorAction SilentlyContinue
