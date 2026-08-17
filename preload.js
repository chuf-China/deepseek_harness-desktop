'use strict';

/**
 * preload：注入到 dsh 的 web 页面的桥 + 原生设置弹窗注入。
 *
 * 1. 通过 contextBridge 暴露 __DSH_DESKTOP__（与 dsh 自己的 __DSH_BOOT__ 不冲突），
 *    提供更新/图标等原生能力。
 * 2. 用 MutationObserver 监听 DOM，在 dsh web 原生设置弹窗的左侧导航里增加一个
 *    「技能」分区，把技能卡片放到这个分区里；右侧内容区展示技能库。
 *    更新卡片仍留在「通用设置」里，不和技能卡片混在一起。
 *    颜色从弹窗计算样式动态取值，自动跟随浅色/深色主题，不破坏原生结构
 *    （壳核分离，不动内核代码）。
 */

const { contextBridge, ipcRenderer } = require('electron');

// skills:* IPC 薄封装：contextBridge 暴露给主世界一份，技能卡片（跑在 preload
// 隔离世界，window.__DSH_DESKTOP__ 不可见）复用同一份，避免两处重复定义。
const skillsApi = {
  list: () => ipcRenderer.invoke('skills:list'),
  create: (name, body) => ipcRenderer.invoke('skills:create', name, body),
  update: (name, body) => ipcRenderer.invoke('skills:update', name, body),
  delete: (name) => ipcRenderer.invoke('skills:delete', name),
  openFolder: (name) => ipcRenderer.invoke('skills:open-folder', name),
};

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
    skills: skillsApi,
    onUpdateLog: (cb) => {
      const listener = (_event, msg) => cb(msg);
      ipcRenderer.on('settings:update-log', listener);
      return () => ipcRenderer.removeListener('settings:update-log', listener);
    },
  }),
);

/* ------------------------------------------------------------------ */
/* 原生设置弹窗注入「技能」侧边分区 + 技能卡片                            */
/* ------------------------------------------------------------------ */

// 更新日志订阅（跨注入复用，避免 tab 切换重注入时重复监听）
let updateLogListener = null;

// 原生设置弹窗里由 dsh 自己渲染的 options 容器（导航右侧的内容区）。
function findOptionsContainer(dialog) {
  const nav = dialog.querySelector('nav');
  const children = [...dialog.children];
  const content = children.find((c) => c !== nav);
  if (!content) return dialog;
  const options = [...content.children].find((c) => /options/i.test(typeof c.className === 'string' ? c.className : '')) || content;
  return options;
}

// 原生设置弹窗的内容根（nav 之外的 content 容器）。
function findContentContainer(dialog) {
  const nav = dialog.querySelector('nav');
  const children = [...dialog.children];
  return children.find((c) => c !== nav) || dialog;
}

// 原生设置弹窗的左侧导航列表。
function findNavList(dialog) {
  const nav = dialog.querySelector('nav');
  if (!nav) return null;
  return [...nav.children].find((el) => /navList/i.test(typeof el.className === 'string' ? el.className : '')) || nav;
}

// 技能分区是否处于激活状态。
function isSkillsActive(dialog) {
  return dialog.hasAttribute('data-dsh-skills-active');
}

// 同步左侧导航的高亮：激活技能分区时取消原生项的高亮，否则取消技能项高亮。
function syncSkillsNavState(dialog, active) {
  const navList = findNavList(dialog);
  if (!navList) return;
  const skills = navList.querySelector('[data-dsh-skills-nav]');

  if (active && skills) {
    // 先记下当前原生 active 类，再清掉原生高亮并把它给技能项。
    const activeClass = [...navList.querySelectorAll('button')]
      .map((b) => [...b.classList].find((c) => /active/i.test(c)))
      .find(Boolean);
    if (activeClass) skills.classList.add(activeClass);
    skills.setAttribute('aria-current', 'true');

    for (const button of navList.querySelectorAll('button:not([data-dsh-skills-nav])')) {
      const cls = [...button.classList].find((c) => /active/i.test(c));
      if (cls) button.classList.remove(cls);
      button.removeAttribute('aria-current');
    }
  } else if (skills) {
    const cls = [...skills.classList].find((c) => /active/i.test(c));
    if (cls) skills.classList.remove(cls);
    skills.removeAttribute('aria-current');
  }
}

