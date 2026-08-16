'use strict';

/**
 * DeepSeek Harness 桌面壳（Electron 主进程）。
 *
 * 职责：
 *   1. spawn 本地 dsh（`dsh web --port <N>`），等它的 web 服务就绪；
 *   2. 开一个 BrowserWindow 指向 http://127.0.0.1:<N>/（不内嵌 UI，壳核分离）；
 *   3. 系统托盘：关窗不退出（隐藏到托盘），托盘菜单可“显示 / 开机自启 / 退出”；
 *   4. 开机自启：托盘勾选开关（Windows Run 注册表项），自启带 --hidden 静默启动到托盘；
 *   5. dsh 意外退出自动重启：退避重试最多 5 次，连续稳定 30s 后重置计数，超限弹框退出；
 *   6. 真正退出时回收整棵 dsh 子进程树（Windows 用 taskkill /T）。
 *
 * 内核 @deepseek-ai/dsh 作为 npm 依赖锁定版本，绝不 fork/vendor。
 */

const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, nativeTheme, ipcMain } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

// 技能面板数据服务（壳侧）：扫描/读写技能文件 + skills:* IPC（见 skills.js）。
require('./skills');

/** dsh web 就绪探测的总超时（毫秒）。 */
const READY_TIMEOUT_MS = 120_000;

/** 开机自启参数：带 --hidden 启动时不弹主窗口，只驻留托盘。 */
const silentStart = process.argv.includes('--hidden');

/** dsh 崩溃自动重启：最多重试次数，以及“连续稳定运行多久后重置计数”。 */
const MAX_CRASH_RESTARTS = 5;
const STABLE_MS = 30_000;

let dshProc = null;
let mainWindow = null;
let tray = null;
let quitting = false; // 主动退出标记：区分“我们杀它”和“它自己崩了”
let patchExeOnQuit = null; // 退出时给已安装 exe 打图标的 { exe, ico, rcedit }
let crashRetries = 0; // 连续崩溃次数（dsh 稳定运行后重置）
let dshStableSince = 0; // dsh 最近一次就绪的时刻（毫秒时间戳），0 = 尚未就绪

/* ------------------------------------------------------------------ */
/* dsh 定位                                                            */
/* ------------------------------------------------------------------ */

function resolveDshBin() {
  try {
    return require.resolve('@deepseek-ai/dsh/lib/bin.js');
  } catch {
    return null;
  }
}

// 定位用来跑 dsh 的 node：打包后优先用捆绑的标准 node（resources/node/node.exe，
// 与系统 node 同 ABI，dsh 的 native 依赖可正常加载）；开发模式或捆绑缺失时回退
// 系统 node（环境变量 DSH_NODE 可显式指定）。
function findNode() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'node', 'node.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  const envNode = process.env.DSH_NODE;
  if (envNode && fs.existsSync(envNode)) return envNode;
  return 'node';
}

