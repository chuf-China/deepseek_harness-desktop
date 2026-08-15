# DeepSeek Harness 桌面壳（Electron）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 包成一个可双击启动的桌面应用。

**设计铁律：壳核分离。** 本仓库只含“壳”——负责启动/回收 `@deepseek-ai/dsh` 子进程、开窗口指向它起的本地 web UI。内核（dsh）作为 npm 依赖锁定版本，**绝不 fork/vendor**，上游更新改一行版本号即对齐。

## 功能

- 自动启动本地 dsh，等 web 服务就绪后开窗口指向它
- **系统托盘**：关窗不退出（隐藏到托盘），托盘菜单可“显示 / 退出”
- 真正退出时回收整棵 dsh 子进程树（Windows 用 `taskkill /T /F`）
- 单实例锁（重复启动聚焦已有窗口）

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

- Node.js >= 18（dsh 是 Node 应用，需 `node` 在 PATH 中）
- npm

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

> **关键设计**：`build.asar = false`。因为 dsh 是 npm 依赖、壳要用**系统 node**
> 去 spawn 它，而 asar 是 Electron 私有的虚拟文件系统、系统 node 读不了。关掉
> asar 后 node_modules 以真实文件存在，系统 node 才能正常执行 dsh。

## 国内网络提示

`npm install` 时 Electron 需从 GitHub 下载二进制（约 100MB），可先设镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
```

## 目录

| 文件/目录 | 作用 |
|---|---|
| `main.js` | 主进程：spawn dsh、端口/就绪探测、窗口、托盘、退出回收 |
| `preload.js` | 注入到 dsh 页面的最小只读桥（为原生功能预留） |
| `assets/` | 托盘与应用图标（占位，可替换成自己的 logo） |
| `package.json` | 依赖声明 + `build`（electron-builder）配置 |
| `dist/` | 打包产物（`npm run dist` 生成） |

## 已知边界（诚实清单）

1. **依赖系统 node**（开发模式和打包版都一样）：壳用系统 `node` 跑 dsh，因为
   dsh 的 native 依赖（node-pty/koffi）按标准 node ABI 编译。要做到“用户不装
   Node 也能用”，需后续捆绑标准 Node sidecar。
2. **未做代码签名 / 自动更新**：Windows 上未签名的安装包会被 SmartScreen 拦，
   正式分发前需签名；自动更新（壳 + dsh 双通道）也是后续里程碑。
3. **端口竞态**：`findFreePort()` 选的端口在 dsh bind 前极小概率被抢，未做重试。