// 在设置弹窗左侧导航加入「技能」入口（只加一次，React 重渲染后由 observer 补回）。
function ensureSkillsNav(dialog) {
  const navList = findNavList(dialog);
  if (!navList || dialog.querySelector('[data-dsh-skills-nav]')) return;

  const template = navList.querySelector('button');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-dsh-skills-nav', '');
  if (template) {
    // 沿用内核 nav 按钮的样式类，但不继承 active。
    button.className = template.className.split(/\s+/)
      .filter((c) => !/active/i.test(c))
      .join(' ');
    const icon = template.querySelector('[class*="navIcon"]');
    if (icon) button.appendChild(icon.cloneNode(true));
    const label = template.querySelector('[class*="navLabel"]');
    const labelSpan = document.createElement('span');
    if (label) labelSpan.className = label.className;
    labelSpan.textContent = '技能';
    button.appendChild(labelSpan);
  } else {
    button.textContent = '技能';
  }

  button.addEventListener('click', () => {
    dialog.setAttribute('data-dsh-skills-active', '');
    syncSkillsNavState(dialog, true);
    ensureCards();
  });
  navList.appendChild(button);
}

// 原生导航项被点击时退出技能分区，回到 dsh 自己的设置页。
function bindNativeNavSwitches(dialog) {
  const navList = findNavList(dialog);
  if (!navList) return;
  for (const button of navList.querySelectorAll('button:not([data-dsh-skills-nav])')) {
    if (button.dataset.dshNavBound) continue;
    button.dataset.dshNavBound = '1';
    button.addEventListener('click', () => {
      if (!isSkillsActive(dialog)) return;
      dialog.removeAttribute('data-dsh-skills-active');
      syncSkillsNavState(dialog, false);
      ensureCards();
    });
  }
}

