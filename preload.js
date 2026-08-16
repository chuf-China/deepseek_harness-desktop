'use strict';

/**
 * preload：注入到 dsh 的 web 页面的桥 + 原生设置弹窗注入。
 *
 * 1. 通过 contextBridge 暴露 __DSH_DESKTOP__（与 dsh 自己的 __DSH_BOOT__ 不冲突），
 *    提供更新/图标等原生能力。
 * 2. 用 MutationObserver 监听 DOM，把壳自有的「更新」卡片插入 dsh web 原生设置
 *    弹窗的内容区（导航之后的 options 容器），颜色从弹窗计算样式动态取值，
 *    自动跟随浅色/深色主题，不破坏原生结构（壳核分离，不动内核代码）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  '__DSH_DESKTOP__',
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    getUpdateInfo: () => ipcRenderer.invoke('settings:get-update-info'),
    runUpdate: (projectDir, upgradeDsh) => ipcRenderer.invoke('settings:run-update', { projectDir, upgradeDsh }),
    checkUpdate: () => ipcRenderer.invoke('update:check'),
    downloadUpdate: () => ipcRenderer.invoke('update:download'),
    quitAndInstall: () => ipcRenderer.invoke('update:quit-install'),
    applyIcon: () => ipcRenderer.invoke('settings:apply-icon'),
    onUpdateLog: (cb) => {
      const listener = (_event, msg) => cb(msg);
      ipcRenderer.on('settings:update-log', listener);
      return () => ipcRenderer.removeListener('settings:update-log', listener);
    },
  }),
);

/* ------------------------------------------------------------------ */
/* 原生设置弹窗注入「更新」卡片                                          */
/* ------------------------------------------------------------------ */

// 更新日志订阅（跨注入复用，避免 tab 切换重注入时重复监听）
let updateLogListener = null;

function findOptionsContainer(dialog) {
  const nav = dialog.querySelector('nav');
  const children = [...dialog.children];
  const content = children.find((c) => c !== nav);
  if (!content) return dialog;
  const options = [...content.children].find((c) => /options/i.test(typeof c.className === 'string' ? c.className : '')) || content;
  return options;
}

// 全部用 currentColor（从弹窗继承的当前文字色）动态取色，
// 内核切换浅色/深色/跟随系统时卡片自动跟随，无需重新注入。
// 排版对齐内核设置项：系统字体 14px/行高22px、36px 圆角胶囊控件、无卡片盒子。
function cardStyle() {
  return `
:host { display: block; }
.card {
  padding: 4px 0 8px;
  color: currentColor;
  font-size: 14px;
  line-height: 22px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
}
.card h4 { margin: 16px 0 2px; font-size: 14px; font-weight: 600; color: currentColor; }
.card .sub { margin: 0 0 4px; font-size: 12.5px; color: color-mix(in srgb, currentColor 52%, transparent); }
.card .ver { margin: 4px 0 10px; font-size: 12.5px; color: color-mix(in srgb, currentColor 65%, transparent); }
.card .field { margin: 10px 0; }
.card .field label { display: block; font-size: 13px; color: color-mix(in srgb, currentColor 60%, transparent); margin-bottom: 6px; }
.card input[type="text"] {
  width: 100%; box-sizing: border-box;
  background: color-mix(in srgb, currentColor 12%, transparent);
  color: currentColor;
  border: 0; border-radius: 18px; height: 36px; padding: 0 14px;
  font-size: 14px;
}
.card input[type="text"]:focus { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #4d6bfe 55%, transparent); }
.card label.check { display: flex; align-items: center; gap: 8px; font-size: 14px; color: currentColor; margin: 8px 0 12px; }
.card .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 4px 0; }
.card button {
  appearance: none; border: 0; border-radius: 18px; height: 36px; padding: 0 18px;
  font-size: 14px; font-weight: 500; cursor: pointer;
}
.card button.primary { background: #4d6bfe; color: #fff; }
.card button.primary:hover { filter: brightness(1.08); }
.card button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.card button.ghost { background: transparent; color: currentColor; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
.card button.ghost:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.card button.ghost:disabled { opacity: 0.5; cursor: not-allowed; }
.card .log {
  display: none; margin-top: 10px; padding: 8px 12px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  border-radius: 12px;
  font-family: Consolas, "SF Mono", monospace; font-size: 12px; max-height: 160px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
  color: color-mix(in srgb, currentColor 75%, transparent);
}
.card .log.show { display: block; }
`;
}

