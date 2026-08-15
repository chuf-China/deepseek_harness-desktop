# 生成占位图标（托盘 32x32 + 应用图标 256x256）。在项目目录运行：powershell -File generate-icons.ps1
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot 'assets'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
function New-IconPng($path, $size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 77, 107, 254))
  $g.FillEllipse($brush, 0, 0, $size, $size)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $r = [int]($size * 0.22)
  $g.FillEllipse($white, ($size/2 - $r), ($size/2 - $r), ($r*2), ($r*2))
  $brush.Dispose(); $white.Dispose(); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
New-IconPng "$dir\tray.png" 32
New-IconPng "$dir\icon.png" 256
Write-Host "图标已生成到 $dir"
