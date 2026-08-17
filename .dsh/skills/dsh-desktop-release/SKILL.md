---
name: dsh-desktop-release
description: 推送、发布、打包与升级 deepseek-harness-desktop（Electron 壳）的完整操作手册。当需要提交推送代码、发布新版本（升版本 → 本地打包校验 → 打 tag → 推送触发 CI）、本地打包校验（npm run dist）、排查自动更新/安装失败（installAndQuit / dsh-install.log）时使用。
whenToUse: 用户要求"推送/发布/打包/升级 deepseek harness desktop"，或涉及版本号 bump、git tag、GitHub Release、electron-builder 打包、安装进度窗、更新双通道判定时。
disable-model-invocation: false
user-invocable: true
---

# 推送 · 发布 · 打包 · 升级 —— deepseek-harness-desktop

本项目是官方 DeepSeek Harness（内核 `@deepseek-ai/dsh`）的 Electron 壳，壳核分离。发布产物是 NSIS 安装包，用户通过应用内自动更新（electron-updater + GitHub Releases）升级。改代码前先读项目根 `AGENTS.md`（含铁律），本技能只讲操作流程。

## 1. 一图流：四件事的关系

```
推送代码        git add/commit/push origin main        （日常）
  ↓
发布新版本      release.cmd <新版本号>                  （升版本→本地打包→commit→tag→push）
  ↓
CI 自动打包     .github/workflows/release.yml           （推 v* tag 触发；签名→Release 上传 latest.yml+exe+blockmap）
  ↓
用户升级        应用内自动更新 → installAndQuit         （下载→杀进程→清注册表→删目录→装新版→重启）
```

## 2. 推送代码（日常）

```powershell
# 本仓库 git 有 dubious ownership 问题：先注入 safe.directory 再跑任何 git 命令
$env:GIT_CONFIG_COUNT="1"
$env:GIT_CONFIG_KEY_0="safe.directory"
$env:GIT_CONFIG_VALUE_0="C:/Users/Administrator/Desktop/deepseek harness"

git add -A
git commit -m "feat: <描述>"
git push origin main
```

- 历史遗留的 `push-upload.cmd` 是本地一次性脚本，已加入 `.gitignore`，**不要**提交它（`release.cmd` 的 `git add -A` 之前差点把它带进仓库）。
- 仓库未跟踪文件先确认归属：`git status` 里出现非预期文件时，先问用户要不要进仓库。

## 3. 发布新版本（核心流程）

**入口：** `release.cmd <新版本号>`（不带参数 = 保持当前版本只重新发布）。它依次做：检查 node sidecar → bump `package.json` 版本 → `npm run dist` 本地打包校验 → `git add -A` + commit `chore: release vX.Y.Z` → 打 tag `vX.Y.Z` → 推送 main + tag。**CI 随后自动打包上传 Release，本地产物只是校验，不上传。**

**发布前清单：**

1. 确认要发布的改动已提交并推送（`git status` 干净、`git log origin/main..HEAD` 为空）。
2. **版本号**：当前最新版本看 `AGENTS.md`"已知边界 #2"的"当前最新发布"；新版本一般 patch 递增（0.1.8 → 0.1.9），功能迭代可用 minor。确认新版本号时给用户推荐值。
3. **顺手更新 `AGENTS.md`**：把"当前最新发布 **vX.Y.Z**"改成新版本号（每次发布都改，AGENTS.md 有明确要求）。
4. **未跟踪文件**：`release.cmd` 用 `git add -A`，会把所有未跟踪文件带进发布 commit —— 发布前先清点 `git status`，不需要进仓库的加 `.gitignore`。

**发布命令（含 safe.directory 注入）：**

```powershell
$env:GIT_CONFIG_COUNT="1"
$env:GIT_CONFIG_KEY_0="safe.directory"
$env:GIT_CONFIG_VALUE_0="C:/Users/Administrator/Desktop/deepseek harness"
cmd /c release.cmd 0.1.9
```

**发布后验证三件事：**