/* ------------------------------------------------------------------ */
/* 端口与就绪探测                                                       */
/* ------------------------------------------------------------------ */

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForReady(url, timeoutMs = READY_TIMEOUT_MS, isDead = null) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      // dsh 在就绪前就退出了：让退出处理器负责重试，这里立即中止等待。
      if (isDead && isDead()) {
        const err = new Error('dsh 进程已退出，等待就绪中止');
        err.code = 'DSH_DIED';
        reject(err);
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`dsh 未在 ${Math.round(timeoutMs / 1000)}s 内就绪`));
        } else {
          setTimeout(tick, 400);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

/* ------------------------------------------------------------------ */
/* dsh 生命周期                                                         */
/* ------------------------------------------------------------------ */

function startDsh(port) {
  const bin = resolveDshBin();
  if (!bin) {
    throw new Error('找不到 @deepseek-ai/dsh。请先在项目目录运行 `npm install`。');
  }

  // 用标准 node 跑 dsh（优先捆绑的 resources/node/node.exe，回退系统 node）：
  // dsh 的 native 依赖（node-pty / koffi）按标准 node ABI 编译，Electron 内置
  // node 的 ABI 与之不匹配，所以不用 ELECTRON_RUN_AS_NODE。
  // --expose-internals：dsh 的 HMR 插件（cordis-plugin-hmr）加载时要求该标志，
  // 缺少它 dsh web 会在启动阶段直接 crash（"expose-internals is required"）。
  dshProc = spawn(findNode(), ['--expose-internals', bin, 'web', '--port', String(port)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  dshProc.stdout.on('data', (d) => process.stdout.write(`[dsh] ${d}`));
  dshProc.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`));

  dshProc.on('error', (err) => {
    dialog.showErrorBox(
      'DeepSeek Harness 启动失败',
      `无法启动 dsh：${err.message}\n\n已捆绑标准 Node（resources/node/node.exe）；若捆绑缺失或损坏，请确认系统已安装 Node.js（>=18）。`,
    );
    quitting = true;
    app.quit();
  });

  dshProc.on('exit', (code, signal) => {
    dshProc = null;
    if (!quitting) handleDshCrash(code, signal);
  });
}

function stopDsh() {
  if (!dshProc || dshProc.pid == null) return;
  const pid = dshProc.pid;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* 尽力而为 */
    }
  } else {
    try {
      dshProc.kill('SIGTERM');
    } catch {
      /* 尽力而为 */
    }
  }
  dshProc = null;
}

/* ------------------------------------------------------------------ */
/* dsh 崩溃自动重启                                                     */
/* ------------------------------------------------------------------ */

function handleDshCrash(code, signal) {
  const now = Date.now();
  // 若 dsh 已稳定运行超过阈值，说明这次崩溃是偶发的，重置连续崩溃计数。
  if (dshStableSince && now - dshStableSince >= STABLE_MS) crashRetries = 0;
  crashRetries += 1;
  console.log(`[shell] dsh 意外退出（code=${code}, signal=${signal}），第 ${crashRetries} 次自动重启`);

  if (crashRetries > MAX_CRASH_RESTARTS) {
    console.error('[shell] dsh 连续崩溃，停止自动重启');
    dialog.showErrorBox(
      'DeepSeek Harness 已停止',
      `dsh 进程连续自动重启 ${MAX_CRASH_RESTARTS} 次仍未恢复（code=${code}, signal=${signal}）。\n请查看日志后手动启动。`,
    );
    quitting = true;
    app.quit();
    return;
  }

  const delay = Math.min(1000 * crashRetries, 5000); // 1s, 2s, 3s, 4s, 5s 退避
  if (tray && process.platform === 'win32') {
    try {
      tray.displayBalloon({
        title: 'DeepSeek Harness',
        content: `dsh 意外退出，${Math.round(delay / 1000)}s 后自动重启（第 ${crashRetries} 次）`,
      });
    } catch { /* 托盘气泡尽力而为 */ }
  }
  setTimeout(() => {
    if (quitting) return;
    launchDsh().catch((err) => {
      console.error('[shell] dsh 自动重启失败：', err);
      dialog.showErrorBox('DeepSeek Harness 已停止', `dsh 自动重启失败：${err.message}`);
      quitting = true;
      app.quit();
    });
  }, delay);
}

// 启动（或崩溃后重启）dsh：找端口 → spawn → 等就绪 → 挂到窗口。
// dsh 在就绪前就退出时，退出处理器负责重试，这里以 DSH_DIED 静默返回。
async function launchDsh() {
  if (quitting) return;
  const port = await findFreePort();
  if (quitting) return;
  startDsh(port);
  try {
    await waitForReady(`http://127.0.0.1:${port}/`, READY_TIMEOUT_MS, () => dshProc === null);
  } catch (err) {
    if (err && err.code === 'DSH_DIED') return; // 退出处理器已接管重启
    throw err;
  }
  dshStableSince = Date.now();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 崩溃重启：窗口还在，直接重载到新端口
      await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    } else {
      // 首次启动：创建窗口（静默启动时保持隐藏，托盘可再显示）
      await createWindow(port);
    }
  } catch (err) {
    // dsh 在就绪后、页面加载完成前又退出：退出处理器已接管重启，这里不再报错退出。
    if (dshProc === null && !quitting) return;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 窗口与托盘                                                           */
/* ------------------------------------------------------------------ */

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  if (icon.isEmpty()) {
    icon = nativeImage
      .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
      .resize({ width: 16, height: 16 });
  }
  if (icon.isEmpty()) {
    console.error('[shell] 托盘图标缺失，跳过托盘（assets/tray.png）');
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip('DeepSeek Harness');
  rebuildTrayMenu();
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

/* 开机自启：直接写 HKCU\...\Run 注册表项（electron 的 setLoginItemSettings 写出的
   值不引号包裹，exe 路径带空格时会在开机启动时被截断，故不用它）。
   自启命令 = "已安装 exe" --hidden（带引号 + 静默启动参数）。
   开发模式（electron .）不支持，避免把 electron.exe 本身注册进开机启动。 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'DeepSeek Harness';

function runReg(args) {
  try {
    execFileSync('reg.exe', args, { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function getAutostart() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  return runReg(['query', RUN_KEY, '/v', RUN_VALUE]);
}

function setAutostart(enabled) {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  if (enabled) {
    const data = `"${process.execPath}" --hidden`;
    runReg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', data, '/f']);
  } else {
    runReg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  }
  return getAutostart();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 DeepSeek Harness', click: showMainWindow },
      { type: 'separator' },
      {
        label: '开机自启（静默启动到托盘）',
        type: 'checkbox',
        checked: getAutostart(),
        click: (item) => {
          if (!app.isPackaged) {
            dialog.showMessageBox({
              type: 'info',
              message: '开机自启仅打包版可用',
              detail: '开发模式（electron .）不支持注册开机启动，请使用打包后的安装版。',
            });
            rebuildTrayMenu();
            return;
          }
          const ok = setAutostart(item.checked);
          if (ok !== item.checked) {
            dialog.showMessageBox({
              type: 'warning',
              message: '设置开机自启失败',
              detail: '写入 Windows 启动项时出错。',
            });
          }
          rebuildTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!silentStart) mainWindow.show();
  });

  // 关窗 → 隐藏到托盘（不销毁、dsh 继续跑）；真正退出时放行。
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

/* ------------------------------------------------------------------ */
/* 设置窗口与图标更新                                                    */
/* ------------------------------------------------------------------ */

function iconAsset(name) {
  return path.join(__dirname, 'assets', name);
}

// 定位已安装应用的 exe：打包运行时即 process.execPath；开发运行时回退到默认安装目录。
function installedExePath() {
  if (process.platform !== 'win32') return null;
  const exe = process.execPath || '';
  if (/deepseek\s*harness\.exe$/i.test(exe)) return exe;
  const fallback = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe',
  );
  return fs.existsSync(fallback) ? fallback : null;
}

// 在 electron-builder 缓存里找 rcedit（用于直接改 exe 图标，无需重新打包）。
function findRcedit() {
  const base = path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder', 'Cache', 'winCodeSign',
  );
  try {
    for (const dir of fs.readdirSync(base)) {
      const p = path.join(base, dir, 'rcedit-x64.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 忽略 */ }
  return null;
}

function runCaptured(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, env: o.env || process.env, cwd: o.cwd });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    if (child.stdout) child.stdout.on('data', (d) => { const s = d.toString(); out += s; if (o.onLine) o.onLine(s); });
    if (child.stderr) child.stderr.on('data', (d) => { const s = d.toString(); err += s; if (o.onLine) o.onLine(s); });
    child.on('error', (e) => finish({ ok: false, out, err, error: e.message }));
    // 用 exit 而非 close：electron-builder 的子进程可能残留并占用管道，
    // close 要等所有管道句柄释放才触发，会让“构建已结束却无完成提示”卡死。
    child.on('exit', (code) => finish({ ok: code === 0, out, err, code }));
  });
}

