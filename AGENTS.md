# AGENTS.md — DeepSeek Harness 桌面壳

本文件是给 AI 代理（agent）的工程上下文与硬性约束。dsh 的
`dsh-agent-instructions` 插件会在每次会话中自动加载它。改代码前先读，改完别破坏
下面的"铁律"。

## 这是什么项目

`deepseek-harness-desktop`：把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（内核 `@deepseek-ai/dsh`）包装成可双击启动的桌面应用的 **Electron 壳**。

**设计铁律：壳核分离。** 本仓库只有壳——负责启动/回收 dsh 子进程、开窗口指向它
起的本地 web UI、系统托盘、退出时回收整棵进程树。内核是 npm 依赖，**绝不 fork /
vendor**；上游更新就改一行版本号。

## 架构（一句话版）

```
main.js (Electron 主进程)
  ├─ findFreePort() 找空闲端口
  ├─ launchDsh()：spawn 标准 node（优先捆绑 resources/node/node.exe，回退系统 node）
  │    --expose-internals <dsh bin> web --port <N> → waitForReady() 探测 HTTP 就绪
  ├─ BrowserWindow → http://127.0.0.1:<N>/   （不内嵌 UI，壳核分离）
  ├─ Tray 托盘：关窗=隐藏不退出；托盘菜单 显示/开机自启/退出
  ├─ 开机自启：托盘勾选 → 直接写 HKCU\...\Run（reg.exe，带引号 + --hidden +
  │    --project "<本地源码项目>"）；--hidden 启动 = 静默到托盘不弹窗（不用
  │    electron setLoginItemSettings，它写的值不带引号，exe 路径含空格时开机启动
  │    会被截断）；--project 让自启进程启动早期 chdir 回项目根（自启 cwd 由
  │    Windows 决定不可控），壳侧面板"项目技能"分组在自启场景下同样可见
  ├─ dsh 崩溃自动重启：exit 且非主动退出 → handleDshCrash() 退避重试（1s~5s，
  │    最多 5 次；连续稳定 30s 后重置计数；超限弹框退出）；托盘气泡提示；
  │    waitForReady 用 isDead 回调感知"就绪前崩溃"避免双重重启
  ├─ skills.js：技能面板数据服务（壳侧）——扫描与内核 dsh-skill-filesystem 相同的
  │    技能根目录、读写 SKILL.md，注册 skills:* IPC；preload 在设置弹窗左侧「技能」分区注入技能卡片（右侧技能库）
  │    更新卡片仍留在「通用设置」；内核 Chokidar 监听技能根，面板改动被会话实时感知
  ├─ 更新（双通道）：
  │    ├─ 真实通道：electron-updater（build.publish → GitHub Releases latest.yml）；
  │    │    update:quit-install → findDownloadedInstaller()（扫 updater 缓存兜底，
  │    │    不依赖 update-downloaded 事件时序）→ installAndQuit()
  │    ├─ 本地/开发通道：shellHasChanges()=true（源码与安装目录不同步）→
  │    │    npm run dist → installAndQuit()
  │    └─ installAndQuit()：杀进程 → 清注册表 → 删目录(3 段兜底) → 静默装新 →
  │         重启；起 %TEMP%\dsh-install.ps1（UTF-8 BOM）+ .cmd（CRLF）执行，
  │         WinForms 进度窗（v0.1.8），成败按安装器退出码判定（详见铁律 #8/#9）
  ├─ 退出时 exe 图标补丁：spawnExePatch（全文件唯一允许 detached:true 的 spawn）
  ├─ IPC 安全：执行类 IPC（settings:* / update:* / skills:*）先过 isTrustedSender
  │    校验（只接受主窗口 127.0.0.1/localhost 页面）；项目目录由配置决定，渲染层不传路径
  └─ 退出：Windows 用 taskkill /pid <dsh> /T /F 回收整棵子进程树
```

## 铁律（不可破坏的约束，改代码时逐条核对）

1. **壳核分离，内核不 vendor**：`@deepseek-ai/dsh` 只作为 npm 依赖存在（当前锁定
   `0.1.0-rc.7`，**精确版本、无范围前缀**，锁定期望由 package.json + lockfile 双重
   保证；caret 范围会静默允许 0.1.x 稳定版，不要用），绝不把内核代码拷进本仓库。
   升级 = 改 `package.json` 版本号。
2. **必须用标准 node 跑 dsh（优先捆绑的 sidecar）**：dsh 的 native 依赖
   （node-pty / koffi）按标准 node ABI 编译，Electron 内置 node 的 ABI 不匹配，
   **不要用 `ELECTRON_RUN_AS_NODE`**。`findNode()`：打包版优先
   `resources/node/node.exe`（随包分发的标准 node），其次 `DSH_NODE` 环境变量，
   最后回退系统 `node`（PATH）。开发模式（`electron .`）走系统 node。
