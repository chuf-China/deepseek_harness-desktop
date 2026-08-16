; customCheckAppRunning: 替换 electron-builder 默认的应用关闭逻辑。
; 默认逻辑用 "/fi PID ne $pid" 保护一个应用进程不被杀（更新场景防误杀自身），
; 导致手动安装时主进程永远存活 → "cannot be closed, click Retry" 死循环。
; 这里强制 taskkill 全部应用实例（含整棵子进程树），安装/更新总能继续。
!macro customCheckAppRunning
  DetailPrint `Closing running "${PRODUCT_NAME}"...`
  nsExec::Exec `taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
  Sleep 1500
!macroend
