'use strict';

/**
 * preload：注入到 dsh 的 web 页面的最小、只读桥。
 *
 * MVP 阶段它不干任何事，只是为后续“原生能力”预留正确位置：
 * 未来 skills dashboard 等插件需要调原生能力（打开文件对话框、系统通知、
 * 全局快捷键）时，在这里用 contextBridge + ipcRenderer 暴露受限 API。
 *
 * 命名空间 __DSH_DESKTOP__ 与 dsh 自己的 __DSH_BOOT__ 不冲突。
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld(
  '__DSH_DESKTOP__',
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
  }),
);
