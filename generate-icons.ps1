# 从 assets/icon.svg（DeepSeek 鲸鱼 logo，蓝色 #4D6BFE，透明背景）渲染应用/托盘/桌面图标。
# 用法（在项目目录运行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File generate-icons.ps1
# 输出：
#   assets/icon.png   512x512  electron-builder 的 win.icon（exe 图标 + 桌面快捷方式默认图标）
#   assets/tray.png   32x32    系统托盘图标（main.js 直接加载）
#   assets/icon.ico   多尺寸    独立 Windows 图标（可手动指定给桌面快捷方式）

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$dir   = Join-Path $PSScriptRoot 'assets'
$svgPath = Join-Path $dir 'icon.svg'

if (-not (Test-Path $svgPath)) {
  throw "缺少 $svgPath，无法渲染图标。"
}

$svg = Get-Content -Raw $svgPath
$m = [regex]::Match($svg, '<path\b[^>]*\bd="([^"]+)"')
if (-not $m.Success) { throw 'icon.svg 中未找到 <path> 的 d 属性。' }
$d = $m.Groups[1].Value

# ---- 解析 SVG 路径（本 logo 仅使用绝对命令 M / C / Z） ----
$tokens = [regex]::Matches($d, '[MZC]|-?\d*\.?\d+(?:[eE][+-]?\d+)?') |
  ForEach-Object { $_.Value }

$figures = New-Object System.Collections.ArrayList
$cur = $null
$i = 0
while ($i -lt $tokens.Count) {
  $t = $tokens[$i]
  if ($t -eq 'M') {
    $x = [double]$tokens[$i+1]; $y = [double]$tokens[$i+2]
    $cur = @{ Start = @($x, $y); Segments = New-Object System.Collections.ArrayList }
    [void]$figures.Add($cur)
    $i += 3
  }
  elseif ($t -eq 'C') {
    $seg = @(
      [double]$tokens[$i+1], [double]$tokens[$i+2],
      [double]$tokens[$i+3], [double]$tokens[$i+4],
      [double]$tokens[$i+5], [double]$tokens[$i+6]
    )
    [void]$cur.Segments.Add($seg)
    $i += 7
  }
  elseif ($t -eq 'Z') {
    $i += 1
  }
  else {
    throw "无法解析的路径 token：$t"
  }
}
Write-Host "解析到 $($figures.Count) 个闭合子路径。"

# ---- 计算包围盒（含控制点，保证不裁切） ----
$minX = [double]::MaxValue; $minY = [double]::MaxValue
$maxX = [double]::MinValue; $maxY = [double]::MinValue
foreach ($fig in $figures) {
  $minX = [Math]::Min($minX, $fig.Start[0]); $maxX = [Math]::Max($maxX, $fig.Start[0])
  $minY = [Math]::Min($minY, $fig.Start[1]); $maxY = [Math]::Max($maxY, $fig.Start[1])
  foreach ($seg in $fig.Segments) {
    foreach ($k in 0,2,4) {
      $minX = [Math]::Min($minX, $seg[$k]);   $maxX = [Math]::Max($maxX, $seg[$k])
      $minY = [Math]::Min($minY, $seg[$k+1]); $maxY = [Math]::Max($maxY, $seg[$k+1])
    }
  }
}
$boxW = $maxX - $minX
$boxH = $maxY - $minY

# 渲染鲸鱼到位图（蓝色填充、透明背景、抗锯齿）
function New-WhaleBitmap([int]$size, [double]$padding) {
  $scale = [Math]::Min(($size * (1 - 2 * $padding)) / $boxW, ($size * (1 - 2 * $padding)) / $boxH)
  $offX = ($size - $boxW * $scale) / 2 - $minX * $scale
  $offY = ($size - $boxH * $scale) / 2 - $minY * $scale

  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  foreach ($fig in $figures) {
    $cx = $fig.Start[0] * $scale + $offX
    $cy = $fig.Start[1] * $scale + $offY
    $gp.StartFigure()
    foreach ($seg in $fig.Segments) {
      $x1 = $seg[0] * $scale + $offX; $y1 = $seg[1] * $scale + $offY
      $x2 = $seg[2] * $scale + $offX; $y2 = $seg[3] * $scale + $offY
      $xe = $seg[4] * $scale + $offX; $ye = $seg[5] * $scale + $offY
      $gp.AddBezier($cx, $cy, $x1, $y1, $x2, $y2, $xe, $ye)
      $cx = $xe; $cy = $ye
    }
    $gp.CloseFigure()
  }

  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 77, 107, 254))
  $g.FillPath($brush, $gp)

  $brush.Dispose(); $gp.Dispose(); $g.Dispose()
  return $bmp
}

# 将若干位图打包为多尺寸 .ico（PNG 压缩条目，Vista+ 通用）
function New-IcoFromBitmaps([string]$outPath, [System.Drawing.Bitmap[]]$bitmaps) {
  $pngBytes = @()
  foreach ($bmp in $bitmaps) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes += ,@($bmp.Width, $ms.ToArray())
    $ms.Dispose()
  }

  $count = $pngBytes.Count
  $dataOffset = 6 + 16 * $count
  $fs = [System.IO.File]::Create($outPath)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0)   # reserved
  $bw.Write([UInt16]1)   # type = icon
  $bw.Write([UInt16]$count)

  $offset = $dataOffset
  foreach ($p in $pngBytes) {
    $s = $p[0]
    $dim = if ($s -ge 256) { [byte]0 } else { [byte]$s }   # 0 = 256
    $bw.Write([byte]$dim)   # width
    $bw.Write([byte]$dim)   # height
    $bw.Write([byte]0)      # palette colors
    $bw.Write([byte]0)      # reserved
    $bw.Write([UInt16]1)    # color planes
    $bw.Write([UInt16]32)   # bits per pixel
    $bw.Write([UInt32]$p[1].Length)
    $bw.Write([UInt32]$offset)
    $offset += $p[1].Length
  }
  foreach ($p in $pngBytes) { $bw.Write([byte[]]$p[1]) }
  $bw.Close()
  $fs.Close()
}

# ---- 输出 ----
$iconPng = New-WhaleBitmap 512 0.08
$iconPng.Save((Join-Path $dir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$iconPng.Dispose()

$trayPng = New-WhaleBitmap 32 0.10
$trayPng.Save((Join-Path $dir 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$trayPng.Dispose()

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$icoBmps = @()
foreach ($s in $sizes) { $icoBmps += New-WhaleBitmap $s 0.08 }
New-IcoFromBitmaps (Join-Path $dir 'icon.ico') $icoBmps
foreach ($b in $icoBmps) { $b.Dispose() }

Write-Host "图标已生成到 $dir ：icon.png(512) / tray.png(32) / icon.ico($($sizes -join ','))"
