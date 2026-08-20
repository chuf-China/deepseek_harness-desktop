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

const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, nativeTheme, ipcMain, shell } = require('electron');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

// 技能面板数据服务（壳侧）：扫描/读写技能文件 + skills:* IPC（见 skills.js）。
require('./skills');

/* ------------------------------------------------------------------ */
/* 日志：控制台 + <userData>/shell.log                                  */
/* 从 Explorer 双击启动时没有控制台，崩溃/更新/安装过程全部落盘，        */
/* 排查时直接看 %APPDATA%\deepseek-harness-desktop\shell.log。          */
/* ------------------------------------------------------------------ */

const LOG_FILE = (() => {
  try { return path.join(app.getPath('userData'), 'shell.log'); } catch { return null; }
})();

const LOG_MAX_BYTES = 10 * 1024 * 1024; // 超过 10MB 滚成 shell.log.1

function appendLogFile(line) {
  if (!LOG_FILE) return;
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* 忽略 */ }
      }
    } catch { /* 文件尚不存在 */ }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch { /* 写日志失败不致命 */ }
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  appendLogFile(line);
}

// 兜底：任何未捕获异常/拒绝都落盘而不是静默消失（不主动退出——dsh 崩溃重启、
// 更新安装这些关键路径有自己的错误处理与弹框，这里只保证"看得见"）。
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException: ' + ((err && err.stack) || err));
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection: ' + ((reason && reason.stack) || reason));
});

/** dsh web 就绪探测的总超时（毫秒）。 */
const READY_TIMEOUT_MS = 120_000;

/** 开机自启参数：带 --hidden 启动时不弹主窗口，只驻留托盘。 */
const silentStart = process.argv.includes('--hidden');

/** --project <dir>：启动早期 chdir 到指定项目根。自启（HKCU\...\Run）的 cwd 由
 *  Windows 决定（通常是 System32/用户目录），壳侧面板 projectRoot() 找不到 .git，
 *  项目技能分组会消失；自启命令带上 --project 后，进程一启动就切到项目根，壳侧
 *  projectRoot() 与 dsh 子进程（spawn 继承 cwd）都定位到该项目。仅当目录含 .git
 *  时才生效（与内核"项目根 = 最近含 .git 的祖先"规则一致）。 */
