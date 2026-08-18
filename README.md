# DeepSeek Harness 桌面壳（Electron）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 包成一个可双击启动的桌面应用。

**设计铁律：壳核分离。** 本仓库只含“壳”——负责启动/回收 `@deepseek-ai/dsh` 子进程、开窗口指向它起的本地 web UI。内核（dsh）作为 npm 依赖锁定版本，**绝不 fork/vendor**，上游更新改一行版本号即对齐。

## 功能

- 自动启动本地 dsh，等 web 服务就绪后开窗口指向它；dsh 意外退出自动退避重启
- **系统托盘**：关窗不退出（隐藏到托盘），托盘菜单可“显示 / 开机自启 / 退出”
- **开机自启**（仅打包版）：托盘勾选 → 写 HKCU 启动项，静默启动到托盘
- 真正退出时回收整棵 dsh 子进程树（Windows 用 `taskkill /T /F`）
- 单实例锁（重复启动聚焦已有窗口）
- 设置弹窗内的更新卡片（壳 + dsh 内核双通道）与「技能」面板（管理 SKILL.md）

## 架构

```
桌面壳 (Electron 主进程)
  ├─ 窗口 → http://127.0.0.1:<port>/     ← 浏览器包装，不内嵌 UI
  ├─ 系统托盘（关窗隐藏 / 菜单退出）
  ├─ preload 桥（预留原生能力）           ← contextIsolation 开启
  └─ 进程管理：spawn dsh / 就绪探测 / 退出回收
        │  spawn 子进程
        ▼
@deepseek-ai/dsh（npm 依赖，锁定版本）      ← 内核
```

## 前置要求

- 开发模式：Node.js >= 18（dsh 是 Node 应用）+ npm；`npm install` 的 postinstall 会
  本地重编译 koffi native 绑定，**需要 C++ 构建工具链**（Windows 下为 VS Build
  Tools；没有工具链时 `npm install` 会失败）
- 打包版：**无需装 Node** —— 安装包已捆绑标准 node（`resources/node/node.exe`，与系统 node 同 ABI）

## 运行（开发模式）

```powershell
npm install
npm start
```

> **Windows PowerShell 提示**：如果你在 PowerShell 里敲 `npm` 报
> `npm.ps1 cannot be loaded because running scripts is disabled`，说明系统
> 执行策略是 Restricted。二选一：
> - 改用 `npm.cmd install`、`npm.cmd start`；
> - 或先放行一次：`Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`。

## 打包（生成 exe 安装包）

```powershell
# 首次打包需下载 electron-builder 及其工具（可设镜像加速）
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

产物在 `dist/`，默认是 NSIS 安装包（可自选安装目录、建桌面快捷方式）。
`node/` 目录里的 `node.exe`（标准 node）会随包分发到 `resources/node/`，dsh 由它运行。

> **关键设计**：`build.asar = false`。因为 dsh 是 npm 依赖、壳要用**标准 node**
> 去 spawn 它，而 asar 是 Electron 私有的虚拟文件系统、标准 node 读不了。关掉
> asar 后 node_modules 以真实文件存在，node 才能正常执行 dsh。

## 发布与自动更新

设置页（web 原生「通用设置」里的更新卡片）是**双通道一个按钮**；技能卡片在左侧「技能」分区展示：

- **壳通道**：已发布场景走 `electron-updater`（检查 → 下载 → 退出静默安装）；
- **dsh 内核通道**：npm 上 dsh 有新版时，在本地构建流程里一并升级重打包；
- 未发布 / 开发模式自动回退“本地构建更新”（`npm run dist` + 自动安装）。本地通道
  需要开发机工具链（node/npm，koffi 重编译还需编译工具链）：主进程会先探测 npm，
  缺失时明确报错而不是挂掉；设置卡片里的项目目录为只读显示（由 `DSH_PROJECT_DIR`
  或默认值决定，不在 UI 修改）。

发布到 GitHub Releases 的步骤：

### 一次发布（推荐，CI 全自动）

1. 把代码推到你的 GitHub 仓库（首次先建仓：`git remote add origin <url>`，再
   `git push -u origin main`）；
2. 把 `package.json` 里 `build.publish` 的 `owner` / `repo` 改成你的仓库；
3. 跑 `release.cmd 0.2.0`（自动：版本号 → 本地打包验证 → 提交 → 打 tag → 推送）；
4. GitHub Actions（`.github/workflows/release.yml`）收到 tag 后自动：打包 →
   （若配了密钥则）签名 → 上传 Release（`latest.yml` + 安装包）。之后用户点
   「检查并更新」即可自动升级。

**可选签名**（消除首次安装的 SmartScreen 提示，Azure Trusted Signing 约 $10/月）：
在仓库 Settings → Secrets and variables → Actions 里加
`AZURE_ENDPOINT` / `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
`AZURE_ACCOUNT` / `AZURE_CERT_PROFILE`。不配也能发布，只是安装包未签名
（签名逻辑在 `release-sign.json`，由工作流按需启用）。

