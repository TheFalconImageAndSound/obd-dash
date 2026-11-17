# Regenerates the PNG app icons (matches icons/icon.svg). Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [bool]$maskable, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap 512, 512
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0b1016'))
  if ($maskable) {
    $g.FillRectangle($bg, 0, 0, 512, 512)
    # Keep the artwork inside the maskable safe zone.
    $g.TranslateTransform(256, 256); $g.ScaleTransform(0.72, 0.72); $g.TranslateTransform(-256, -256)
  } else {
    $r = 112; $d = $r * 2
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc(512 - $d, 0, $d, $d, 270, 90)
    $p.AddArc(512 - $d, 512 - $d, $d, $d, 0, 90); $p.AddArc(0, 512 - $d, $d, $d, 90, 90)
    $p.CloseFigure(); $g.FillPath($bg, $p)
  }

  $round = [System.Drawing.Drawing2D.LineCap]::Round
  $track = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#232b36')), 44
  $track.StartCap = $round; $track.EndCap = $round
  $accent = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#39c6ff')), 44
  $accent.StartCap = $round; $accent.EndCap = $round
  $needle = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#e9eef4')), 22
  $needle.StartCap = $round; $needle.EndCap = $round
  $hub = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#e9eef4'))

  $g.DrawArc($track, 106, 140, 300, 300, 150, 240)
  $g.DrawArc($accent, 106, 140, 300, 300, 150, 150)
  $g.DrawLine($needle, 256, 290, 311, 194.7)
  $g.FillEllipse($hub, 230, 264, 52, 52)
  $g.Dispose()

  $out = New-Object System.Drawing.Bitmap $size, $size
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g2.DrawImage($bmp, 0, 0, $size, $size)
  $g2.Dispose()
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose(); $bmp.Dispose()
}

$dir = Join-Path $PSScriptRoot '..\icons'
New-Icon 192 $false (Join-Path $dir 'icon-192.png')
New-Icon 512 $false (Join-Path $dir 'icon-512.png')
New-Icon 512 $true (Join-Path $dir 'icon-maskable-512.png')
Write-Output 'Icons written.'