// 用 PowerShell 的 WScript.Shell 更新桌面/开始菜单快捷方式的图标（即时生效）。
// 图标路径通过环境变量 DSH_ICON 传入，避免命令行引号转义问题。
function updateShortcutIcons(icoPath) {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$sh = New-Object -ComObject WScript.Shell',
    '$ico = $env:DSH_ICON',
    'if (-not $ico) { exit 1 }',
    '$dirs = @(',
    "  [Environment]::GetFolderPath('Desktop'),",
    "  [Environment]::GetFolderPath('CommonDesktopDirectory'),",
    "  ([Environment]::GetFolderPath('ApplicationData') + '/Microsoft/Windows/Start Menu/Programs')",
    ')',
    '$count = 0',
    'foreach ($d in $dirs) {',
    "  $p = Join-Path $d 'DeepSeek Harness.lnk'",
    '  if (Test-Path $p) {',
    '    $lnk = $sh.CreateShortcut($p)',
    "    $lnk.IconLocation = ($ico + ',0')",
    '    $lnk.Save()',
    '    $count++',
    '  }',
    '}',
    "Write-Output ('updated=' + $count)",
  ].join('\n');
  return runCaptured('powershell.exe', ['-NoProfile', '-Command', ps], { env: { ...process.env, DSH_ICON: icoPath } });
}