3. **spawn 时必须带 `--expose-internals`**：dsh 的 HMR 插件
   （`cordis-plugin-hmr`）加载时要求该标志，缺失会在启动阶段直接 crash。
4. **`build.asar = false`**：dsh 是 npm 依赖、壳用标准 node spawn 它，而 asar 是
   Electron 私有的虚拟文件系统、标准 node 读不了。改成 true 会破坏打包版。
5. **单实例锁**：`app.requestSingleInstanceLock()`，重复启动要聚焦已有窗口
   （`second-instance` → `showMainWindow`），不能开第二个 dsh。
6. **关窗 ≠ 退出**：`close` 事件被 `preventDefault()` 转成隐藏到托盘；真正退出只能
   走托盘"退出"或 `app.quit()`。`before-quit` 里先 `stopDsh()` 再 `app.quit()`。
7. **退出必须回收 dsh 子进程树**：Windows 用 `taskkill /pid <pid> /T /F`（主进程
   exit 后 dsh 不会自己死）。区分"主动退出"（`quitting=true`）和"dsh 自己崩了"
   （自动重启，见架构图；重启超限才弹错误框）。
8. **更新安装助手禁止 `spawn('powershell.exe', …, {detached:true})`**：Windows 下
   powershell 启动即死（PowerShell 事件日志只有 40961"正在启动"、永远没有 40962
   "已准备好"）——这是 v0.1.3–v0.1.6 全部"静默安装失败"的根因。必须：把安装脚本
   写 `%TEMP%\dsh-install.ps1`（**UTF-8 BOM**，中文 UI 文本在 PowerShell 5.1 下
   才不会乱码；`-Command` 多行会被 cmdline 解析打散，必须用
   `-File`）+ `%TEMP%\dsh-install.cmd`（**CRLF**，内容
   `start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<ps1>"`），
   用 `spawn('cmd.exe', ['/c', cmdPath], {stdio:'ignore', windowsHide:true})` 起
   （**不 detached**，`cmd /c start` 已实现脱离父进程且能跑完）。**全文件唯一允许
   `detached:true` 的 spawn 是 exe 图标补丁**（`spawnExePatch`，退出后独立完成，
   别把这条经验扩散到别处）。助手脚本本体在 `assets/install-helper.ps1`（可读可查、
   可单独语法检查），参数一律走环境变量（DSH_INSTALLER/DSH_DIR/DSH_NEWEXE/DSH_LOG），
   **不要退回在 main.js 里拼字符串内联**——引号转义出错会把关键更新路径搞坏。
9. **`update:quit-install` 只走 `installAndQuit` 干净状态静默安装**，绝不回退
   `autoUpdater.quitAndInstall()`（旧流程会触发 old-uninstaller → exit 2 /
   "无法关闭"死循环）。安装包定位不依赖 `update-downloaded` 事件时序，用
   `findDownloadedInstaller()` 扫 `%LOCALAPPDATA%\deepseek-harness-desktop-updater\pending\`
   （文件名排序取最后一个）兜底。installAndQuit 顺序固定：**杀进程 → 清注册表 →
   删目录 → 装新版 → 重启**；清注册表必须在删目录**之前**（v0.1.4 修正：先清
   registry 让安装器当全新安装处理，即使删目录失败也不会触发旧卸载器）；成败按
   安装器退出码判定（`Start-Process -PassThru` + 轮询 `HasExited`，成功 = 退出码
   0 且新 exe 存在），不是看目录里有没有文件。安装日志写 `%TEMP%\dsh-install.log`。

## 常用命令

```powershell
# 开发模式
npm install          # postinstall 会本地重编译 koffi native 绑定，需要 VS Build Tools
npm start            # electron . 启动壳

# 打包（electron-builder → NSIS 安装包，输出到 dist/）
npm run dist

# Windows PowerShell 下 npm 被策略拦（npm.ps1 cannot be loaded）：
npm.cmd install      # 或用
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser

# 国内网络镜像（Electron 二进制约 100MB 需从 GitHub 下载）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist

# 一键发布（本地打包校验 → 提交 → 打 tag → 推送；CI 随后自动打包上传 Release）
release.cmd 0.1.9      # 不带参数 = 保持当前版本只重新发布

