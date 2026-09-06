$ErrorActionPreference = 'Continue'
$A = "C:\Users\brand\AppData\Local\Temp\claude\C--Users-brand-Projects\cefc8db9-3f01-4996-b241-74fc45525475\scratchpad\store-assets"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
Add-Type -AssemblyName System.Drawing

function Render($html, $png, $w, $h) {
  $profile = "$A\prof-$([IO.Path]::GetFileNameWithoutExtension($html))"
  $args = @("--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--allow-file-access-from-files",
            "--user-data-dir=$profile","--window-size=$w,$h","--hide-scrollbars","--force-device-scale-factor=1",
            "--virtual-time-budget=6000","--timeout=20000","--screenshot=$A\$png","file:///$($A.Replace('\','/'))/$html")
  $p = Start-Process -FilePath $edge -ArgumentList $args -PassThru
  $deadline = (Get-Date).AddSeconds(40)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  if (-not $p.HasExited) {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$profile*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
    return "$png : TIMED OUT"
  }
  if (-not (Test-Path "$A\$png")) { return "$png : not produced (exit $($p.ExitCode))" }
  # the store wants 24-bit PNG with no alpha; re-save to be certain
  $src = [System.Drawing.Image]::FromFile("$A\$png")
  $flat = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($flat); $g.DrawImage($src, 0, 0, $src.Width, $src.Height); $g.Dispose()
  $dims = "$($src.Width)x$($src.Height)"; $src.Dispose()
  $flat.Save("$A\$png", [System.Drawing.Imaging.ImageFormat]::Png); $flat.Dispose()
  return "$png : $dims 24bpp, $((Get-Item "$A\$png").Length) bytes"
}

# the full-page tab mock feeds slide 4, so it renders first
Render "tab-tall.html" "tab-tall.png" 1280 800
Render "s1.html" "screenshot-1.png" 1280 800
Render "s2.html" "screenshot-2.png" 1280 800
Render "s3.html" "screenshot-3.png" 1280 800
Render "s4.html" "screenshot-4.png" 1280 800
Render "s5.html" "screenshot-5.png" 1280 800
Render "tile-small.html" "promo-small-440x280.png" 440 280
Render "tile-marquee.html" "promo-marquee-1400x560.png" 1400 560
