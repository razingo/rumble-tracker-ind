# Creates web/favicon.ico from gamedata/art/kobold-miner.webp: the kobold on a solid rounded square inside a gold
# frame. It is the page's icon, and the build writes it into RumbleTracker.exe.
# Usage: powershell -ExecutionPolicy Bypass -File desktop\make-icon.ps1 [-Background '#1d2b6b'] [-Preview <png>]
# (needs gamedata/; .webp decoding needs Windows 11 or the WebP Image Extensions). -Preview only writes a 256 px PNG.
# PNG-encoded sizes: full portrait at 48-256 px, face crop at 16-32 px.
param([string]$Background = '#1d2b6b', [string]$Preview = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'gamedata\art\kobold-miner.webp'
$out = Join-Path $root 'web\favicon.ico'

$dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create([Uri]$src, 'PreservePixelFormat', 'OnLoad')
$pbgra = [System.Windows.Media.PixelFormats]::Pbgra32
$img = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap $dec.Frames[0], $pbgra, $null, 0
$full = New-Object System.Windows.Int32Rect 0, 0, $img.PixelWidth, $img.PixelHeight
$face = New-Object System.Windows.Int32Rect 20, 50, 200, 200   # in the 256 px portrait

$color = [System.Windows.Media.ColorConverter]::ConvertFromString($Background)
$brush = { param($c) New-Object System.Windows.Media.SolidColorBrush $c }
$rgb = { param($r, $g, $b) [System.Windows.Media.Color]::FromRgb($r, $g, $b) }

function Render([int]$size, [System.Windows.Int32Rect]$crop) {
  $dv = New-Object System.Windows.Media.DrawingVisual
  [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($dv, 'HighQuality')
  $dc = $dv.RenderOpen()
  $r = [Math]::Max(2, $size * 0.2)
  $frame = [Math]::Max(1, [Math]::Round($size / 18))       # gold frame width
  $box = New-Object System.Windows.Rect 0, 0, $size, $size
  $inner = New-Object System.Windows.Rect $frame, $frame, ($size - 2 * $frame), ($size - 2 * $frame)
  $ri = [Math]::Max(1, $r - $frame)
  # the frame is a dark outline and a gold band, lighter at the top, around the solid background
  $dc.DrawRoundedRectangle((& $brush (& $rgb 74 42 6)), $null, $box, $r, $r)
  $gold = New-Object System.Windows.Media.LinearGradientBrush (& $rgb 255 214 102), (& $rgb 196 128 24), 90
  $o = [Math]::Max(1, $size / 64)
  $dc.DrawRoundedRectangle($gold, $null, (New-Object System.Windows.Rect $o, $o, ($size - 2 * $o), ($size - 2 * $o)), ($r - $o), ($r - $o))
  $dc.DrawRoundedRectangle((& $brush $color), $null, $inner, $ri, $ri)
  # the kobold, clipped to the background and a little larger than it, so it fills the square
  $dc.PushClip((New-Object System.Windows.Media.RectangleGeometry $inner, $ri, $ri))
  $cropped = New-Object System.Windows.Media.Imaging.CroppedBitmap $img, $crop
  $pad = $size * 0.02
  $art = New-Object System.Windows.Rect ($inner.X - $pad), ($inner.Y - $pad), ($inner.Width + 2 * $pad), ($inner.Height + 2 * $pad)
  $dc.DrawImage($cropped, $art)
  $dc.Pop()
  # thin dark line between the frame and the picture
  $line = New-Object System.Windows.Media.Pen (& $brush (& $rgb 74 42 6)), ([Math]::Max(0.75, $size / 128))
  $dc.DrawRoundedRectangle($null, $line, $inner, $ri, $ri)
  $dc.Close()
  $bmp = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $size, $size, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
  $bmp.Render($dv)
  $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bmp))
  $ms = New-Object System.IO.MemoryStream
  $enc.Save($ms)
  return ,$ms.ToArray()
}

if ($Preview) { [System.IO.File]::WriteAllBytes($Preview, (Render 256 $full)); "Wrote $Preview"; return }

$sizes = 256, 128, 64, 48, 32, 24, 16
$pngs = foreach ($s in $sizes) { ,(Render $s $(if ($s -le 32) { $face } else { $full })) }

# ICONDIR, one ICONDIRENTRY per image, PNG data
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$d.Length); $w.Write([uint32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $w.Write($d) }
$w.Flush()
[System.IO.File]::WriteAllBytes($out, $ms.ToArray())
"Wrote $out ($($ms.Length) bytes, sizes $($sizes -join ', '))"
