// 二分定位：哪个结构导致 -Command 静默失败
const { spawn } = require('child_process');

function run(label, ps) {
  return new Promise((resolve) => {
    console.log('\n===== ' + label + ' =====');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      console.log('EXIT:', code);
      console.log('OUT:', JSON.stringify(out));
      console.log('ERR:', JSON.stringify(err));
      resolve();
    });
    setTimeout(() => { if (child.exitCode === null) { console.log('TIMEOUT'); child.kill(); resolve(); } }, 15000);
  });
}

(async () => {
  const dir = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness';
  // A: 单引号字符串
  await run('A-single-quote', "Write-Output 'HELLO-A'; Write-Output 'DONE'");
  // B: 双引号字符串
  await run('B-double-quote', 'Write-Output "HELLO-B"; Write-Output "DONE"');
  // C: 变量赋值 + 单引号
  await run('C-var-assign', "$x = 'abc'; Write-Output ('X=' + $x)");
  // D: 变量赋值 + 双引号插值
  await run('D-var-interp', '$x = 42; Write-Output "X=$x"');
  // E: 反引号模板行（installAndQuit 实际用的，含 ${} 无）单引号包裹路径
  await run('E-real-style', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dir}*' } | ForEach-Object { Write-Output ('P: ' + $_.ProcessId) }`);
  // F: for 循环
  await run('F-for-loop', "for ($i = 0; $i -lt 3; $i++) { Write-Output ('I=' + $i) }");
  // G: while 循环 + Get-Date
  await run('G-while', "$deadline = (Get-Date).AddMinutes(3); while ($true) { Write-Output 'W'; break }");
  // H: 完整真实脚本结构（installAndQuit 的 ps，全无害化——保留所有语法形态）
  const ps = [
    'Start-Sleep -Seconds 1',
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dir}*' } | ForEach-Object { Write-Output ('PROC: ' + $_.ProcessId) }`,
    'Start-Sleep -Seconds 1',
    `for ($i = 0; $i -lt 2; $i++) { Write-Output ('DEL: ' + $i) }`,
    `if (Test-Path '${dir}') { Write-Output 'DIR-EXISTS' }`,
    "@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue | ForEach-Object { try { $p = Get-ItemProperty $_.PSPath -ErrorAction Stop; if ($p.DisplayName -like '*DeepSeek*') { Write-Output ('REG: ' + $p.DisplayName) } } catch {} } }",
    `Write-Output ('INSTALLER-EXISTS: ' + (Test-Path '${dir}'))`,
    '$deadline = (Get-Date).AddMinutes(3)',
    `while (-not (Test-Path '${dir}') -and (Get-Date) -lt $deadline) { Write-Output 'WAIT'; Start-Sleep -Seconds 1 }`,
    `Write-Output 'SCRIPT-END-OK'`,
  ].join('\n');
  await run('H-full-real-style', ps);
})();
