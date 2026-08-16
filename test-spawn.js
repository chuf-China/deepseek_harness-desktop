// 复现 installAndQuit 的 spawn 方式：多行脚本 -Command 传给 powershell.exe（纯无害版）
const { spawn } = require('child_process');
const dir = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness';
const q = (s) => (s || '').replace(/'/g, "''");
const ps = [
  'Start-Sleep -Seconds 1',
  // 无害：只枚举不杀
  `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${q(dir)}*' } | ForEach-Object { Write-Output ('PROC: ' + $_.ProcessId + ' ' + $_.Name) }`,
  'Start-Sleep -Seconds 1',
  "@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue | ForEach-Object { try { $p = Get-ItemProperty $_.PSPath -ErrorAction Stop; if ($p.DisplayName -like '*DeepSeek*') { Write-Output ('REG: ' + $p.DisplayName) } } catch {} } }",
  "Write-Output 'SCRIPT-END-OK'",
].join('\n');
console.log('=== 脚本内容 ===');
console.log(ps);
console.log('=== spawn 执行 ===');
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
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
setTimeout(() => { if (child.exitCode === null) { console.log('TIMEOUT: still running, killing'); child.kill(); } }, 20000);
