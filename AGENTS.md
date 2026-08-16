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
  ├─ 开机自启：托盘勾选 → 直接写 HKCU\...\Run（reg.exe，带引号 + --hidden）；
  │    --hidden 启动 = 静默到托盘不弹窗（不用 electron setLoginItemSettings，
  │    它写的值不带引号，exe 路径含空格时开机启动会被截断）
  ├─ dsh 崩溃自动重启：exit 且非主动退出 → handleDshCrash() 退避重试（1s~5s，
  │    最多 5 次；连续稳定 30s 后重置计数；超限弹框退出）；托盘气泡提示；
  │    waitForReady 用 isDead 回调感知"就绪前崩溃"避免双重重启
  └─ 退出：Windows 用 taskkill /pid <dsh> /T /F 回收整棵子进程树
```

## 铁律（不可破坏的约束，改代码时逐条核对）

1. **壳核分离，内核不 vendor**：`@deepseek-ai/dsh` 只作为 npm 依赖存在（当前锁定
   `0.1.0-rc.6`），绝不把内核代码拷进本仓库。升级 = 改 `package.json` 版本号。
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

## 常用命令

```powershell
# 开发模式
npm install
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
```

## 目录速查

| 文件/目录 | 作用 |
|---|---|
| `main.js` | 主进程：spawn dsh、端口/就绪探测、窗口、托盘、退出回收、更新（双通道） |
| `preload.js` | 注入 dsh 页面的最小只读桥（命名空间 `__DSH_DESKTOP__`，与 `__DSH_BOOT__` 不冲突）：更新卡片注入 + 主题同步 |
| `assets/` | 托盘与应用图标（`tray.png` 缺失时回退 `icon.png`） |
| `node/` | 捆绑的标准 node.exe（`extraResources` → `resources/node/node.exe`，随包分发；**git 忽略**，由 `release.cmd` / CI 从系统 node 生成） |
| `package.json` | 依赖 + `build`（electron-builder）配置 + `publish`（更新源，GitHub Releases） |
| `.github/workflows/release.yml` | 推 `v*` tag 自动打包 / 可选签名 / 上传 Release（CI 里把 `publish.owner/repo` 占位符换成真实仓库） |
| `release.cmd` | 一键发布：版本号 → 本地打包 → 提交 → 打 tag → 推送 |
| `release-sign.json` | Azure Trusted Signing 签名配置（仅 CI 有对应 Secrets 时启用） |
| `dist/` | 打包产物（`npm run dist` 生成） |

## 已知边界（诚实清单，别当 bug 修）

1. **Node 已捆绑**：打包版用 `resources/node/node.exe` 跑 dsh；仅当捆绑缺失/损坏时
   回退系统 node（需 >=18）。开发模式始终用系统 node。
2. **未签名；自动更新已接**：Windows 未签名安装包会被 SmartScreen 拦截，正式分发
   前需签名。自动更新（壳 + dsh 双通道）已接入 electron-updater：壳通道走
   `package.json` 的 `publish`（GitHub Releases），未发布/开发模式自动回退本地构建
   更新（`npm run dist` + 自动安装）。真正发布前需把 `publish.owner/repo` 改成实际
   仓库并在 Release 上传 `latest.yml` + 安装包。
3. **端口竞态**：`findFreePort()` 选的端口在 dsh bind 前极小概率被抢，未做重试。
4. **开机自启仅 Windows + 打包版**：托盘"开机自启"直接写 `HKCU\...\Run`（reg.exe，
   值带引号 + `--hidden`）；开发模式（`electron .`）禁用该开关。自启/`--hidden`
   启动只驻留托盘不弹窗；此时 dsh 崩溃自动重启照常生效。
5. **平台**：当前 `build` 只配了 `win/nsis`（Windows），macOS/Linux 未支持。

## 给 agent 的排查提示

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