// 应用退出后（exe 解锁后）由分离的 PowerShell 助手打 exe 图标补丁。
function spawnExePatch(exePath, icoPath, rcedit) {
  const ps = [
    'Start-Sleep -Seconds 5',
    '$rcedit = $env:DSH_RCEDIT',
    '$exe = $env:DSH_EXE',
    '$ico = $env:DSH_ICON',
    'if (($rcedit) -and ($exe) -and ($ico) -and (Test-Path $exe)) {',
    '  & $rcedit $exe --set-icon $ico',
    '}',
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, DSH_RCEDIT: rcedit, DSH_EXE: exePath, DSH_ICON: icoPath },
  });
  child.unref();
}

function scheduleExePatchOnQuit(exePath, icoPath) {
  const rcedit = findRcedit();
  if (!rcedit || !exePath || !icoPath) return;
  patchExeOnQuit = { exe: exePath, ico: icoPath, rcedit };
}

async function doApplyIcon() {
  const steps = [];
  const ico = iconAsset('icon.ico');
  if (!fs.existsSync(ico)) {
    steps.push({ ok: false, fatal: true, msg: '缺少内置图标 assets/icon.ico' });
    return { steps };
  }

  // 1) 复制图标到已安装应用（托盘/资源，下次启动生效）
  const exe = installedExePath();
  if (exe) {
    const root = path.dirname(exe);
    const resources = path.join(root, 'resources');
    const appAssets = path.join(root, 'resources', 'app', 'assets');
    try {
      fs.mkdirSync(resources, { recursive: true });
      fs.copyFileSync(ico, path.join(resources, 'icon.ico'));
      fs.mkdirSync(appAssets, { recursive: true });
      fs.copyFileSync(iconAsset('icon.png'), path.join(appAssets, 'icon.png'));
      fs.copyFileSync(iconAsset('tray.png'), path.join(appAssets, 'tray.png'));
      steps.push({ ok: true, msg: '已更新已安装应用的图标资源（托盘下次启动生效）' });
    } catch (e) {
      steps.push({ ok: false, fatal: false, msg: '复制图标到已安装应用失败：' + e.message });
    }
  } else {
    steps.push({ ok: false, fatal: false, msg: '未找到已安装应用（跳过资源复制）' });
  }

  // 2) 更新桌面/开始菜单快捷方式图标（即时生效）
  const r = await updateShortcutIcons(ico);
  if (r.ok) {
    steps.push({ ok: true, msg: '已更新桌面/开始菜单快捷方式图标（即时生效）' });
  } else {
    steps.push({ ok: false, fatal: false, msg: '更新快捷方式图标失败：' + ((r.err || r.error || '') + '').trim() });
  }

  // 3) 刷新 Windows 图标缓存
  try {
    spawn('ie4uinit.exe', ['-show'], { windowsHide: true });
    steps.push({ ok: true, msg: '已请求刷新 Windows 图标缓存' });
  } catch {
    steps.push({ ok: false, fatal: false, msg: '刷新图标缓存被跳过' });
  }

  // 4) exe 内嵌图标：先尝试立即打补丁；被占用则退出时自动打
  const rcedit = findRcedit();
  if (exe && rcedit) {
    const res = await runCaptured(rcedit, [exe, '--set-icon', ico], {});
    if (res.ok) {
      steps.push({ ok: true, msg: 'exe 内嵌图标已更新（任务栏/标题栏下次启动生效）' });
    } else {
      scheduleExePatchOnQuit(exe, ico);
      steps.push({ ok: false, fatal: false, msg: 'exe 正被占用，已安排在下次退出应用时自动更新 exe 图标' });
    }
  } else if (exe && !rcedit) {
    steps.push({ ok: false, fatal: false, msg: '未找到 rcedit，exe 内嵌图标需重新打包或运行 update-exe-icon.cmd' });
  } else {
    steps.push({ ok: false, fatal: false, msg: '未找到已安装应用，跳过 exe 图标' });
  }

  return { steps };
}

ipcMain.handle('settings:apply-icon', () => doApplyIcon());

/* 更新：壳 + dsh 内核双通道，一个按钮一起处理 --------------------------- */

// 本地源码项目目录：打包运行时无法自动推断，默认取本机开发目录，设置页可改。
const DEFAULT_PROJECT_DIR = 'C:\\Users\\Administrator\\Desktop\\deepseek harness';

function getProjectDir() {
  return DEFAULT_PROJECT_DIR;
}

