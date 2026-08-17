; customCheckAppRunning: 替换 electron-builder 默认的应用关闭逻辑。
; 默认逻辑用 "/fi PID ne $pid" 保护一个应用进程不被杀（更新场景防误杀自身），
; 导致手动安装时主进程永远存活 → "cannot be closed, click Retry" 死循环。
; 这里强制 taskkill 全部应用实例（含整棵子进程树），安装/更新总能继续。
;
; v0.1.11 补充（根因修复）：光杀应用本体还不够——dsh 内核由捆绑的 node 侧车运行
; （resources\node\node.exe），进程名是 node.exe、不在应用名下；若它因崩溃/重启
; 成了孤儿（父进程已死），taskkill /t /im 杀不到它，它会继续锁着安装目录文件 →
; 旧卸载器删文件失败（exit 2）→ 新安装器 UninstallLoop 重试 5 次后弹
; "无法关闭"死循环。这里在杀完应用后，再按"从安装目录运行"兜底杀掉所有残留
; 进程（与 install-helper.ps1 的路径级清理同逻辑，隔离实测有效）。
; 注意：NSIS 里 $$ 是"字面 $"，PowerShell 的 $_. 必须写成 $$_.（直接写 $_ 会
; 被 NSIS 当作未知变量报警告 6000，electron-builder 把警告当错误直接失败）。
!macro customCheckAppRunning
  DetailPrint `Closing running "${PRODUCT_NAME}"...`
  nsExec::Exec `taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Sleep 2000
!macroend
