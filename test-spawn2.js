// 完整复现 installAndQuit 的 ps 结构（无害化：每步只打印标记，不杀进程/不删目录/不装）
const { spawn } = require('child_process');
const dir = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness';
const newExe = dir + '\\DeepSeek Harness.exe';
const installer = process.env.LOCALAPPDATA + '\\deepseek-harness-desktop-updater\\pending\\DeepSeek-Harness-Setup-0.1.4.exe';
const q = (s) => (s || '').replace(/'/g, "''");
const ps = [
  'Write-Output "STEP0: start"',
  'Start-Sleep -Seconds 1',
  // 无害版：只枚举计数
  `$procs = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${q(dir)}*' }; Write-Output ("STEP1: procs=" + @($procs).Count)`,
  `for ($w = 0; $w -lt 3; $w++) { Write-Output ("STEP2-wait: " + $w); Start-Sleep -Milliseconds 300 }`,
  'Start-Sleep -Seconds 1',
  "Write-Output 'STEP3: reg-clear (skipped in test)'",
  `for ($i = 0; $i -lt 3; $i++) { Write-Output ("STEP4-del: " + $i); Start-Sleep -Milliseconds 300 }`,
  `if (Test-Path '${q(dir)}') { Write-Output "STEP5: dir still exists (test mode, no rd)" }`,
  `Write-Output ("STEP6: installer exists = " + (Test-Path '${q(installer)}'))`,
  '$deadline = (Get-Date).AddMinutes(3)',
  `while (-not (Test-Path '${q(newExe)}') -and (Get-Date) -lt $deadline) { Write-Output "STEP7: waiting newExe..."; Start-Sleep -Seconds 1; break }`,
  `Write-Output ("STEP8: newExe exists = " + (Test-Path '${q(newExe)}'))`,
  "Write-Output 'STEP9: DONE-OK'",
].join('\n');
console.log('=== spawn 执行完整结构 ===');
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
child.on('close', (code) => {
  console.log('EXIT CODE:', code);
  console.log('--- STDOUT ---');
  console.log(out);
  console.log('--- STDERR ---');
  console.log(err);
});
setTimeout(() => { if (child.exitCode === null) { console.log('TIMEOUT: still running'); child.kill(); } }, 25000);