# 本地联调"安装进度 UI"全流程：改完 main.js 后
npm run dist           # 生成 dist\DeepSeek Harness Setup *.exe
# 重启已安装的应用 → 更新卡片显示"本地通道"（shellHasChanges=true）→ 点更新
# 应用退出后弹出 WinForms 安装进度窗，可观察 杀进程/清注册表/删目录/安装 全过程
```

## 目录速查

| 文件/目录 | 作用 |
|---|---|
| `main.js` | 主进程：spawn dsh、端口/就绪探测、窗口、托盘、退出回收、更新（双通道）+ `installAndQuit`（干净静默安装 + WinForms 进度 UI）+ `findDownloadedInstaller`（updater 缓存兜底定位安装包）+ `shellHasChanges`（通道判定） |
| `skills.js` | 技能面板数据服务（壳侧）：扫描/解析/读写技能文件（项目 `.dsh/skills`、`.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`，以及各 Agent preset 自带的 `skills/`，如网络专家/创造模式），注册 `skills:*` IPC；纯逻辑不依赖 electron，可被普通 node 单测 |
| `preload.js` | 注入 dsh 页面的最小只读桥（命名空间 `__DSH_DESKTOP__`，与 `__DSH_BOOT__` 不冲突）：设置弹窗「通用设置」更新卡片 + 左侧「技能」分区技能卡片注入、`skills` 桥、主题同步 |
| `assets/` | 应用/托盘图标（`tray.png` 缺失时回退 `icon.png`）+ `installer.nsh`（NSIS 自定义宏）+ `install-helper.ps1`（安装助手脚本，installAndQuit 经环境变量传参调用） |
| `assets/installer.nsh` | `customCheckAppRunning`：强制 `taskkill /f /t /im` 全部应用实例 + 按"从安装目录运行"路径兜底清理残留进程（孤儿 dsh node 侧车锁文件 = "无法关闭"exit 2 的根因，v0.1.11 修复），替换 electron-builder 默认"进程占用 → 无法关闭，点 Retry"死循环逻辑。注意：NSIS 里 PowerShell 的 `$_` 必须写成 `$$_.`（直接写 `$_` 触发 NSIS warning 6000，electron-builder 把警告当错误） |
| `generate-icons.ps1` | 本地工具：从 `icon.svg` 生成各尺寸 png / ico |
| `update-exe-icon.cmd` | 本地工具：用 rcedit 重打 exe 图标（配合图标补丁逻辑测试） |
| `node/` | 捆绑的标准 node.exe（`extraResources` → `resources/node/node.exe`，随包分发；**git 忽略**，由 `release.cmd` / CI 从系统 node 生成） |
| `package.json` | 依赖 + `build`（electron-builder）配置 + `publish`（更新源，GitHub Releases；owner/repo 已写死真实仓库 `chuf-China/deepseek_harness-desktop`）。`build.extraResources` **必须**保留两条：`@deepseek-ai`（承重：自动收集的嵌套依赖树会漏 20 个包（cordis-plugin-group / dsh-shell / dsh-workflow 等），dsh 完整启动会 ERR_MODULE_NOT_FOUND——删掉它应用打不开，2026-08 实测翻车已恢复）+ `node` 侧车 |
| `.github/workflows/release.yml` | 推 `v*` tag 自动打包（有 Azure 密钥则签名）并发布 Release（含 `latest.yml` + 安装包 + blockmap）；无密钥则未签名发布。其中"占位符替换"步骤对当前 package.json 已是空操作，保留无害 |
| `release.cmd` | 一键发布：版本号 → 本地打包校验 → 提交 → 打 tag → 推送（CI 随后自动打包上传） |
| `release-sign.json` | Azure Trusted Signing 签名配置（仅 CI 有对应 Secrets 时启用） |
| `dist/` | 打包产物（`npm run dist` 生成） |

## 已知边界（诚实清单，别当 bug 修）

1. **Node 已捆绑**：打包版用 `resources/node/node.exe` 跑 dsh；仅当捆绑缺失/损坏时
   回退系统 node（需 >=18）。开发模式始终用系统 node。
2. **未签名；自动更新已接并已发布**：Windows 未签名安装包会被 SmartScreen 拦截，
   但只影响**手动下载安装包**的场景，应用内自动更新不受影响；正式分发前仍需签名。
   自动更新（壳 + dsh 双通道）已接入 electron-updater：壳通道走 `package.json` 的
   `build.publish`（GitHub Releases，owner/repo 已写死真实仓库
   `chuf-China/deepseek_harness-desktop`，`releaseType: "release"`——顶层 `publish`
   在构建时被忽略，必须放 `build.publish`，见 452274c）。发布流程 = 推 `v*` tag →
   CI 自动打包 → 上传 Release（`latest.yml` + 安装包 + blockmap）；当前最新发布
   **v0.1.10**（每次发布新版本时顺手更新此数字）。未发布/源码与安装目录不同步
   （`shellHasChanges()`=true）时回退本地构建更新（`npm run dist` + installAndQuit，
   同样弹安装进度窗）。
3. **端口竞态**：`findFreePort()` 选的端口在 dsh bind 前极小概率被抢，未做重试。
4. **开机自启仅 Windows + 打包版**：托盘"开机自启"直接写 `HKCU\...\Run`（reg.exe，
   值带引号 + `--hidden` + `--project "<本地源码项目>"`——自启命令固定带上项目根，
   让自启进程启动早期 chdir 回项目，壳侧面板"项目技能"分组在自启场景下同样可见）；
   开发模式（`electron .`）禁用该开关。自启/`--hidden` 启动只驻留托盘不弹窗；
   此时 dsh 崩溃自动重启照常生效。
5. **平台**：当前 `build` 只配了 `win/nsis`（Windows），macOS/Linux 未支持。
6. **技能面板（壳侧）**：只做展示 + 文本编辑，不做每会话启停开关（调用策略由
   SKILL.md frontmatter 控制，面板仅展示模型/用户徽标）；新建默认落用户根
   `~/.dsh/skills`（项目根同名技能会覆盖它，面板按根展示）；frontmatter 解析为
   极简实现，语义以内核 `dsh-skill-filesystem` README 为准（非法策略值 → 面板
   标 invalid，与内核"丢弃该技能"对齐）；实时感知依赖内核 Chokidar watcher，
   极端未触发时面板可手动「刷新」。

## 更新与安装排查要点

- **安装失败第一现场**：`%TEMP%\dsh-install.log`——`installAndQuit` 全程记录每一步
  （杀进程/清注册表/删目录/安装器退出码），UI 报失败时先看它。
- **安装包下载缓存**：`%LOCALAPPDATA%\deepseek-harness-desktop-updater\pending\`
  （`findDownloadedInstaller()` 扫描处；升级下载成功后该目录应有
  `DeepSeek-Harness-Setup-<ver>.exe`）。
- **版本验证三件套**：安装目录 `package.json` 的 `version` / exe 文件版本
  （FileVersion）/ HKCU 卸载注册表 DisplayVersion 三者一致，才是真装上了（历史
  教训：只信更新卡片文本会误判"没更新"）。
- **双通道判定**：`shellHasChanges()` 比较源码与安装目录的 main.js、preload.js、
  assets/icon.ico、icon.png、tray.png、icon.svg 六个文件（**不比** package.json、
  skills.js）——全同步走真实 GitHub 通道；不同步则更新卡片走本地构建通道
  （`npm run dist` + installAndQuit）。本地通道需要开发机工具链（node/npm/编译链），
  `runUpdate` 会先探测 npm，缺失时明确报错；设置卡片里的项目目录为只读显示，
  由 `DSH_PROJECT_DIR` 或默认值决定（渲染层不传路径）。开发时把源码同步进安装
  目录可让本地通道变真实通道。
- **安装器退出码 2 / "无法关闭"** = 旧卸载器流程被触发；正解是先清注册表再删目录
  （铁律 #9），不是加等待/重试。手动安装场景（双击安装包）的"无法关闭"根因是
  **残留的 dsh node 侧车**（崩溃/重启后的孤儿进程，映像名 node.exe 不在应用名下，
  `taskkill /t /im` 杀不到）锁住安装目录文件 → 旧卸载器删文件失败；v0.1.11 起
  `installer.nsh` 已按"从安装目录运行"的路径兜底杀进程。
- **"点了更新但没反应"**：先查是否退出后无安装进度窗（= helper 没跑起来，对照
  铁律 #8 的 spawn 方式），再看 pending 缓存里有没有安装包（= 下载没完成，与安装
  无关）。

## 给 agent 的排查提示

- **壳自身日志**：`%APPDATA%\deepseek-harness-desktop\shell.log`——dsh 启动/崩溃
  自动重启/更新/安装全过程（从 Explorer 双击启动时控制台不可见，一切以它为准；
  超过 10MB 滚动为 shell.log.1）。
- 桌面端运行时，dsh 是独立 node 进程（命令行形如
  `node --expose-internals ...\@deepseek-ai\dsh\lib\bin.js web --port <N>`），
  监听 127.0.0.1 随机端口；壳主进程是 `DeepSeek Harness.exe`，子进程带
  `--type=gpu-process` / `--type=renderer` 等 Chromium 标志。
- 所有实例共享 `DSH_HOME`（默认 `C:\Users\Administrator\.dsh`），同时跑多个 dsh
  实例（如残留的 `npx dsh web`）会造成会话/存储争用——排查时先确认只有一个 dsh
  在监听。
- 会话持久化在 `$DSH_HOME/sessions/<workspace 编码>/<session-id>/session.jsonl.zstd`。
- 用户级全局指令文件是 `$DSH_HOME/AGENTS.md`（对所有工作区生效）；本文件只作用于
  本项目。目录级可用 `AGENTS.local.md` 覆盖。
