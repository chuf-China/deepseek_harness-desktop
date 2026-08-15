'use strict';

/**
 * DeepSeek Harness 桌面壳（Electron 主进程）。
 *
 * 职责：
 *   1. spawn 本地 dsh（`dsh web --port <N>`），等它的 web 服务就绪；
 *   2. 开一个 BrowserWindow 指向 http://127.0.0.1:<N>/（不内嵌 UI，壳核分离）；
 *   3. 系统托盘：关窗不退出（隐藏到托盘），托盘菜单可“显示 / 退出”；
 *   4. 真正退出时回收整棵 dsh 子进程树（Windows 用 taskkill /T）。
 *
 * 内核 @deepseek-ai/dsh 作为 npm 依赖锁定版本，绝不 fork/vendor。
 */

const { app, BrowserWindow, Tray, Menu, dialog, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

/** dsh web 就绪探测的总超时（毫秒）。 */
const READY_TIMEOUT_MS = 120_000;

let dshProc = null;
let mainWindow = null;
let tray = null;
let quitting = false; // 主动退出标记：区分“我们杀它”和“它自己崩了”

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

function waitForReady(url, timeoutMs = READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
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

  // 用系统 node 跑 dsh：dsh 的 native 依赖（node-pty / koffi）按标准 node ABI
  // 编译，Electron 内置 node 的 ABI 与之不匹配，所以不用 ELECTRON_RUN_AS_NODE。
  // --expose-internals：dsh 的 HMR 插件（cordis-plugin-hmr）加载时要求该标志，
  // 缺少它 dsh web 会在启动阶段直接 crash（"expose-internals is required"）。
  dshProc = spawn('node', ['--expose-internals', bin, 'web', '--port', String(port)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  dshProc.stdout.on('data', (d) => process.stdout.write(`[dsh] ${d}`));
  dshProc.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`));

  dshProc.on('error', (err) => {
    dialog.showErrorBox(
      'DeepSeek Harness 启动失败',
      `无法启动 dsh：${err.message}\n\n请确认已安装 Node.js（>=18）且 \`node\` 在 PATH 中。`,
    );
    quitting = true;
    app.quit();
  });

  dshProc.on('exit', (code, signal) => {
    dshProc = null;
    if (!quitting) {
      dialog.showErrorBox(
        'DeepSeek Harness 已停止',
        `dsh 进程意外退出（code=${code}, signal=${signal}）。`,
      );
      quitting = true;
      app.quit();
    }
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 DeepSeek Harness', click: showMainWindow },
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
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

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
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  const port = await findFreePort();
  startDsh(port);
  await waitForReady(`http://127.0.0.1:${port}/`);
  await createWindow(port);
  createTray();
}

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                         */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.on('before-quit', () => {
    quitting = true;
    stopDsh();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  // 关窗被拦截为 hide（不销毁），正常不会触发这里；真正退出时由 app.quit() 收尾。
  app.on('window-all-closed', () => {});

  app.on('activate', () => showMainWindow());

  app.whenReady().then(bootstrap).catch((err) => {
    dialog.showErrorBox('DeepSeek Harness 启动失败', err?.stack || String(err));
    quitting = true;
    stopDsh();
    app.quit();
  });
}
