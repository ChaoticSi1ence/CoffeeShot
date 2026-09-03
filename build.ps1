# build.ps1 - package CoffeeShot for a release.
#
# Writes dist\CoffeeShot-<version>.zip with manifest.json at the root of the
# archive. Unzip it and use "Load unpacked" on brave://extensions, or upload
# it as-is to the Chrome Web Store.
#
# There is no .crx. Brave, like Chrome, only installs packaged extensions from
# the Chrome Web Store; a self-signed .crx dropped on brave://extensions is
# just downloaded again. Unpacked is the only route outside the store.
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'CoffeeShot'

# Everything the browser needs, and nothing else. Fail loudly if a file is gone.
$files = 'manifest.json', 'background.js', 'capture.js', 'result.html', 'result.css', 'result.js'
foreach ($f in $files) {
  if (-not (Test-Path (Join-Path $root $f))) { throw "build: $f is missing" }
}
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage 'icons\app') | Out-Null
Copy-Item ($files | ForEach-Object { Join-Path $root $_ }) $stage
Copy-Item (Join-Path $root 'icons\*.png') (Join-Path $stage 'icons')
Copy-Item (Join-Path $root 'icons\app\*.png') (Join-Path $stage 'icons\app')

# ZIP with forward-slash entry names so it unpacks cleanly everywhere.
$zip = Join-Path $dist "CoffeeShot-$version.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$za = New-Object System.IO.Compression.ZipArchive $fs, ([System.IO.Compression.ZipArchiveMode]::Create)
foreach ($file in Get-ChildItem $stage -Recurse -File) {
  $entry = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $file.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
$za.Dispose(); $fs.Dispose()
Write-Host "wrote $zip"
