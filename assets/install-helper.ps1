# DeepSeek Harness 安装助手（由 main.js 的 installAndQuit 调用）。
#
# 铁律 #8：不能直接 spawn detached:true 的 powershell（Windows 下启动即死）；必须
# 由 main.js 把本文件写入 %TEMP%\dsh-install.ps1（加 UTF-8 BOM，中文在 PowerShell
# 5.1 下不乱码），再写 %TEMP%\dsh-install.cmd（CRLF，内部 `start "" /min
# powershell.exe -File ...`），用 spawn('cmd.exe', ['/c', cmdPath]) 启动——cmd 的
# start 让 powershell 完全脱离应用进程，应用退出后它继续跑完清理与安装。
#
# 参数一律走环境变量（避免命令行引号转义）：
#   DSH_INSTALLER  新版本安装包路径（NSIS 安装器）
#   DSH_DIR        已安装应用的目录（要清理的目标）
#   DSH_NEWEXE     安装完成后的 exe 路径（成败判定 + 重启）
#   DSH_LOG        安装日志路径（默认 %TEMP%\dsh-install.log）
#
# 流程固定（铁律 #9）：杀进程 → 清注册表 → 删目录 → 静默装新版 → 按安装器退出码
# 判定成败（Start-Process -PassThru + 轮询 HasExited）→ 重启新版本。
# 注册表清理必须在删目录之前：注册表清了安装器就当全新安装，即使删目录失败也
# 不会触发旧卸载器（exit 2 / "无法关闭"）。

$ErrorActionPreference = 'Continue'

$installer = $env:DSH_INSTALLER
$dir       = $env:DSH_DIR
$newExe    = $env:DSH_NEWEXE
$LOG       = if ($env:DSH_LOG) { $env:DSH_LOG } else { Join-Path $env:TEMP 'dsh-install.log' }

function Write-Log([string]$msg) {
  try { $msg | Out-File $LOG -Append -Encoding utf8 } catch { }
}

"=== install-helper $(Get-Date -Format s) installer='$installer' dir='$dir' ===" | Out-File $LOG -Encoding utf8

# ---- UI 初始化（失败不影响安装，仅无窗口） ----
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
$script:ui = $null
try {
  $script:ui = New-Object System.Windows.Forms.Form
  $script:ui.Text = 'DeepSeek Harness 更新安装'
  $script:ui.Width = 500
  $script:ui.Height = 180
  $script:ui.StartPosition = 'CenterScreen'
  $script:ui.TopMost = $true
  $script:ui.FormBorderStyle = 'FixedDialog'
  $script:ui.MaximizeBox = $false
  $script:ui.MinimizeBox = $false
  $script:lbl = New-Object System.Windows.Forms.Label
  $script:lbl.Location = New-Object System.Drawing.Point(18, 16)
  $script:lbl.Size = New-Object System.Drawing.Size(460, 26)
  $script:lbl.Text = '正在准备安装...'
  $script:bar = New-Object System.Windows.Forms.ProgressBar
  $script:bar.Location = New-Object System.Drawing.Point(18, 56)
  $script:bar.Size = New-Object System.Drawing.Size(460, 24)
  $script:bar.Minimum = 0
  $script:bar.Maximum = 100
  $script:ui.Controls.Add($script:lbl)
  $script:ui.Controls.Add($script:bar)
  $script:ui.Show()
  $script:ui.Refresh()
} catch { $script:ui = $null }

function Set-UI([string]$msg, [int]$pct) {
  if ($script:ui) {
    try { $script:lbl.Text = $msg; $script:bar.Value = $pct; $script:ui.Refresh() } catch { }
  }
}