(function applyProjectArg() {
  const i = process.argv.indexOf('--project');
  if (i === -1 || !process.argv[i + 1]) return;
  try {
    const dir = path.resolve(process.argv[i + 1]);
    if (fs.existsSync(path.join(dir, '.git'))) process.chdir(dir);
  } catch { /* 无效路径忽略 */ }
})();

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
        // 只认 2xx 才算就绪：dsh 的 HTTP 服务在路由未就绪时可能返回 4xx/5xx，
        // 不能把错误页当成"已就绪"（否则窗口会加载错误页、崩溃计数被清零）。
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else if (Date.now() - started >= timeoutMs) {
          reject(new Error(`dsh 未在 ${Math.round(timeoutMs / 1000)}s 内就绪（HTTP ${res.statusCode}）`));
        } else {
          setTimeout(tick, 400);
        }
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

  dshProc.stdout.on('data', (d) => log('dsh', String(d).replace(/\s+$/, '')));
  dshProc.stderr.on('data', (d) => log('dsh', String(d).replace(/\s+$/, '')));

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
    // 用 spawnSync：退出路径（before-quit / installAndQuit）需要确保整棵 dsh
    // 子进程树在应用退出前确实被杀掉（taskkill 很快，同步等待无感知）。
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
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

  if (crashRetries > MAX_CRASH_RESTARTS) {
    // 已到上限：本次不再重启，先记日志再弹框退出（日志别再说"第 N 次重启"误导）。
    log('error', `dsh 连续崩溃 ${crashRetries} 次，停止自动重启（code=${code}, signal=${signal}）`);
    dialog.showErrorBox(
      'DeepSeek Harness 已停止',
      `dsh 进程连续自动重启 ${MAX_CRASH_RESTARTS} 次仍未恢复（code=${code}, signal=${signal}）。\n请查看日志后手动启动。`,
    );
    quitting = true;
    app.quit();
    return;
  }

  const delay = Math.min(1000 * crashRetries, 5000); // 1s, 2s, 3s, 4s, 5s 退避
  log('warn', `dsh 意外退出（code=${code}, signal=${signal}），${Math.round(delay / 1000)}s 后第 ${crashRetries} 次自动重启`);
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
  log('info', `启动 dsh web（端口 ${port}）`);
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
    // 自启命令 = "已安装 exe" --hidden；额外带 --project <本地源码项目>，让开机自启
    // 的进程启动早期 chdir 回项目根（自启的 cwd 由 Windows 决定，不可控），壳侧面板
    // "项目技能"分组在自启场景下同样可见。项目根取 getProjectDir()（与本地构建更新
    // 通道同源），仅当该目录是 git 项目根时才附加。
    let data = `"${process.execPath}" --hidden`;
    try {
      // 仅当项目目录真实存在（且是 git 根）才附加 --project：发布版在普通用户机器上
      // 默认项目目录不存在，自然跳过——不会把开发机路径写进别人的注册表。
      const proj = getProjectDir();
      if (fs.existsSync(path.join(proj, '.git'))) {
        data += ` --project "${proj}"`;
      }
    } catch { /* 忽略 */ }
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

  // 安全加固（窗口加载的是本地 dsh 页面，不能让它把应用导航到外部站点）：
  // - window.open / target=_blank → 交给系统浏览器打开，窗口内一律拒绝；
  // - 页面导航离开本地 dsh 源（127.0.0.1 / localhost）→ 阻止并转系统浏览器；
  // - 禁用 webview 注入（壳不需要）。
  const isAppOrigin = (url) => {
    try {
      const u = new URL(url);
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    } catch { return false; }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      try { shell.openExternal(url); } catch { /* 忽略 */ }
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      try { shell.openExternal(url); } catch { /* 忽略 */ }
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

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
  const scriptPath = path.join(process.env.TEMP || '.', 'dsh-shortcut-icons-' + process.pid + '-' + Date.now() + '.ps1');
  try {
    fs.writeFileSync(scriptPath, '\uFEFF' + ps, 'utf8');
  } catch (e) {
    return Promise.resolve({ ok: false, err: '写入临时脚本失败：' + e.message });
  }
  return runCaptured('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { env: { ...process.env, DSH_ICON: icoPath } })
    .then((res) => {
      try { fs.unlinkSync(scriptPath); } catch { /* 忽略 */ }
      return res;
    });
}

// 应用退出后（exe 解锁后）由分离的 PowerShell 助手打 exe 图标补丁。
// 全文件唯一允许 detached:true 的 spawn（铁律 #8）；脚本走临时文件 + -File。
// 不删除临时文件：助手在应用退出后运行（先 Sleep 5s），仍需要读取脚本文件。
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
  const scriptPath = path.join(process.env.TEMP || '.', 'dsh-exe-patch-' + process.pid + '.ps1');
  try {
    fs.writeFileSync(scriptPath, '\uFEFF' + ps, 'utf8');
  } catch { return; } // 图标补丁失败不阻塞退出
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-File', scriptPath], {
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

/* ------------------------------------------------------------------ */
/* IPC 调用方校验（安全加固）                                           */
/* ------------------------------------------------------------------ */

// 执行类 IPC 一律先校验调用方：只接受主窗口（加载 dsh 本地页面）发来的调用。
// 即使内核页面被注入脚本，也把可触达的执行面收敛到本窗口、本来源（127.0.0.1/localhost）。
function isTrustedSender(event) {
  try {
    if (!event || !event.sender || !event.senderFrame) return false;
    if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) return false;
    const u = new URL(String(event.senderFrame.url || ''));
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch { return false; }
}

const IPC_DENIED = { ok: false, error: '拒绝：未受信任的调用来源' };

ipcMain.handle('settings:apply-icon', (event) => {
  if (!isTrustedSender(event)) return IPC_DENIED;
  return doApplyIcon();
});

/* 更新：壳 + dsh 内核双通道，一个按钮一起处理 --------------------------- */

// 本地源码项目目录：打包运行时无法自动推断，默认取本机开发目录，设置页可改。
// DSH_PROJECT_DIR 环境变量可覆盖（换了机器/换了仓库位置不用改代码）。
const DEFAULT_PROJECT_DIR = process.env.DSH_PROJECT_DIR || 'C:\\Users\\Administrator\\Desktop\\deepseek harness';

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

// 查询 npm 上 dsh 内核的最新版。注意：deepseek-ai 的发布约定是"新 rc 先发到
// `next` dist-tag，`latest` 只在转正时推进"（实测 0.1.0-rc.8 发布后 dist-tags =
// {"next":"0.1.0-rc.8","latest":"0.1.0-rc.7"}；dsh-agent 等包同样如此）。因此
// `npm view ... version`（= latest tag）会永远漏掉 next 上的新 rc、误报"已是最新"，
// 必须取所有 dist-tag 里的最大版本，并记录来源 tag 用于日志。返回 {version, tag} 或 null。
async function checkDshLatest() {
  try {
    const r = await runCaptured('cmd.exe', ['/c', 'npm.cmd view @deepseek-ai/dsh dist-tags --json --no-audit --no-fund'], { cwd: getProjectDir() });
    if (!r.ok) return null;
    const text = (r.out || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const tags = JSON.parse(text.slice(start, end + 1));
    let best = null;
    let bestTag = null;
    for (const [tag, v] of Object.entries(tags)) {
      const ver = normalizeVersion(v);
      if (!ver || !/^[\d.]+/.test(ver)) continue;
      if (!best || compareSemver(ver, best) > 0) { best = ver; bestTag = tag; }
    }
    return best ? { version: best, tag: bestTag } : null;
  } catch { return null; }
}

// 最小 semver 比较（major.minor.patch + 预发布），用于跨 dist-tag 取最新版。
// 规则：先比主/次/补丁数字；再比预发布标识——无预发布 > 有预发布（0.1.0 > 0.1.0-rc.9），
// 同为预发布按点分段逐段比（数字段按数值、字母段按字典序，数字段 < 字母段；段更少者更大）。
function compareSemver(a, b) {
  const parse = (s) => {
    const m = String(s).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : null } : null;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    if (i >= pa.pre.length) return -1;
    if (i >= pb.pre.length) return 1;
    const xa = pa.pre[i], xb = pb.pre[i];
    const na = /^\d+$/.test(xa), nb = /^\d+$/.test(xb);
    if (na && nb) { const d = parseInt(xa, 10) - parseInt(xb, 10); if (d) return d; continue; }
    if (na) return -1;
    if (nb) return 1;
    if (xa !== xb) return xa < xb ? -1 : 1;
  }
  return 0;
}

// 去掉 semver 范围前缀，取裸版本号用于比较（^0.1.0-rc.6 → 0.1.0-rc.6）。
function normalizeVersion(v) {
  return String(v || '').trim().replace(/^[~^<>= ]+/, '');
}

// 本地构建通道前置检查：npm 是否可用（Windows 下 npm 是 .cmd，经 cmd /c 探测）。
function toolchainAvailable() {
  try {
    const isWin = process.platform === 'win32';
    const r = spawnSync(isWin ? 'cmd.exe' : 'npm', isWin ? ['/c', 'npm.cmd --version'] : ['--version'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15000,
    });
    return r.status === 0 && !r.error;
  } catch { return false; }
}

// 实际安装/运行中的 dsh 内核版本：打包版 = 应用安装目录（__dirname = resources/app，
// launchDsh 正是从这里 resolve 内核 bin）捆绑的那份；开发模式 __dirname 即项目目录，
// 与项目 node_modules 相同。读不到时回退项目 node_modules（离线/目录不完整场景），
// 再读不到返回 null（调用方视为"未知"，不据此误判可升级）。
function getInstalledDshVersion() {
  const candidates = [
    path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(getProjectDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ];
  for (const f of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (pkg.version) return pkg.version;
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

// 安装包文件名比较：按版本号数值排序。不能用默认字典序——"0.1.10" 会排在
// "0.1.9" 前面，取"最后一个"时总是选到旧版安装包（本地通道永远装不上新版本）。
function compareSetupVersions(a, b) {
  const nums = (s) => (String(s).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []).slice(1).map((n) => parseInt(n, 10) || 0);
  const va = nums(a);
  const vb = nums(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] || 0) - (vb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function getUpdateInfo() {
  const projectDir = getProjectDir();
  const info = { projectDir, shellVersion: null, dshPinned: null, dshInstalled: null, installer: null, shellChanged: shellHasChanges() };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    info.shellVersion = pkg.version;
    info.dshPinned = (pkg.dependencies && pkg.dependencies['@deepseek-ai/dsh']) || null;
  } catch { /* 目录无效 */ }
  // 实际安装/运行中的 dsh 内核版本（打包版 = 应用安装目录捆绑的内核，开发模式 = 项目 node_modules）
  info.dshInstalled = getInstalledDshVersion();
  try {
    const distDir = path.join(projectDir, 'dist');
    const files = fs.readdirSync(distDir).filter((f) => /^DeepSeek Harness Setup .*\.exe$/i.test(f));
    files.sort(compareSetupVersions);
    if (files.length) info.installer = path.join(distDir, files[files.length - 1]);
  } catch { /* 无 dist */ }
  return info;
}

function sendUpdateLog(msg) {
  // 广播给主窗口（web 页面里的更新卡片）
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:update-log', msg);
}

// 防并发：一次只允许一个更新流程。重复点击会让两个 npm install 同时写
// node_modules/package.json（npm 无锁），依赖树会被写坏。
let updateInFlight = false;

async function runUpdate({ upgradeDsh }) {
  if (updateInFlight) {
    sendUpdateLog('[更新][WARN] 已有更新流程在运行，请等待它完成（内核升级的 npm install 需要几分钟，界面静默属正常）。');
    return { ok: false, error: '已有更新流程在运行' };
  }
  updateInFlight = true;
  try {
  // 项目目录是单一事实来源（配置默认值或 DSH_PROJECT_DIR），不接受渲染层传入的路径——
  // 否则设置卡片输入框可以指到任意目录，让主进程在攻击者可控的 package.json 上执行 npm 脚本。
  const projectDir = getProjectDir();
  if (!fs.existsSync(path.join(projectDir, 'package.json'))) {
    return { ok: false, error: '项目目录无效或缺少 package.json：' + projectDir };
  }
  sendUpdateLog('[更新] 项目目录：' + projectDir);

  // —— 先检查：壳 + dsh 内核是否都已是最新 ——
  const shellChanged = shellHasChanges();
  sendUpdateLog('[更新] 壳（本地源码 vs 已安装）：' + (shellChanged ? '有改动，可更新' : '已是最新'));
  let dshLatest = null;
  let dshNeedsUpdate = false;
  const updateInfo = getUpdateInfo();
  const pinned = updateInfo.dshPinned || '?';
  const installedDsh = updateInfo.dshInstalled;
  if (upgradeDsh) {
    const latest = await checkDshLatest();
    if (!latest) {
      sendUpdateLog('[更新][WARN] 无法查询 dsh 最新版本（可能离线），按当前锁定版本继续。');
    } else {
      dshLatest = latest.version;
      // 去掉 package.json 里的 semver 范围前缀（^ ~ > < = 等）再比较，避免“^0.1.0-rc.6 != 0.1.0-rc.6”误报可升级
      // 盲区修复：不仅对比「源码锁定版本」，还对比「实际安装/运行中的内核版本」——
      // 源码锁定已是 npm 最新、但应用安装目录仍捆绑旧内核时，必须判为可升级（触发重装），
      // 否则会误报"已是最新"、跳过更新，运行中的内核永远是旧的。
      const pinnedUpToDate = dshLatest === normalizeVersion(pinned);
      const installedUpToDate = !installedDsh || dshLatest === normalizeVersion(installedDsh);
      dshNeedsUpdate = !pinnedUpToDate || !installedUpToDate;
      sendUpdateLog('[更新] dsh 内核：源码锁定 ' + pinned + '，已安装 ' + (installedDsh || '未知') + '，npm 最新 ' + dshLatest + (latest.tag && latest.tag !== 'latest' ? '（dist-tag: ' + latest.tag + '）' : '') + (dshNeedsUpdate ? ' → 可升级' : ' → 已是最新'));
    }
  }

  if (!shellChanged && !(upgradeDsh && dshNeedsUpdate)) {
    const msg = upgradeDsh
      ? '壳和 dsh 内核都已是最新版本，无需更新。'
      : '壳已是最新版本（且未勾选升级 dsh 内核），无需更新。';
    sendUpdateLog('[更新] ✅ ' + msg);
    return { ok: true, upToDate: true, message: msg };
  }

  // —— 本地构建通道前置检查：需要开发机工具链（node/npm；koffi 重编译还要编译工具链）。
  // 打包版在普通用户机器上大概率没有 npm，这里先探测并给出明确错误，而不是在
  // npm install / npm run dist 里挂掉。 ——
  if (!toolchainAvailable()) {
    const msg = '本地构建更新需要 Node.js/npm 工具链（koffi 重编译还需要编译工具链）。未检测到 npm，请先安装 Node.js >= 18 后重试，或改用已发布的更新通道。';
    sendUpdateLog('[更新][ERR] ' + msg);
    return { ok: false, error: msg };
  }

  // —— 内核升级（可选） ——
  if (upgradeDsh && dshNeedsUpdate) {
    // 必须按检查到的确切版本安装：@latest 只解析 latest tag（新 rc 在 next 上时
    // 会装回旧版），且会把锁版写成 ^ 范围（违反铁律 #1 精确锁版）。--save-exact 双保险。
    sendUpdateLog('[更新] 正在升级 dsh 内核到最新版 ' + dshLatest + '（npm install @deepseek-ai/dsh@' + dshLatest + ' --save-exact）…');
    // npm 在非终端（管道）环境下安装全程静默，只在一开始解析/下载整个 rc 依赖树
    // （约 150 个包、上千次 registry 请求，视网络 2~15 分钟）结束时才打印汇总——
    // 不提前说明，用户会把"正在工作"误判成"卡死"。
    sendUpdateLog('[更新] npm 正在解析并下载整个 dsh 依赖树（约 150 个包，视网络 2~15 分钟），期间日志静默属正常，请勿重复点击「检查并更新」。');
    const up = await runCaptured('cmd.exe', ['/c', 'npm.cmd install @deepseek-ai/dsh@' + dshLatest + ' --save-exact --no-audit --no-fund'], { cwd: projectDir, onLine: sendUpdateLog });
    if (up.ok) {
      sendUpdateLog('[更新] dsh 内核已升级。');
    } else {
      sendUpdateLog('[更新][ERR] dsh 内核升级失败：' + ((up.err || up.error || '') + '').trim() + '。本次继续用当前锁定版本打包，装完后检查仍会提示可升级；常见原因：离线、npm 源不可达、缺少编译 koffi 的构建工具链。');
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
  } finally {
    updateInFlight = false;
  }
}

// 由分离的 PowerShell 助手执行（根本性修复 v0.1.3）：
// 不再依赖 electron-builder 的"旧卸载器"流程——旧卸载器在本机反复非零退出
// （安装器 exit 2 / 重试后弹"无法关闭"），其依赖（注册表状态、进程彻底死透、
// 无残留锁文件）任一不满足就失败。改为彻底清理后全新安装：
//   杀全部进程（含逃逸的 dsh node）→ 删安装目录 → 清注册表 → 静默装新版 → 自动重启。
// 与手动修复脚本 fix-install-v2 同逻辑（已实测通过）；安装器面对全新状态，
// 不会触发"卸载旧版"路径，"无法关闭 / exit 2" 结构性消失。
//
// 助手脚本本体在 assets/install-helper.ps1（可读可查可单测的独立文件），参数走
// 环境变量（DSH_INSTALLER / DSH_DIR / DSH_NEWEXE / DSH_LOG），不再在 JS 里拼
// 字符串内联——避免引号转义把关键更新路径搞坏。
function installAndQuit(installer) {
  const exe = installedExePath();
  const dir = exe ? path.dirname(exe) : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
  const newExe = path.join(dir, 'DeepSeek Harness.exe');

  // v0.1.7 关键修正：不能用 spawn detached:true 直接起 powershell——实测 detached 在
  // Windows 上会让 powershell 启动即退（-Command 与 -File 都一样，连 Write-Output 都不执行）。
  // 正确姿势：写一个 .cmd 批处理（CRLF），内部用 `start "" /min powershell.exe -File ...`，
  // 由 cmd 的 start 把 powershell 完全脱离父进程；父进程（应用）退出后它继续跑。
  // 写临时 .ps1 文件（加 UTF-8 BOM，保证 PowerShell 5.1 正确解析中文 UI 文案）
  const ps1 = path.join(process.env.TEMP || '.', 'dsh-install.ps1');
  try {
    // 仓库文件本身带 UTF-8 BOM（PS 5.1 解析中文需要）；Node readFileSync 不会剥 BOM，
    // 这里先剥掉再统一补一个，避免双重 BOM 让脚本开头变成 ZWNBSP 导致解析失败。
    const ps = fs.readFileSync(path.join(__dirname, 'assets', 'install-helper.ps1'), 'utf8').replace(/^\uFEFF/, '');
    fs.writeFileSync(ps1, '\uFEFF' + ps, 'utf8');
  } catch (e) {
    sendUpdateLog('[更新][ERR] 写入安装脚本失败：' + ((e && e.message) || String(e)));
    log('error', 'install-helper: 写入安装脚本失败 ' + ((e && e.message) || String(e)));
    quitting = true;
    stopDsh();
    app.quit();
    return;
  }
  // 写临时 .cmd 批处理（必须 CRLF，LF 会被 cmd 解析破坏）
  const cmdPath = path.join(process.env.TEMP || '.', 'dsh-install.cmd');
  const cmdBody = '@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ps1 + '"\r\n';
  try {
    fs.writeFileSync(cmdPath, cmdBody, 'utf8');
  } catch (e) {
    // 与 .ps1 写失败同样处理：abort——继续 spawn 一个不存在的批处理只会"点了更新没反应"。
    sendUpdateLog('[更新][ERR] 写入安装批处理失败：' + ((e && e.message) || String(e)));
    log('error', 'install-helper: 写入安装批处理失败 ' + ((e && e.message) || String(e)));
    quitting = true;
    stopDsh();
    app.quit();
    return;
  }
  const child = spawn('cmd.exe', ['/c', cmdPath], {
    // 注意：不要 detached:true（会让 powershell 启动即死）；cmd /c start 已实现脱离
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DSH_INSTALLER: installer,
      DSH_DIR: dir,
      DSH_NEWEXE: newExe,
      DSH_LOG: path.join(process.env.TEMP || '.', 'dsh-install.log'),
    },
  });
  child.unref();
  log('info', `install-helper 已启动（installer=${installer} dir=${dir}）`);
  // 稍等片刻让用户看到日志，再真正退出（助手会等应用退出后执行清理与安装）
  setTimeout(() => {
    quitting = true;
    stopDsh();
    app.quit();
  }, 2500);
}

ipcMain.handle('settings:get-update-info', (event) => {
  if (!isTrustedSender(event)) return null;
  return getUpdateInfo();
});
ipcMain.handle('settings:run-update', (event, args) => {
  if (!isTrustedSender(event)) return IPC_DENIED;
  // 项目目录由配置决定（getProjectDir），渲染层只允许表达"是否升级 dsh 内核"。
  return runUpdate({ upgradeDsh: !!(args && args.upgradeDsh) });
});

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

ipcMain.handle('update:check', (event) => {
  if (!isTrustedSender(event)) return { mode: 'error', error: '拒绝：未受信任的调用来源' };
  return checkRealUpdate();
});

ipcMain.handle('update:download', async (event) => {
  if (!isTrustedSender(event)) return IPC_DENIED;
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
    // 兼容连字符/空格两种命名（发布资产用连字符，本地 dist 用空格）：命名变化时
    // 不要静默失效成"未找到已下载的安装包"。
    const files = fs.readdirSync(cacheDir).filter((f) => /^DeepSeek[- ]+Harness[- ]+Setup[- ]+[^/\\]+\\.exe$/i.test(f));
    if (!files.length) return null;
    files.sort(compareSetupVersions);
    const p = path.join(cacheDir, files[files.length - 1]);
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

ipcMain.handle('update:quit-install', (event) => {
  if (!isTrustedSender(event)) return IPC_DENIED;
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
ipcMain.on('shell:theme', (event, isDark) => {
  if (!isTrustedSender(event)) return;
  try {
    nativeTheme.themeSource = isDark ? 'dark' : 'light';
  } catch { /* 忽略 */ }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  log('info', 'dsh 内核版本：' + (getInstalledDshVersion() || '未知（未安装）'));
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
  // Windows 通知/托盘气泡需要 AppUserModelID（Win10+ 上无它托盘气泡可能不显示）。
  app.setAppUserModelId('com.deepseekharness.desktop');

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