```powershell
git status -sb                                        # 应干净，main 与 origin/main 同步
git log --oneline -3                                  # 应看到 chore: release vX.Y.Z
# 推送成功的权威证据在 release.cmd 输出里：
#   "370806c..xxxxxxx HEAD -> main" + "* [new tag] vX.Y.Z -> vX.Y.Z"
```

- 然后去 GitHub **Actions** 页签等 CI 跑完（产物含 `latest.yml` + 安装包 + blockmap）；应用内自动更新在 Release 发布后即可用。
- 发布动作（打 tag 推远端）不可逆，执行前先跟用户确认版本号。

## 4. 本地打包校验

```powershell
npm run dist        # 或 release.cmd 内部自动跑
```

- 产物在 `dist\`：`DeepSeek Harness Setup <版本>.exe`（NSIS）+ `win-unpacked\`。
- 需要 node sidecar：`node\node.exe`（git 忽略，release.cmd / CI 会自动从系统 node 生成；缺失时 release.cmd 自动补）。
- **受限沙箱坑**：electron-builder 内部要 spawn `app-builder.exe` 并捕获输出，在 workspace-write 沙箱下会 `spawn EPERM`。这是沙箱限制不是代码问题 —— 用 full access 权限重跑同一条命令即可（Agent 工具调用时带上 `sandbox_permissions: danger-full-access` + 说明理由）。
- 国内网络镜像（Electron 二进制约 100MB）：
  `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`；`$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`。

## 5. 升级与安装排障

**更新双通道判定（`shellHasChanges()`）：** 比较源码与安装目录的 main.js、preload.js、assets/icon.ico、icon.png、tray.png、icon.svg 六个文件（**不比** package.json、skills.js）。全同步 → 真实 GitHub 通道（electron-updater）；不同步 → 本地构建通道（`npm run dist` + installAndQuit）。

**安装失败第一现场：** `%TEMP%\dsh-install.log` —— installAndQuit 全程记录 杀进程/清注册表/删目录/安装器退出码，UI 报失败先看它。

**安装包下载缓存：** `%LOCALAPPDATA%\deepseek-harness-desktop-updater\pending\`（应有 `DeepSeek-Harness-Setup-<ver>.exe`）。

**版本验证三件套**（防"以为没更新"误判）：安装目录 `package.json` 的 version / exe 文件版本 FileVersion / HKCU 卸载注册表 DisplayVersion，三者一致才算真装上。

**常见症状速查：**

| 症状 | 正解 |
| --- | --- |
| 安装器退出码 2 / "无法关闭" | 旧卸载器流程被触发；正解是先清注册表再删目录（铁律 #9），不是加等待/重试 |
| 点了更新没反应 | ① 退出后无安装进度窗 = helper 没跑起来（对照铁律 #8 的 spawn 方式）② pending 缓存无安装包 = 下载没完成，与安装无关 |
| 静默安装失败（v0.1.3–v0.1.6 历史根因） | 更新助手禁止 `spawn('powershell.exe',…,{detached:true})`（Windows 下 powershell 启动即死）；必须走 `%TEMP%\dsh-install.ps1`（UTF-8 BOM）+ `.cmd`（CRLF）用 `cmd /c` 非 detached 方式起 |

## 6. 铁律速记（改代码时逐条核对，详见 AGENTS.md）

1. 壳核分离：`@deepseek-ai/dsh` 只做 npm 依赖，绝不 vendor；升级 = 改一行版本号。
2. 必须用标准 node 跑 dsh（打包版优先 `resources/node/node.exe`），禁用 `ELECTRON_RUN_AS_NODE`。
3. spawn dsh 必须带 `--expose-internals`（HMR 插件要求，缺失启动即 crash）。
4. `build.asar = false` 不能改 true（标准 node 读不了 asar）。
5. 单实例锁；关窗 = 隐藏到托盘不退出；退出用 `taskkill /pid <dsh> /T /F` 回收进程树。
6. 更新安装助手唯一允许 `detached:true` 的 spawn 是 exe 图标补丁（spawnExePatch）。
7. `update:quit-install` 只走 installAndQuit 干净静默安装，绝不回退 `quitAndInstall()`。