### 手动发布（不建 CI 也行）

1. `npm run dist`（配了 publish 后会自动生成 `dist/latest.yml` + 安装包）；
2. 在 GitHub 仓库 Releases 页新建 Release，tag 用 `vX.Y.Z`；
3. 上传 `dist/latest.yml` 和 `dist/DeepSeek Harness Setup X.Y.Z.exe`
   （`.blockmap` 可省略，只影响增量下载）；
4. 用户端自动更新即可生效。

（可选）不打补丁直接覆盖发布源：在已安装应用的 `resources/` 放
`update-config.json`，如 `{"provider":"github","owner":"x","repo":"y"}` 或
`{"provider":"generic","url":"https://your-server/updates/"}`，优先级高于打包时写入的配置。

## 排查

- 壳自身日志：`%APPDATA%\deepseek-harness-desktop\shell.log`（dsh 启动/崩溃/更新/安装全过程；Explorer 双击启动时控制台不可见，一切以它为准）。
- 安装失败第一现场：`%TEMP%\dsh-install.log`（安装助手逐步骤记录：杀进程/清注册表/删目录/安装器退出码）。
- 安装包下载缓存：`%LOCALAPPDATA%\deepseek-harness-desktop-updater\pending\`。

## 国内网络提示

`npm install` 时 Electron 需从 GitHub 下载二进制（约 100MB），可先设镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
```

## 目录

| 文件/目录 | 作用 |
|---|---|
| `main.js` | 主进程：spawn dsh、端口/就绪探测、窗口、托盘、退出回收、更新（双通道 + 静默安装） |
| `skills.js` | 技能面板数据服务（壳侧）：扫描/解析/读写 SKILL.md + `skills:*` IPC；纯逻辑可被 node 单测 |
| `preload.js` | 注入到 dsh 页面的桥：设置弹窗更新卡片 +「技能」分区卡片 + 主题同步 |
| `assets/` | 托盘与应用图标（`icon.svg` 为源，`icon.png`/`tray.png`/`icon.ico` 由 `generate-icons.ps1` 生成）+ `installer.nsh` + `install-helper.ps1`（安装助手脚本，经环境变量传参） |
| `node/` | 捆绑的标准 node.exe（随包分发，用户无需装 Node） |
| `package.json` | 依赖声明 + `build`（electron-builder）配置 + `publish`（更新源） |
| `dist/` | 打包产物（`npm run dist` 生成） |

## 已知边界（诚实清单）

1. **Node 已捆绑**：打包版用 `resources/node/node.exe` 跑 dsh；仅当捆绑缺失/损坏
   时才回退系统 node（需 >=18）。开发模式始终用系统 node。
2. **未签名；自动更新已接**：Windows 上未签名安装包会被 SmartScreen 拦（仅影响手动
   下载安装的场景，应用内自动更新不受影响）；壳 + dsh 双通道已接入 electron-updater。
3. **端口竞态**：`findFreePort()` 选的端口在 dsh bind 前极小概率被抢；若发生，dsh
   会立刻退出并触发崩溃自动重启（新端口），实际可自愈，未做专门重试。
4. **开机自启仅 Windows + 打包版**：开发模式（`electron .`）禁用该开关。
5. **平台**：当前只配了 `win/nsis`（Windows），macOS/Linux 未支持。
6. **技能面板（壳侧）**：只做展示 + 文本编辑，不做每会话启停开关（调用策略由
   SKILL.md frontmatter 控制）；实时感知依赖内核 Chokidar watcher，极端未触发时
   可手动「刷新」。