function filesEqual(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

// 壳是否有改动：比较源码项目与已安装应用的关键运行时文件（排除 package.json，
// 因为 electron-builder 打包时会改写它）。
function shellHasChanges() {
  const projectDir = getProjectDir();
  const installedApp = __dirname;
  const files = [
    'main.js', 'preload.js',
    'assets/icon.ico', 'assets/icon.png', 'assets/tray.png', 'assets/icon.svg',
  ];
  for (const f of files) {
    const a = path.join(projectDir, f);
    const b = path.join(installedApp, f);
    const ea = fs.existsSync(a);
    const eb = fs.existsSync(b);
    if (ea !== eb) return true;
    if (ea && eb && !filesEqual(a, b)) return true;
  }
  return false;
}

async function checkDshLatest() {
  try {
    const r = await runCaptured('cmd.exe', ['/c', 'npm.cmd view @deepseek-ai/dsh version --no-audit --no-fund'], { cwd: getProjectDir() });
    if (!r.ok) return null;
    const lines = (r.out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null;
  } catch { return null; }
}

// 去掉 semver 范围前缀，取裸版本号用于比较（^0.1.0-rc.6 → 0.1.0-rc.6）。
function normalizeVersion(v) {
  return String(v || '').trim().replace(/^[~^<>= ]+/, '');
}

function getUpdateInfo() {
  const projectDir = getProjectDir();
  const info = { projectDir, shellVersion: null, dshPinned: null, dshInstalled: null, installer: null, shellChanged: shellHasChanges() };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    info.shellVersion = pkg.version;
    info.dshPinned = (pkg.dependencies && pkg.dependencies['@deepseek-ai/dsh']) || null;
  } catch { /* 目录无效 */ }
  try {
    const dshPkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    info.dshInstalled = dshPkg.version;
  } catch { /* 未安装 */ }
  try {
    const distDir = path.join(projectDir, 'dist');
    const files = fs.readdirSync(distDir).filter((f) => /^DeepSeek Harness Setup .*\.exe$/i.test(f));
    files.sort();
    if (files.length) info.installer = path.join(distDir, files[files.length - 1]);
  } catch { /* 无 dist */ }
  return info;
}

function sendUpdateLog(msg) {
  // 广播给主窗口（web 页面里的更新卡片）
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:update-log', msg);
}

async function runUpdate({ projectDir, upgradeDsh }) {
  if (!projectDir || !fs.existsSync(path.join(projectDir, 'package.json'))) {
    return { ok: false, error: '项目目录无效或缺少 package.json：' + projectDir };
  }
  sendUpdateLog('[更新] 项目目录：' + projectDir);

  // —— 先检查：壳 + dsh 内核是否都已是最新 ——
  const shellChanged = shellHasChanges();
  sendUpdateLog('[更新] 壳（本地源码 vs 已安装）：' + (shellChanged ? '有改动，可更新' : '已是最新'));
  let dshLatest = null;
  let dshNeedsUpdate = false;
  const pinned = getUpdateInfo().dshPinned || '?';
  if (upgradeDsh) {
    dshLatest = await checkDshLatest();
    if (!dshLatest) {
      sendUpdateLog('[更新][WARN] 无法查询 dsh 最新版本（可能离线），按当前锁定版本继续。');
    } else {
      // 去掉 package.json 里的 semver 范围前缀（^ ~ > < = 等）再比较，避免“^0.1.0-rc.6 != 0.1.0-rc.6”误报可升级
      dshNeedsUpdate = dshLatest !== normalizeVersion(pinned);
      sendUpdateLog('[更新] dsh 内核：当前锁定 ' + pinned + '，npm 最新 ' + dshLatest + (dshNeedsUpdate ? ' → 可升级' : ' → 已是最新'));
    }
  }

  if (!shellChanged && !(upgradeDsh && dshNeedsUpdate)) {
    const msg = upgradeDsh
      ? '壳和 dsh 内核都已是最新版本，无需更新。'
      : '壳已是最新版本（且未勾选升级 dsh 内核），无需更新。';
    sendUpdateLog('[更新] ✅ ' + msg);
    return { ok: true, upToDate: true, message: msg };
  }

  // —— 内核升级（可选） ——
  if (upgradeDsh && dshNeedsUpdate) {
    sendUpdateLog('[更新] 正在升级 dsh 内核到最新版（npm install @deepseek-ai/dsh@latest）…');
    const up = await runCaptured('cmd.exe', ['/c', 'npm.cmd install @deepseek-ai/dsh@latest --no-audit --no-fund'], { cwd: projectDir, onLine: sendUpdateLog });
    if (up.ok) {
      sendUpdateLog('[更新] dsh 内核已升级。');
    } else {
      sendUpdateLog('[更新][WARN] dsh 升级失败，继续用当前锁定版本打包：' + ((up.err || up.error || '') + '').trim());
    }
  } else if (upgradeDsh) {
    sendUpdateLog('[更新] dsh 已是 npm 最新版，无需升级。');
  } else {
    sendUpdateLog('[更新] 保持 dsh 锁定版本：' + pinned);
  }

  // —— 重新打包全部改动 ——
  sendUpdateLog('[更新] 开始重新打包全部改动（npm run dist）…');
  const build = await runCaptured('cmd.exe', ['/c', 'npm.cmd run dist'], { cwd: projectDir, onLine: sendUpdateLog });
  if (!build.ok) {
    sendUpdateLog('[更新] 打包失败：' + ((build.err || build.error || '') + '').trim());
    return { ok: false, error: '打包失败，详见上方日志' };
  }

  const info = getUpdateInfo();
  if (!info.installer || !fs.existsSync(info.installer)) {
    sendUpdateLog('[更新][ERR] 未找到新安装包，无法自动安装');
    return { ok: false, error: '未找到新安装包' };
  }
  sendUpdateLog('[更新] 打包完成。2 秒后自动退出并静默安装，安装完成后自动重启。');
  sendUpdateLog('[更新] 新安装包：' + info.installer);
  installAndQuit(info.installer);
  return { ok: true, autoInstall: true };
}

// 由分离的 PowerShell 助手执行（根本性修复 v0.1.3）：
// 不再依赖 electron-builder 的"旧卸载器"流程——旧卸载器在本机反复非零退出
// （安装器 exit 2 / 重试后弹"无法关闭"），其依赖（注册表状态、进程彻底死透、
// 无残留锁文件）任一不满足就失败。改为彻底清理后全新安装：
//   杀全部进程（含逃逸的 dsh node）→ 删安装目录 → 清注册表 → 静默装新版 → 自动重启。
// 与手动修复脚本 fix-install-v2 同逻辑（已实测通过）；安装器面对全新状态，
// 不会触发"卸载旧版"路径，"无法关闭 / exit 2" 结构性消失。
function installAndQuit(installer) {
  const exe = installedExePath();
  const dir = exe ? path.dirname(exe) : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
  const newExe = path.join(dir, 'DeepSeek Harness.exe');
  const q = (s) => (s || '').replace(/'/g, "''");
  const ps = [
    // v0.1.6 关键修正：不用 -Command 传多行脚本（实测会被 Windows 命令行解析破坏，
    // 表现为 powershell 启动即退、无任何日志）；改写成临时 .ps1 文件 + -File 执行，
    // 彻底绕开命令行解析坑。
    //   1) 先杀进程（路径级，等进程真正消失）——不依赖 taskkill /t /im（助手自身是应用后代进程，/t 会连助手一起杀）
    //   2) 先清注册表再删目录——注册表清了，安装器就检测不到旧版，走全新安装覆盖，
    //      永远不会触发 electron-builder 的 uninstallOldVersion（"无法关闭 / exit 2" 的根源）
    //   3) 删目录失败不再退出——注册表已清 + 进程已死，安装器静默覆盖安装即可成功
    // 全流程写日志到 %TEMP%\dsh-install.log，任何一步失败都能定位
    `$LOG = Join-Path $env:TEMP 'dsh-install.log'; "=== installAndQuit $(Get-Date -Format s) installer='${q(installer)}' ===" | Out-File $LOG -Encoding utf8`,
    'Start-Sleep -Seconds 6',
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${q(dir)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    // 轮询等待安装目录进程全部消失（最多 30 秒），避免句柄未释放导致删目录/覆盖失败
    `for ($w = 0; $w -lt 30; $w++) { $left = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${q(dir)}*' }; if (-not $left) { break }; Start-Sleep -Seconds 1 }; "after kill: left=$(@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${q(dir)}*' }).Count)" | Out-File $LOG -Append -Encoding utf8`,
    'Start-Sleep -Seconds 3',
    // 先清注册表（关键！放在删目录之前）
    "@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue | ForEach-Object { try { $p = Get-ItemProperty $_.PSPath -ErrorAction Stop; if ($p.DisplayName -like '*DeepSeek*') { Remove-Item $_.PSPath -Recurse -Force; Write-Output ('removed-reg: ' + $_.PSPath) | Out-File $LOG -Append -Encoding utf8 } } catch {} } }",
    // 删目录：尽力而为（rd /s /q 兜底），失败不中止——安装器会全新覆盖
    `for ($i = 0; $i -lt 10; $i++) { if (-not (Test-Path '${q(dir)}')) { break }; try { Remove-Item '${q(dir)}' -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 2 } }`,
    `if (Test-Path '${q(dir)}') { "del-dir-failed, trying rd" | Out-File $LOG -Append -Encoding utf8; cmd /c rd /s /q '${q(dir)}' 2>$null }; "after del: dirExists=$(Test-Path '${q(dir)}')" | Out-File $LOG -Append -Encoding utf8`,
    `"launching installer" | Out-File $LOG -Append -Encoding utf8; Start-Process -FilePath '${q(installer)}' -ArgumentList '/S'`,
    '$deadline = (Get-Date).AddMinutes(3)',
    `while (-not (Test-Path '${q(newExe)}') -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }; "after wait: newExeExists=$(Test-Path '${q(newExe)}')" | Out-File $LOG -Append -Encoding utf8`,
    `if (Test-Path '${q(newExe)}') { Start-Process -FilePath '${q(newExe)}' } else { Start-Process -FilePath '${q(newExe)}' -ErrorAction SilentlyContinue }`,
  ].join('\r\n');
  // 写临时 .ps1 文件，用 -File 执行（-Command 多行传参在真实 spawn 下会被破坏）
  const ps1 = path.join(process.env.TEMP || '.', 'dsh-install.ps1');
  try { fs.writeFileSync(ps1, ps, 'utf8'); } catch (e) { sendUpdateLog('[更新][ERR] 写入安装脚本失败：' + ((e && e.message) || String(e))); }
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  // 稍等片刻让用户看到日志，再真正退出（助手会等应用退出后执行清理与安装）
  setTimeout(() => {
    quitting = true;
    stopDsh();
    app.quit();
  }, 2500);
}

ipcMain.handle('settings:get-update-info', () => getUpdateInfo());
ipcMain.handle('settings:run-update', (_e, args) => runUpdate(args || {}));

/* ------------------------------------------------------------------ */
/* 真实自动更新（electron-updater，壳通道）                               */
/* 已发布场景（package.json 的 publish + GitHub Releases）优先走此通道：    */
/* 检查 → 下载 → 退出并静默安装。未发布 / 开发模式自动回退本地构建更新。     */
/* ------------------------------------------------------------------ */

let autoUpdater = null;
let downloadedInstallerPath = null; // update-downloaded 事件记录的安装器路径（干净安装用）
try {
  const { autoUpdater: au } = require('electron-updater');
  autoUpdater = au;
  autoUpdater.autoDownload = false; // 手动触发下载（update:download）
  autoUpdater.autoInstallOnAppQuit = false; // 手动触发安装（update:quit-install）
  autoUpdater.logger = {
    info: (m) => sendUpdateLog('[更新][updater] ' + m),
    warn: (m) => sendUpdateLog('[更新][updater][WARN] ' + m),
    error: (m) => sendUpdateLog('[更新][updater][ERR] ' + m),
  };
  autoUpdater.on('download-progress', (p) => {
    const mb = (n) => (n != null ? Math.round(n / 1048576) : '?');
    const pct = p && p.percent != null ? p.percent.toFixed(1) : '?';
    sendUpdateLog('[更新] 下载中… ' + pct + '%（' + mb(p && p.transferred) + ' / ' + mb(p && p.total) + ' MB）');
  });
  autoUpdater.on('update-downloaded', (info) => {
    // 记录下载好的安装器路径：update:quit-install 用它走"干净状态静默安装"（根本性修复，
    // 绕开 electron-builder 的旧卸载器流程，见 installAndQuit）。
    if (info && info.downloadedFile) downloadedInstallerPath = info.downloadedFile;
    sendUpdateLog('[更新] 新版本下载完成。' + (downloadedInstallerPath ? '（' + downloadedInstallerPath + '）' : ''));
  });
  autoUpdater.on('error', (e) => sendUpdateLog('[更新][updater][ERR] ' + ((e && e.message) || String(e))));
} catch { autoUpdater = null; }

// 可选发布源覆盖：resources/update-config.json（{provider, owner, repo} 或 {provider:'generic', url}）。
// 不提供时用打包时写入的 app-update.yml（来自 package.json 的 publish 配置）。
function updateFeedOverride() {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'update-config.json')
      : path.join(__dirname, 'update-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* 忽略 */ }
  return null;
}

// 检查壳的真实发布通道。返回：
//   {mode:'dev'}           开发模式（electron .），走本地构建
//   {mode:'real', ...}     已发布且检查成功
//   {mode:'unconfigured'}  未配置发布源（无 app-update.yml）
//   {mode:'error', ...}    检查失败（离线 / 仓库不存在等）
async function checkRealUpdate() {
  if (!autoUpdater) return { mode: 'none', error: 'electron-updater 未加载' };
  if (!app.isPackaged) return { mode: 'dev', note: '开发模式：使用本地构建更新' };
  try {
    const override = updateFeedOverride();
    if (override) autoUpdater.setFeedURL(override);
    const res = await autoUpdater.checkForUpdates();
    const avail = !!(res && res.isUpdateAvailable);
    return {
      mode: 'real',
      configured: true,
      updateAvailable: avail,
      current: res && res.currentVersion ? res.currentVersion.version : null,
      latest: avail && res.updateInfo ? res.updateInfo.version : null,
    };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const unconfigured = /app-update\.yml|no.*feed|publish/i.test(msg);
    return { mode: unconfigured ? 'unconfigured' : 'error', error: msg };
  }
}

ipcMain.handle('update:check', () => checkRealUpdate());

ipcMain.handle('update:download', async () => {
  if (!autoUpdater) return { ok: false, error: 'electron-updater 未加载' };
  try {
    await autoUpdater.downloadUpdate();
    // 不依赖 update-downloaded 事件的时序：直接从 updater 缓存目录兜底定位安装包
    if (!downloadedInstallerPath) downloadedInstallerPath = findDownloadedInstaller();
    return { ok: true, installer: downloadedInstallerPath };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// 从 electron-updater 缓存目录（%LOCALAPPDATA%\deepseek-harness-desktop-updater\pending）
// 找到最新下载的安装包。彻底摆脱对 update-downloaded 事件时序的依赖
// （事件若未触发/未赶上，quit-install 不再回退 electron-updater 的 quitAndInstall 旧流程）。
function findDownloadedInstaller() {
  try {
    const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'deepseek-harness-desktop-updater', 'pending');
    if (!fs.existsSync(cacheDir)) return null;
    const files = fs.readdirSync(cacheDir).filter((f) => /^DeepSeek-Harness-Setup-.*\.exe$/i.test(f));
    if (!files.length) return null;
    files.sort();
    const p = path.join(cacheDir, files[files.length - 1]);
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

ipcMain.handle('update:quit-install', () => {
  // 根本性修复：只走"干净状态静默安装"（installAndQuit：杀进程→清注册表→删目录→
  // 装新版→重启），彻底绕开 electron-updater 的 quitAndInstall 及其触发的旧卸载器
  // 流程（旧卸载器失败 → exit 2 / "无法关闭"）。找不到安装包就明确报错，绝不回退旧流程。
  const installer = (downloadedInstallerPath && fs.existsSync(downloadedInstallerPath))
    ? downloadedInstallerPath
    : findDownloadedInstaller();
  if (installer) {
    installAndQuit(installer);
    return { ok: true, mode: 'clean-install', installer };
  }
  return { ok: false, error: '未找到已下载的安装包' };
});

// 内核主题同步：web 页面报告实际主题（深/浅），让 Windows 标题栏等原生 UI 跟随，
// 与内核外观保持一致。原生菜单已移除（Menu.setApplicationMenu(null)）。
ipcMain.on('shell:theme', (_event, isDark) => {
  try {
    nativeTheme.themeSource = isDark ? 'dark' : 'light';
  } catch { /* 忽略 */ }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  createTray();
  await launchDsh();
}

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                         */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // 开机自启（--hidden）撞上已在运行的实例时保持静默，不打扰。
    if (argv.includes('--hidden')) return;
    showMainWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopDsh();
    if (patchExeOnQuit) {
      spawnExePatch(patchExeOnQuit.exe, patchExeOnQuit.ico, patchExeOnQuit.rcedit);
      patchExeOnQuit = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  // 关窗被拦截为 hide（不销毁），正常不会触发这里；真正退出时由 app.quit() 收尾。
  app.on('window-all-closed', () => {});

  app.on('activate', () => showMainWindow());

  app.whenReady().then(async () => {
    // 去掉 Electron 默认的英文 File/Edit/View/Window/Help 菜单栏（功能都在 web UI 里）
    Menu.setApplicationMenu(null);
    await bootstrap();
  }).catch((err) => {
    dialog.showErrorBox('DeepSeek Harness 启动失败', err?.stack || String(err));
    quitting = true;
    stopDsh();
    app.quit();
  });
}