function injectUpdateCardInto(dialog) {
  // 卡片宿主在 light DOM（shadow root 内容无法被外部 querySelector 命中），
  // 用 host 标记判断是否已注入，避免重复注入死循环。
  if (dialog.querySelector('[data-dsh-update-card-host]')) return null;

  const host = document.createElement('div');
  host.setAttribute('data-dsh-update-card-host', '');
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = cardStyle();
  shadow.appendChild(style);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div class="card">
  <h4>更新</h4>
  <p class="sub">桌面壳 · 一键更新（壳 + dsh 内核双通道）</p>
  <p class="ver" data-ver>读取中…</p>
  <div class="field">
    <label>本地源码项目目录</label>
    <input type="text" data-project spellcheck="false" />
  </div>
  <label class="check"><input type="checkbox" data-upgrade-dsh /> 同时升级 dsh 内核到最新版（默认不勾，保守）</label>
  <div class="row">
    <button type="button" class="primary" data-run>检查并更新</button>
    <button type="button" class="ghost" data-icon>更新为鲸鱼图标</button>
  </div>
  <div class="log" data-log></div>
</div>`;
  shadow.appendChild(wrap);

  const q = (sel) => shadow.querySelector(sel);
  const verEl = q('[data-ver]');
  const projEl = q('[data-project]');
  const chkEl = q('[data-upgrade-dsh]');
  const runBtn = q('[data-run]');
  const iconBtn = q('[data-icon]');
  const logEl = q('[data-log]');

  const appendLog = (msg, color) => {
    logEl.classList.add('show');
    const line = document.createElement('div');
    line.textContent = msg;
    if (color) line.style.color = color;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };

  ipcRenderer.invoke('settings:get-update-info').then((info) => {
    if (!info) { verEl.textContent = '无法读取更新信息'; return; }
    projEl.value = info.projectDir || '';
    const dsh = (info.dshInstalled || '?') + (info.dshPinned ? '（锁定 ' + info.dshPinned + '）' : '');
    verEl.textContent =
      '壳 ' + (info.shellVersion || '?') + ' · dsh ' + dsh +
      (info.shellChanged ? ' · 壳有改动，可更新' : ' · 壳已是最新');
  }).catch(() => { verEl.textContent = '无法读取更新信息'; });

  if (updateLogListener) {
    ipcRenderer.removeListener('settings:update-log', updateLogListener);
    updateLogListener = null;
  }
  updateLogListener = (_e, msg) => appendLog(msg);
  ipcRenderer.on('settings:update-log', updateLogListener);

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    appendLog('—— 检查并更新 ——');
    try {
      // 1) 真实发布通道：壳有新版本且本地无未部署改动 → 下载并静默安装
      let info = null;
      try { info = await ipcRenderer.invoke('settings:get-update-info'); } catch { /* 忽略 */ }
      const check = await ipcRenderer.invoke('update:check');
      if (check && check.mode === 'real' && check.updateAvailable && !(info && info.shellChanged)) {
        appendLog('[OK] 发现壳新版本 ' + check.latest + '（当前 ' + (check.current || '?') + '），正在下载…', '#34c98e');
        const dl = await ipcRenderer.invoke('update:download');
        if (dl && dl.ok) {
          appendLog('[OK] 下载完成，即将退出并自动安装…', '#34c98e');
          await ipcRenderer.invoke('update:quit-install');
          return;
        }
        appendLog('[ERR] 下载失败：' + ((dl && dl.error) || '未知错误'), '#f2545b');
        return;
      }
      if (check && check.mode === 'unconfigured') {
        appendLog('[WARN] 未配置发布源（GitHub Releases），回退本地构建更新。', '#f5a623');
      } else if (check && check.mode === 'error') {
        appendLog('[WARN] 真实更新通道检查失败：' + check.error + '，回退本地构建更新。', '#f5a623');
      }
      // 2) 本地构建更新（开发模式 / 未发布场景）
      const r = await ipcRenderer.invoke('settings:run-update', {
        projectDir: (projEl.value || '').trim(),
        upgradeDsh: chkEl.checked,
      });
      if (r && r.ok) {
        appendLog(r.upToDate ? '[OK] ' + (r.message || '已是最新版本，无需更新。') : '[OK] 打包完成，即将自动退出并安装更新…', '#34c98e');
      } else {
        appendLog('[ERR] ' + ((r && r.error) || '更新失败'), '#f2545b');
      }
    } catch (e) {
      appendLog('[ERR] ' + (e && e.message ? e.message : String(e)), '#f2545b');
    } finally {
      runBtn.disabled = false;
    }
  });

  iconBtn.addEventListener('click', async () => {
    iconBtn.disabled = true;
    appendLog('—— 更新图标 ——');
    try {
      const r = await ipcRenderer.invoke('settings:apply-icon');
      for (const s of (r.steps || [])) {
        appendLog((s.ok ? '[OK] ' : (s.fatal ? '[ERR] ' : '[WARN] ')) + s.msg, s.ok ? '#34c98e' : '#f5a623');
      }
    } catch (e) {
      appendLog('[ERR] ' + (e && e.message ? e.message : String(e)), '#f2545b');
    } finally {
      iconBtn.disabled = false;
    }
  });

  const container = findOptionsContainer(dialog);
  container.appendChild(host);
  return host;
}

// 找到 dsh web 的原生设置弹窗（含“通用设置”导航的 role=dialog）。
function findSettingsDialog() {
  return [...document.querySelectorAll('[role="dialog"]')].find((d) =>
    [...d.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '通用设置'));
}

// 只在「通用设置」页签注入；其它页签（模型/插件/Agent 预设）不注入。
function isGeneralTabActive(dialog) {
  const cells = [...dialog.querySelectorAll('button')].filter((b) => /nav/i.test(b.className || ''));
  if (cells.length === 0) return true;
  const active = cells.find((b) => /active/i.test(b.className || ''));
  if (!active) return true;
  return (active.textContent || '').trim() === '通用设置';
}

function ensureUpdateCard() {
  const dialog = findSettingsDialog();
  if (!dialog) return;
  if (!isGeneralTabActive(dialog)) {
    // 切到其它页签时移除卡片（避免每个页签都出现）
    const host = dialog.querySelector('[data-dsh-update-card-host]');
    if (host) host.remove();
    return;
  }
  injectUpdateCardInto(dialog);
}

function startObserver() {
  const observer = new MutationObserver(() => ensureUpdateCard());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureUpdateCard();
}

/* ------------------------------------------------------------------ */
/* 主题同步：把内核实际主题（深/浅）报告给主进程，让标题栏等原生 UI 跟随 */
/* ------------------------------------------------------------------ */

function reportTheme() {
  try {
    const isDark = document.body && document.body.hasAttribute('data-ds-dark-theme');
    ipcRenderer.send('shell:theme', isDark === true);
  } catch { /* 页面未就绪时忽略 */ }
}

function startThemeSync() {
  // SPA 渲染完成后报告一次
  reportTheme();
  setTimeout(reportTheme, 1200);
  // 内核切换主题（body 上的 data-ds-dark-theme 属性增删）时实时报告
  if (document.body) {
    const obs = new MutationObserver(() => reportTheme());
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
  }
}

function startAll() {
  startObserver();
  startThemeSync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startAll, { once: true });
} else {
  startAll();
}