try {
  # ---- 步骤 1：等应用退出后杀安装目录进程（路径级，等真正消失） ----
  Set-UI '正在关闭旧版本进程...' 10
  Start-Sleep -Seconds 6
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($dir + '*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # 轮询等待安装目录进程全部消失（最多 30 秒），避免句柄未释放导致删目录/覆盖失败
  for ($w = 0; $w -lt 30; $w++) {
    $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($dir + '*') })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  Write-Log ("after kill: left=" + @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($dir + '*') }).Count)

  # ---- 步骤 2：先清注册表（关键！放删目录之前——注册表清了安装器就当全新安装） ----
  Set-UI '正在清理旧版本注册表...' 30
  Start-Sleep -Seconds 3
  @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  ) | ForEach-Object {
    Get-ChildItem $_ -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $p = Get-ItemProperty $_.PSPath -ErrorAction Stop
        # 精确匹配本产品（DisplayName 或 UninstallString 指向安装目录），绝不宽匹配
        # '*DeepSeek*'——那会误删同机其它 DeepSeek 产品的卸载项（如官方桌面应用），
        # 造成它们无法卸载/更新（孤儿安装）。
        $isOurs = ($p.DisplayName -eq 'DeepSeek Harness') -or
                  ($p.UninstallString -and ($p.UninstallString -like ('*' + $dir + '*')))
        if ($isOurs) {
          Remove-Item $_.PSPath -Recurse -Force
          Write-Log ('removed-reg: ' + $_.PSPath + ' DisplayName=' + $p.DisplayName)
        }
      } catch { }
    }
  }

  # ---- 步骤 3：删目录（尽力而为，失败不中止——覆盖安装兜底） ----
  Set-UI '正在清理旧版本文件...' 45
  # 第一轮：10 次 Remove-Item（每次失败等 2 秒）
  for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-Path $dir)) { break }
    try { Remove-Item $dir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 2 }
  }
  # 第二轮：仍失败则等 5 秒（句柄延迟释放）再重试 5 次
  if (Test-Path $dir) {
    Write-Log 'del-dir-failed (pass1), waiting 5s then retry'
    Start-Sleep -Seconds 5
    for ($i = 0; $i -lt 5; $i++) {
      if (-not (Test-Path $dir)) { break }
      try { Remove-Item $dir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 2 }
    }
  }
  # 第三轮：rd /s /q 兜底；并记录仍占用的进程（诊断用，不中止）
  if (Test-Path $dir) {
    Write-Log 'del-dir-failed (pass2), trying rd'
    cmd /c rd /s /q "$dir" 2>$null
  }
  Write-Log ("after del: dirExists=" + (Test-Path $dir))
  $lockers = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($dir + '*') })
  if ($lockers.Count) {
    Write-Log ("lockers: " + (($lockers | ForEach-Object { $_.Name + '#' + $_.ProcessId }) -join ', '))
  }

  # ---- 步骤 4：启动安装器并等待退出（用退出码判定成败） ----
  Set-UI '正在安装新版本（静默）...' 60
  Write-Log 'launching installer'
  $proc = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru
  $deadline = (Get-Date).AddMinutes(3)
  $pct = 60
  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $proc.Refresh()
    $pct = [Math]::Min(95, $pct + 2)
    Set-UI ('正在安装新版本... ' + $pct + '%') $pct
  }
  $code = if ($proc.HasExited) { $proc.ExitCode } else { 'timeout' }
  Write-Log ("installer exited=" + $proc.HasExited + " code=$code")

  # ---- 步骤 5：结果展示 + 重启 ----
  if ($proc.HasExited -and $proc.ExitCode -eq 0 -and (Test-Path $newExe)) {
    Set-UI '安装完成！正在启动新版本...' 100
    Start-Sleep -Seconds 2
    try { $script:ui.Close() } catch { }
    Start-Process -FilePath $newExe
  } else {
    Set-UI ('安装失败（安装器退出码: ' + $code + '），请查看 ' + $LOG) 100
    Start-Sleep -Seconds 8
    try { $script:ui.Close() } catch { }
    # 失败时新 exe 通常不存在/是旧版，不强行拉起（避免误导用户以为装好了）
    if (Test-Path $newExe) { Start-Process -FilePath $newExe }
  }
} catch {
  # 兜底：任何一步抛错都落盘、关 UI，别让用户卡在无声窗口；仅当新 exe 存在才拉起
  Write-Log ("install-helper error: " + $_.Exception.Message)
  try { if ($script:ui) { $script:ui.Close() } } catch { }
  if (Test-Path $newExe) { Start-Process -FilePath $newExe -ErrorAction SilentlyContinue }
}
