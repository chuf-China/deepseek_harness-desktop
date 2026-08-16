'use strict';

/**
 * 技能面板数据服务（壳侧实现，壳核分离铁律：不动内核、零新依赖）。
 *
 * 与内核 `@deepseek-ai/dsh-skill-filesystem` provider 扫描**相同**的技能根目录、
 * 解析 SKILL.md 的 frontmatter；新建/编辑/删除 = 直接读写技能文件。内核用
 * Chokidar 监听这些根，所以面板改动会被当前会话实时感知（输入框 / 补全、
 * 模型技能目录自动刷新），无需重启。
 *
 * 纯逻辑部分（扫描/解析/读写）不依赖 electron，可被普通 node 单测；
 * IPC 注册在 electron 环境里自动进行。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electron = (() => {
  try { return require('electron'); } catch { return {}; }
})();
const ipcMain = electron.ipcMain || null;
const shell = electron.shell || null;

/* ------------------------------------------------------------------ */
/* 根目录解析（与内核 provider rank 对齐）                              */
/* ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function agentsHome() {
  return process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents');
}

// 项目根 = 最近含 .git 的祖先；找不到就用 cwd（与内核 provider 规则一致）。
function projectRoot() {
  let dir = process.cwd();
  try {
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* 忽略 */ }
  return process.cwd();
}

// 返回 [{ key, rank, label, dir }]，仅包含实际存在的根。
function skillRoots() {
  const proj = projectRoot();
  const candidates = [
    { key: 'project-dsh', rank: 100, label: '项目 .dsh/skills', dir: path.join(proj, '.dsh', 'skills') },
    { key: 'project-agents', rank: 200, label: '项目 .agents/skills', dir: path.join(proj, '.agents', 'skills') },
    { key: 'user-dsh', rank: 400, label: '用户 ~/.dsh/skills', dir: path.join(dshHome(), 'skills') },
    { key: 'user-agents', rank: 500, label: '用户 ~/.agents/skills', dir: path.join(agentsHome(), 'skills') },
  ];
  return candidates.filter((r) => {
    try { return fs.existsSync(r.dir); } catch { return false; }
  });
}

// 新建技能默认落点（用户根，rank 400）：面板写操作只动这里，避免写入不可写位置。
function userSkillDir() {
  return path.join(dshHome(), 'skills');
}

/* ------------------------------------------------------------------ */
/* frontmatter 解析（极简，语义对齐内核 README）                        */
/* ------------------------------------------------------------------ */

const BOOL_TRUE = /^(true|yes|on|1)$/i;
const BOOL_FALSE = /^(false|no|off|0)$/i;

function parseBool(v) {
  if (BOOL_TRUE.test(v)) return true;
  if (BOOL_FALSE.test(v)) return false;
  return null; // 非法值
}

/**
 * 解析 `---` 包裹的 frontmatter。
 * 返回 { block, frontmatter, body, hasFrontmatter }：
 *   block          原始 frontmatter 块文本（不含首尾 ---，写回时原样保留）
 *   frontmatter    { key: value }，后续缩进行合并进上一个 key（多行值）
 *   body           frontmatter 之后的正文
 */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { block: '', frontmatter: {}, body: raw, hasFrontmatter: false };
  const block = m[1];
  const fm = {};
  let lastKey = null;
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      fm[lastKey] = kv[2].trim();
    } else if (lastKey && /^\s+\S/.test(line)) {
      fm[lastKey] += '\n' + line.trim(); // 缩进续行合并
    }
    // 其它行（空行、注释）忽略
  }
  return { block, frontmatter: fm, body: raw.slice(m[0].length), hasFrontmatter: true };
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                 */
/* ------------------------------------------------------------------ */

function readSkill(file, root, kind) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { block, frontmatter, body, hasFrontmatter } = parseFrontmatter(raw);
  const name = String(frontmatter.name || '').trim();
  if (!name) return null; // 无 name 的技能按内核规则视为无效条目，展示层忽略

  // 内核规则：camelCase 拼写（disableModelInvocation / userInvocable）被整体拒绝。
  const camelRejected =
    Object.prototype.hasOwnProperty.call(frontmatter, 'disableModelInvocation') ||
    Object.prototype.hasOwnProperty.call(frontmatter, 'userInvocable');

  // 布尔策略字段：非法值 → 内核丢弃整个技能；面板同样标记 invalid（对齐，避免
  // “面板显示但内核不认”）。缺省 = 允许对应表面。
  const dmRaw = frontmatter['disable-model-invocation'];
  const uiRaw = frontmatter['user-invocable'];
  const dm = dmRaw === undefined ? null : parseBool(String(dmRaw));
  const ui = uiRaw === undefined ? null : parseBool(String(uiRaw));
  const invalid = camelRejected || (dmRaw !== undefined && dm === null) || (uiRaw !== undefined && ui === null);

  return {
    name,
    description: frontmatter.description || '',
    whenToUse: frontmatter.whenToUse || '',
    modelInvocable: dm === null ? true : !dm,
    userInvocable: ui === null ? true : ui,
    invalid,
    path: file,
    rootLabel: root.label,
    rootKey: root.key,
    kind, // 'bundle' | 'flat'
    body,
    fullText: hasFrontmatter ? '---\n' + block + '\n---\n\n' + body : raw,
    block,
  };
}

