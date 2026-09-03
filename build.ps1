# build.ps1 - package CoffeeShot for a release.
#
# Writes dist\CoffeeShot-<version>.zip (unzip, then Load unpacked) and, when
# Brave is installed, dist\CoffeeShot-<version>.crx packed with CoffeeShot.pem.
# The .pem is created next to this script on the first run. Keep it and keep it
# out of git (it is in .gitignore): it fixes the extension ID of the .crx, so a
# later version packed with the same key installs as an update.
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File build.ps1

param(
  [string]$Brave = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'CoffeeShot'

# Stage only what the browser needs.
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage 'icons\dark') | Out-Null
Copy-Item (Join-Path $root 'manifest.json'), (Join-Path $root 'background.js') $stage
Copy-Item (Join-Path $root 'icons\*.png') (Join-Path $stage 'icons')
Copy-Item (Join-Path $root 'icons\dark\*.png') (Join-Path $stage 'icons\dark')

# ZIP with manifest.json at the root, forward-slash entry names.
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

# CRX, packed by Brave itself. Skipped quietly when Brave is not installed.
if (Test-Path $Brave) {
  $pem = Join-Path $root 'CoffeeShot.pem'
  $packArgs = @("--pack-extension=$stage", "--no-message-box", "--user-data-dir=$dist\pack-profile")
  if (Test-Path $pem) { $packArgs += "--pack-extension-key=$pem" }
  $p = Start-Process -FilePath $Brave -ArgumentList $packArgs -Wait -PassThru
  $crxOut = Join-Path $dist 'CoffeeShot.crx'
  $pemOut = Join-Path $dist 'CoffeeShot.pem'
  if (Test-Path $crxOut) {
    $crx = Join-Path $dist "CoffeeShot-$version.crx"
    Move-Item -Force $crxOut $crx
    Write-Host "wrote $crx"
  } else {
    Write-Warning "Brave did not produce a .crx (exit $($p.ExitCode)); the zip is still good."
  }
  if (Test-Path $pemOut) {
    Move-Item -Force $pemOut $pem
    Write-Host "new key saved as $pem - keep it, do not commit it"
  }
} else {
  Write-Host "Brave not found at $Brave; skipping the .crx"
}
