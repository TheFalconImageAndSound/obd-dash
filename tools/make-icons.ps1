# Builds every app icon from the falcon logo (icons/source/falcon-original.png, transparent background).
# Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class AlphaBounds {
  // Tight bounding box of pixels that aren't (nearly) transparent.
  public static Rectangle Find(Bitmap bmp) {
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var buf = new byte[data.Stride * bmp.Height];
    Marshal.Copy(data.Scan0, buf, 0, buf.Length);
    bmp.UnlockBits(data);
    int minX = bmp.Width, minY = bmp.Height, maxX = -1, maxY = -1;
    for (int y = 0; y < bmp.Height; y++)
      for (int x = 0; x < bmp.Width; x++)
        if (buf[y * data.Stride + x * 4 + 3] > 16) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    return Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
  }
}
'@

$root = Join-Path $PSScriptRoot '..'
$icons = Join-Path $root 'icons'
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $icons 'source\falcon-original.png'))
$box = [AlphaBounds]::Find($src)
Write-Output "Falcon bounds: $box"

$bgColor = [System.Drawing.ColorTranslator]::FromHtml('#0b1016')

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.CompositingQuality = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  return @($bmp, $g)
}

function Draw-Falcon($g, [int]$size, [double]$fraction) {
  # Fit the falcon's bounding box into `fraction` of the canvas, centered.
  $target = $size * $fraction
  $scale = [Math]::Min($target / $box.Width, $target / $box.Height)
  $w = $box.Width * $scale; $h = $box.Height * $scale
  $dest = New-Object System.Drawing.RectangleF ((($size - $w) / 2), (($size - $h) / 2), $w, $h)
  $g.DrawImage($src, $dest, (New-Object System.Drawing.RectangleF $box.X, $box.Y, $box.Width, $box.Height), [System.Drawing.GraphicsUnit]::Pixel)
}

function Fill-Background($g, [int]$size, [bool]$rounded) {
  $brush = New-Object System.Drawing.SolidBrush $bgColor
  if (-not $rounded) { $g.FillRectangle($brush, 0, 0, $size, $size); return }
  $d = [int]($size * 0.44)  # corner diameter (~22% radius, like the app icon grid)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc($size - $d, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d, $size - $d, $d, $d, 0, 90); $p.AddArc(0, $size - $d, $d, $d, 90, 90)
  $p.CloseFigure(); $g.FillPath($brush, $p)
}

function Save-Icon([string]$name, [int]$size, [string]$bg, [double]$fraction) {
  $bmp, $g = New-Canvas $size
  if ($bg -eq 'rounded') { Fill-Background $g $size $true }
  elseif ($bg -eq 'square') { Fill-Background $g $size $false }
  Draw-Falcon $g $size $fraction
  $g.Dispose()
  $bmp.Save((Join-Path $icons $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "  $name"
}

Write-Output 'Writing icons:'
Save-Icon 'icon-192.png'          192 'rounded' 0.70   # Android / install prompt
Save-Icon 'icon-512.png'          512 'rounded' 0.70
Save-Icon 'icon-maskable-512.png' 512 'square'  0.58   # Android adaptive icon (stays inside the safe zone)
Save-Icon 'apple-touch-icon.png'  180 'square'  0.68   # iOS rounds the corners itself
Save-Icon 'favicon-64.png'         64 'rounded' 0.80
Save-Icon 'falcon-mark.png'       512 'none'    1.00   # transparent mark used inside the app
$src.Dispose()
Write-Output 'Done.'