// 扫描全部根，返回按 name 排序的技能列表（同名不同根都列出，展示所属根）。
function scanSkills() {
  const out = [];
  for (const root of skillRoots()) {
    let entries;
    try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // 跳过 .system 等隐藏目录
      const p = path.join(root.dir, ent.name);
      let file = null;
      let kind = null;
      if (ent.isDirectory()) {
        const sk = path.join(p, 'SKILL.md');
        if (fs.existsSync(sk)) { file = sk; kind = 'bundle'; }
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        file = p;
        kind = 'flat';
      }
      if (!file) continue;
      const item = readSkill(file, root, kind);
      if (item) out.push(item);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function findSkillByName(name) {
  for (const s of scanSkills()) if (s.name === name) return s;
  return null;
}

/* ------------------------------------------------------------------ */
/* 写操作（新建/编辑/删除）                                             */
/* ------------------------------------------------------------------ */

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const NAME_RESERVED = new Set(['runtime']);

function validName(name) {
  return (
    typeof name === 'string' &&
    NAME_RE.test(name) &&
    name.length <= NAME_MAX &&
    !NAME_RESERVED.has(name)
  );
}

function buildSkillFile(name, body) {
  const head =
    '---\n' +
    `name: ${name}\n` +
    'description: 用一句话说明这个技能的用途（会出现在 / 补全和模型技能目录里）\n' +
    'whenToUse: 在什么情况下模型应该主动调用这个技能\n' +
    '# disable-model-invocation: false   # true = 模型目录不出现，仅 / 手动调用\n' +
    '# user-invocable: true              # false = 仅模型可调用，/ 补全不出现\n' +
    '---\n\n';
  const b = String(body || '').trim();
  return head + (b || '# 技能正文\n\n在这里写具体的操作指引（skill 工具会把全文注入给模型）。\n');
}

// 新建：默认落用户根 <DSH_HOME>/skills/<name>/SKILL.md（bundle 格式）。
function createSkill(name, body) {
  if (!validName(name)) {
    return { ok: false, error: '技能名须为 kebab-case（小写字母/数字/连字符，≤64 字符），且不能是保留名 runtime' };
  }
  const dir = path.join(userSkillDir(), name);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) || fs.existsSync(dir)) {
    return { ok: false, error: '同名技能已存在：' + name };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 整文件模式：body 以 --- 开头（面板发完整 SKILL.md）→ 原样写入；
    // 否则按纯正文走模板（buildSkillFile）。
    const content = String(body || '').trimStart().startsWith('---')
      ? String(body || '')
      : buildSkillFile(name, body);
    fs.writeFileSync(file, content, 'utf8');
  } catch (e) {
    return { ok: false, error: '写入失败：' + e.message };
  }
  return { ok: true, path: file };
}

// 编辑：面板发整文件（含 frontmatter）→ 原样写回；发纯正文 → 保留原 frontmatter 只换正文。
function updateSkill(name, body) {
  const item = findSkillByName(name);
  if (!item) return { ok: false, error: '未找到技能：' + name };
  try {
    const incoming = String(body || '');
    const parsed = parseFrontmatter(incoming);
    let content;
    if (parsed.hasFrontmatter) {
      content = incoming; // 整文件模式：原样写回（面板编辑框发完整 SKILL.md）
    } else {
      const oldRaw = fs.readFileSync(item.path, 'utf8');
      const old = parseFrontmatter(oldRaw);
      content = old.hasFrontmatter
        ? '---\n' + old.block + '\n---\n\n' + incoming
        : incoming;
    }
    fs.writeFileSync(item.path, content, 'utf8');
  } catch (e) {
    return { ok: false, error: '写入失败：' + e.message };
  }
  return { ok: true, path: item.path };
}

// 删除：bundle 删整个目录，flat 删文件。
function deleteSkill(name) {
  const item = findSkillByName(name);
  if (!item) return { ok: false, error: '未找到技能：' + name };
  try {
    if (item.kind === 'bundle') {
      fs.rmSync(path.dirname(item.path), { recursive: true, force: true });
    } else {
      fs.rmSync(item.path, { force: true });
    }
  } catch (e) {
    return { ok: false, error: '删除失败：' + e.message };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* IPC（electron 环境下自动注册）                                       */
/* ------------------------------------------------------------------ */

function registerSkillsIpc() {
  ipcMain.handle('skills:list', () => {
    try {
      return {
        ok: true,
        skills: scanSkills(),
        roots: skillRoots().map((r) => ({ label: r.label, dir: r.dir })),
        userSkillDir: userSkillDir(),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('skills:create', (_e, name, body) => createSkill(name, body));
  ipcMain.handle('skills:update', (_e, name, body) => updateSkill(name, body));
  ipcMain.handle('skills:delete', (_e, name) => deleteSkill(name));
  ipcMain.handle('skills:open-folder', (_e, name) => {
    const item = findSkillByName(name);
    if (!item) return { ok: false, error: '未找到技能：' + name };
    try {
      shell.showItemInFolder(item.path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '打开文件夹失败：' + e.message };
    }
  });
}

if (ipcMain && typeof ipcMain.handle === 'function') {
  registerSkillsIpc();
}

module.exports = {
  dshHome,
  agentsHome,
  projectRoot,
  skillRoots,
  userSkillDir,
  parseFrontmatter,
  parseBool,
  scanSkills,
  findSkillByName,
  createSkill,
  updateSkill,
  deleteSkill,
  validName,
};