// 技能分区的内容容器：右侧展示技能库（技能卡片）。
function ensureSkillsSection(dialog) {
  if (dialog.querySelector('[data-dsh-skills-section-host]')) return;
  const content = findContentContainer(dialog);
  const host = document.createElement('div');
  host.setAttribute('data-dsh-skills-section-host', '');
  host.hidden = true;
  host.style.cssText = 'flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto;';
  content.appendChild(host);
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

function injectUpdateCardInto(dialog, container) {
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

  (container || findOptionsContainer(dialog)).appendChild(host);
  return host;
}

// 找到 dsh web 的原生设置弹窗（含“通用设置”导航的 role=dialog）。
function findSettingsDialog() {
  return [...document.querySelectorAll('[role="dialog"]')].find((d) =>
    [...d.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '通用设置'));
}

// 技能分区激活时隐藏 dsh 原生 options，右侧展示技能库；
// 其它页签则隐藏技能分区并恢复原生 options。
function syncSkillsVisibility(dialog, active) {
  const nativeOptions = findOptionsContainer(dialog);
  const content = findContentContainer(dialog);
  // 只在确实存在独立 options 容器时隐藏它；万一内核结构变化，不能把 content 一起藏掉。
  if (nativeOptions && nativeOptions !== content) nativeOptions.hidden = active;

  const skills = dialog.querySelector('[data-dsh-skills-section-host]');
  if (skills) skills.hidden = !active;
}

// 是否正停留在 dsh 的「通用设置」页签。
function isGeneralTabActive(dialog) {
  const cells = [...dialog.querySelectorAll('button')].filter((b) => /nav/i.test(b.className || ''));
  if (cells.length === 0) return true;
  const active = cells.find((b) => /active/i.test(b.className || ''));
  if (!active) return true;
  return (active.textContent || '').trim() === '通用设置';
}

function ensureCards() {
  const dialog = findSettingsDialog();
  if (!dialog) return;

  // 无论当前在哪个页签，都要保证左侧导航里有「技能」入口，并让原生导航点击能退出。
  ensureSkillsNav(dialog);
  ensureSkillsSection(dialog);
  bindNativeNavSwitches(dialog);

  const active = isSkillsActive(dialog);
  syncSkillsNavState(dialog, active);
  syncSkillsVisibility(dialog, active);

  if (active) {
    // 技能库：只放技能卡片，更新卡片不混进来。
    const u = dialog.querySelector('[data-dsh-update-card-host]');
    if (u) u.remove();
    const skills = dialog.querySelector('[data-dsh-skills-section-host]');
    if (!skills) return;
    injectSkillsCardInto(dialog, skills);
    return;
  }

  // 非技能分区：隐藏/移除技能卡片，恢复 dsh 原生设置内容。
  const s = dialog.querySelector('[data-dsh-skills-card-host]');
  if (s) s.remove();
  const skills = dialog.querySelector('[data-dsh-skills-section-host]');
  if (skills) skills.hidden = true;

  if (isGeneralTabActive(dialog)) {
    injectUpdateCardInto(dialog, findOptionsContainer(dialog));
  } else {
    const u = dialog.querySelector('[data-dsh-update-card-host]');
    if (u) u.remove();
  }
}

function startObserver() {
  const observer = new MutationObserver(() => ensureCards());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureCards();
}

/* ------------------------------------------------------------------ */
/* 原生设置弹窗注入「技能」卡片（壳侧管理 dsh 技能文件）                  */
/* 数据走 __DSH_DESKTOP__.skills（skills.js 的 skills:* IPC），扫描/读写  */
/* 技能文件由主进程完成；内核 Chokidar 监听技能根，改动实时生效。          */
/* ------------------------------------------------------------------ */

function skillsCardStyle() {
  return `
:host { display: block; }
.skills { margin-top: 4px; }
.skills .toolbar { display: flex; gap: 8px; align-items: center; margin: 8px 0 2px; }
.skills .toolbar .hint { flex: auto; font-size: 12px; color: color-mix(in srgb, currentColor 55%, transparent); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills .group-header { display: flex; align-items: center; gap: 8px; cursor: pointer; margin: 18px 0 2px; padding: 2px 0; user-select: none; }
.skills .group-title { font-size: 13px; font-weight: 600; color: color-mix(in srgb, currentColor 62%, transparent); flex: none; }
.skills .group-header:hover .group-title { color: currentColor; }
.skills .group-count { font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 999px; flex: none; background: color-mix(in srgb, currentColor 10%, transparent); color: color-mix(in srgb, currentColor 60%, transparent); }
.skills .group-chevron { margin-left: auto; font-size: 12px; color: color-mix(in srgb, currentColor 45%, transparent); transition: transform .15s ease; }
.skills .group-header.collapsed .group-chevron { transform: rotate(-90deg); }
.skills .group-empty { margin: 4px 0 12px; padding: 8px 12px; border: 1px dashed color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; font-size: 12px; line-height: 18px; color: color-mix(in srgb, currentColor 55%, transparent); }
.skills .skill {
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 12px; padding: 8px 10px; margin: 6px 0;
  background: color-mix(in srgb, currentColor 4%, transparent);
  animation: dsh-skill-in .18s ease both;
}
@keyframes dsh-skill-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.skills .skill.invalid { border-color: color-mix(in srgb, #f2545b 60%, transparent); }
.skills .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.skills .name { font-weight: 600; font-size: 14px; color: currentColor; flex: none; }
.skills .badge {
  font-size: 11px; padding: 1px 8px; border-radius: 999px; flex: none;
  background: color-mix(in srgb, #4d6bfe 16%, transparent);
  color: color-mix(in srgb, currentColor 85%, transparent);
}
.skills .badge.none { background: color-mix(in srgb, currentColor 10%, transparent); color: color-mix(in srgb, currentColor 55%, transparent); }
.skills .root { font-size: 11px; color: color-mix(in srgb, currentColor 50%, transparent); flex: none; }
.skills .spacer { flex: auto; }
.skills .mini {
  appearance: none; border: 0; border-radius: 10px; height: 26px; padding: 0 10px;
  font-size: 12px; cursor: pointer; flex: none;
  background: color-mix(in srgb, currentColor 10%, transparent); color: currentColor;
}
.skills .mini:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
.skills .mini.danger { color: #f2545b; }
.skills .desc { font-size: 12.5px; color: color-mix(in srgb, currentColor 70%, transparent); margin-top: 4px; }
.skills .when { font-size: 12px; color: color-mix(in srgb, currentColor 52%, transparent); margin-top: 2px; }
.skills .invalid-note { font-size: 12px; color: #f2545b; margin-top: 4px; }
.skills .body {
  margin-top: 6px; padding: 8px 10px; border-radius: 10px; max-height: 180px; overflow: auto;
  background: color-mix(in srgb, currentColor 6%, transparent);
  font-family: Consolas, "SF Mono", monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all;
  color: color-mix(in srgb, currentColor 78%, transparent);
}
.skills .form { margin: 8px 0 4px; padding: 8px 10px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; }
.skills .form label { display: block; font-size: 12px; color: color-mix(in srgb, currentColor 60%, transparent); margin: 8px 0 4px; }
.skills textarea {
  width: 100%; box-sizing: border-box; min-height: 140px; resize: vertical;
  background: color-mix(in srgb, currentColor 12%, transparent);
  color: currentColor; border: 0; border-radius: 12px; padding: 10px 12px;
  font-family: Consolas, "SF Mono", monospace; font-size: 12.5px; line-height: 1.5;
}
.skills textarea:focus { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #4d6bfe 55%, transparent); }
.skills input[type="text"] {
  width: 100%; box-sizing: border-box;
  background: color-mix(in srgb, currentColor 12%, transparent);
  color: currentColor; border: 0; border-radius: 18px; height: 36px; padding: 0 14px; font-size: 14px;
}
.skills input[type="text"]:focus { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #4d6bfe 55%, transparent); }
.skills .err { font-size: 12.5px; color: #f2545b; margin-top: 6px; }
.skills .ok { font-size: 12.5px; color: #34c98e; margin-top: 6px; }
.skills .empty { font-size: 13px; color: color-mix(in srgb, currentColor 55%, transparent); padding: 12px 0; }
`;
}

// 新建技能时预填的完整 SKILL.md 模板（整文件模式；主进程 buildSkillFile 是
// 纯正文模式的模板，两者并存——body 以 --- 开头时主进程按整文件原样写入）。
function skillsTemplate(name) {
  return '---\n' +
    'name: ' + name + '\n' +
    'description: 用一句话说明这个技能的用途（会出现在 / 补全和模型技能目录里）\n' +
    'whenToUse: 在什么情况下模型应该主动调用这个技能\n' +
    '# disable-model-invocation: false   # true = 模型目录不出现，仅 / 手动调用\n' +
    '# user-invocable: true              # false = 仅模型可调用，/ 补全不出现\n' +
    '---\n\n' +
    '# 技能正文\n\n在这里写具体的操作指引（skill 工具会把全文注入给模型）。\n';
}

function injectSkillsCardInto(dialog, container) {
  if (dialog.querySelector('[data-dsh-skills-card-host]')) return null;

  const host = document.createElement('div');
  host.setAttribute('data-dsh-skills-card-host', '');
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = cardStyle() + skillsCardStyle();
  shadow.appendChild(style);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div class="card">
  <h4>技能</h4>
  <p class="sub">管理 dsh 技能（SKILL.md 文件）——改动会被当前会话实时感知，无需重启</p>
  <div class="skills">
    <div class="toolbar">
      <span class="hint" data-hint>加载中…</span>
      <button type="button" class="ghost" data-refresh>刷新</button>
      <button type="button" class="primary" data-new>+ 新建技能</button>
    </div>
    <div data-form-wrap></div>
    <div data-list></div>
    <div class="log" data-log></div>
  </div>
</div>`;
  shadow.appendChild(wrap);

  const q = (sel) => shadow.querySelector(sel);
  const hintEl = q('[data-hint]');
  const listEl = q('[data-list]');
  const formWrap = q('[data-form-wrap]');
  const refreshBtn = q('[data-refresh]');
  const newBtn = q('[data-new]');
  const logEl = q('[data-log]');
  // 注意：卡片代码运行在 preload 隔离世界，window.__DSH_DESKTOP__（contextBridge
  // 暴露给主世界）在这里不可见，必须直接用本作用域的 ipcRenderer。
  // 复用顶部统一的 skills:* IPC 封装（本作用域可直接访问，无需走 window 桥）
  const skills = skillsApi;

  let skillsData = null;
  let listVersion = 0; // 防止快速连续刷新时旧响应覆盖新响应
  const collapsedGroups = {}; // 分组折叠状态：{ global?: boolean, project?: boolean, preset?: boolean }

  const appendLog = (msg, color) => {
    logEl.classList.add('show');
    const line = document.createElement('div');
    line.textContent = msg;
    if (color) line.style.color = color;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function badgeOf(s) {
    if (s.invalid) return { text: '策略异常', cls: 'none' };
    const m = s.modelInvocable;
    const u = s.userInvocable;
    if (m && u) return { text: '模型+用户', cls: '' };
    if (m) return { text: '仅模型', cls: '' };
    if (u) return { text: '仅用户', cls: '' };
    return { text: '已禁用', cls: 'none' };
  }

  function groupOf(s) {
    if (s.rootKey && s.rootKey.startsWith('project-')) return 'project';
    if (s.rootKey && s.rootKey.startsWith('preset-')) return 'preset';
    return 'global';
  }

  function renderList() {
    listEl.textContent = '';
    if (!skillsData || skillsData.skills.length === 0) {
      listEl.appendChild(el('div', 'empty', '暂无技能——点右上角「+ 新建技能」创建第一个。'));
      return;
    }

    const groups = [
      {
        id: 'global',
        title: '全局技能',
        empty: '还没有全局技能。点右上角「+ 新建技能」创建后，会放到 ~/.dsh/skills。',
      },
      {
        id: 'project',
        title: '项目技能',
        empty: '当前项目还没有技能。可在项目的 .dsh/skills 或 .agents/skills 下手动添加。',
      },
      {
        id: 'preset',
        title: '预设技能',
        empty: '当前没有预设技能。',
      },
    ];
    const byGroup = { global: [], project: [], preset: [] };
    for (const s of skillsData.skills) byGroup[groupOf(s)].push(s);

    for (const group of groups) {
      const items = byGroup[group.id];
      const collapsed = collapsedGroups[group.id] === true;
      const header = el('div', 'group-header' + (collapsed ? ' collapsed' : ''));
      header.appendChild(el('span', 'group-title', group.title));
      header.appendChild(el('span', 'group-count', String(items.length)));
      header.appendChild(el('span', 'group-chevron', '▾'));
      header.addEventListener('click', () => {
        collapsedGroups[group.id] = !collapsed;
        renderList();
      });
      listEl.appendChild(header);

      if (items.length === 0) {
        listEl.appendChild(el('div', 'group-empty', group.empty));
        continue;
      }
      if (collapsed) continue;
      for (const s of items) renderItem(s);
    }
  }

  function renderItem(s) {
    const row = el('div', 'skill' + (s.invalid ? ' invalid' : ''));
    const head = el('div', 'head');
    head.appendChild(el('span', 'name', s.name));
    const b = badgeOf(s);
    head.appendChild(el('span', 'badge' + (b.cls ? ' ' + b.cls : ''), b.text));
    head.appendChild(el('span', 'root', s.rootLabel));
    head.appendChild(el('span', 'spacer'));
    const openBtn = el('button', 'mini', '打开');
    openBtn.type = 'button';
    const editBtn = el('button', 'mini', '编辑');
    editBtn.type = 'button';
    const delBtn = el('button', 'mini danger', '删除');
    delBtn.type = 'button';
    head.appendChild(openBtn);
    if (!s.readonly) {
      head.appendChild(editBtn);
      head.appendChild(delBtn);
    }
    row.appendChild(head);

    if (s.description) row.appendChild(el('div', 'desc', s.description));
    if (s.whenToUse) row.appendChild(el('div', 'when', '适用：' + s.whenToUse));
    if (s.invalid) row.appendChild(el('div', 'invalid-note', '⚠ frontmatter 策略字段非法，内核会忽略此技能——请用「编辑」修正。'));

    const bodyPre = el('pre', 'body', (s.fullText || s.body) ? (s.fullText || s.body) : '（正文为空）');
    bodyPre.hidden = true;
    row.appendChild(bodyPre);

    // 编辑表单：整文件编辑（frontmatter + 正文），保存后主进程原样 round-trip 写回。
    const editBox = el('div', 'form');
    editBox.hidden = true;
    editBox.appendChild(el('label', '', '编辑 SKILL.md（含 frontmatter，保存后实时生效）'));
    const ta = document.createElement('textarea');
    ta.value = s.fullText || s.body || '';
    editBox.appendChild(ta);
    const editErr = el('div', 'err');
    editErr.hidden = true;
    editBox.appendChild(editErr);
    const editRow = el('div', 'row');
    const saveBtn = el('button', 'primary', '保存');
    saveBtn.type = 'button';
    const cancelBtn = el('button', 'ghost', '取消');
    cancelBtn.type = 'button';
    editRow.appendChild(saveBtn);
    editRow.appendChild(cancelBtn);
    editBox.appendChild(editRow);
    row.appendChild(editBox);

    // 标题行点击展开/收起正文预览
    head.style.cursor = 'pointer';
    const toggleBody = () => {
      bodyPre.hidden = !bodyPre.hidden;
      if (!bodyPre.hidden) editBox.hidden = true;
    };
    head.addEventListener('click', (e) => {
      if (e.target === openBtn || e.target === editBtn || e.target === delBtn) return;
      toggleBody();
    });

    openBtn.addEventListener('click', () => {
      skills.openFolder(s.name).then((r) => {
        if (r && !r.ok) appendLog('[ERR] ' + (r.error || '打开失败'), '#f2545b');
      });
    });

    editBtn.addEventListener('click', () => {
      editBox.hidden = !editBox.hidden;
      if (!editBox.hidden) { bodyPre.hidden = true; editErr.hidden = true; ta.focus(); }
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      editErr.hidden = true;
      const r = await skills.update(s.name, ta.value);
      if (r && r.ok) {
        appendLog('[OK] 已保存：' + s.name, '#34c98e');
        editBox.hidden = true;
        await reload();
      } else {
        editErr.textContent = (r && r.error) || '保存失败';
        editErr.hidden = false;
      }
      saveBtn.disabled = false;
    });

    cancelBtn.addEventListener('click', () => { editBox.hidden = true; });

    // 删除：二次确认（按钮变「确认删除?」，3 秒内再点才执行）
    let delArmed = false;
    delBtn.addEventListener('click', async () => {
      if (!delArmed) {
        delArmed = true;
        delBtn.textContent = '确认删除?';
        setTimeout(() => { delArmed = false; delBtn.textContent = '删除'; }, 3000);
        return;
      }
      const r = await skills.delete(s.name);
      if (r && r.ok) {
        appendLog('[OK] 已删除：' + s.name, '#34c98e');
        await reload();
      } else {
        appendLog('[ERR] ' + ((r && r.error) || '删除失败'), '#f2545b');
      }
    });

    listEl.appendChild(row);
  }

  function renderNewForm() {
    formWrap.textContent = '';
    const form = el('div', 'form');
    form.appendChild(el('label', '', '技能名（kebab-case，如 my-skill）'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'my-skill';
    form.appendChild(nameInput);
    form.appendChild(el('label', '', 'SKILL.md 内容（frontmatter + 正文，可改描述/适用时机/策略）'));
    const ta = document.createElement('textarea');
    ta.value = skillsTemplate('my-skill');
    form.appendChild(ta);
    const err = el('div', 'err');
    err.hidden = true;
    form.appendChild(err);
    const row = el('div', 'row');
    const createBtn = el('button', 'primary', '创建');
    createBtn.type = 'button';
    const cancelBtn = el('button', 'ghost', '取消');
    cancelBtn.type = 'button';
    row.appendChild(createBtn);
    row.appendChild(cancelBtn);
    form.appendChild(row);
    formWrap.appendChild(form);

    cancelBtn.addEventListener('click', () => { formWrap.textContent = ''; });
    createBtn.addEventListener('click', async () => {
      const name = (nameInput.value || '').trim();
      if (!name) { err.textContent = '请填写技能名'; err.hidden = false; return; }
      createBtn.disabled = true;
      err.hidden = true;
      const r = await skills.create(name, ta.value);
      if (r && r.ok) {
        appendLog('[OK] 已创建：' + name, '#34c98e');
        formWrap.textContent = '';
        await reload();
      } else {
        err.textContent = (r && r.error) || '创建失败';
        err.hidden = false;
        createBtn.disabled = false;
      }
    });
    nameInput.focus();
  }

  async function reload() {
    const v = ++listVersion;
    try {
      const r = await skills.list();
      if (v !== listVersion) return; // 已被更新的刷新取代
      if (r && r.ok) {
        skillsData = r;
        const n = (r.skills || []).length;
        hintEl.textContent =
          (n ? n + ' 个技能' : '暂无技能') +
          ' · 新技能创建于 ' + (r.userSkillDir || '');
        renderList();
      } else {
        hintEl.textContent = '加载失败';
        appendLog('[ERR] ' + ((r && r.error) || '技能列表加载失败'), '#f2545b');
      }
    } catch (e) {
      if (v === listVersion) {
        hintEl.textContent = '加载失败';
        appendLog('[ERR] ' + (e && e.message ? e.message : String(e)), '#f2545b');
      }
    }
  }

  refreshBtn.addEventListener('click', () => reload());
  newBtn.addEventListener('click', renderNewForm);

  reload();

  (container || findOptionsContainer(dialog)).appendChild(host);
  return host;
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
