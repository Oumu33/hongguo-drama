# 集成说明（已合入，2026-10-13）

> 以下接线已在 commit `c79a76c` 合入源码（main.js / preload.js / src/components/Settings.jsx），
> 不再是补丁文档。`npm run dist` 打包即带小鹅通登录。

## 已合入内容

## 1. main.js

在第 28 行附近（`hongguo` 的 require 下面）加：

```js
const xiaoetong = require('./src/native/xiaoetong');
const { registerXiaoetongIpc } = require('./src/native/xiaoetong-main');
```

在第 11 行的 electron 解构里加上 `safeStorage`：

```js
const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, Menu, Notification, screen, safeStorage } = require('electron');
```

在 `app.whenReady().then(...)` 里（约 3569 行，`store.init(dataFile);` 之后）加：

```js
xiaoetong.init(app.getPath('userData'), safeStorage);
registerXiaoetongIpc({ ipcMain, BrowserWindow });
```

## 2. preload.js

在 `electronAPI` 对象里（找个顺手的位置，比如自定义源那几行下面）加：

```js
// 小鹅通（二开）
xiaoetongStatus: () => ipcRenderer.invoke('xiaoetong-status'),
xiaoetongLoginOpen: (shopId) => ipcRenderer.invoke('xiaoetong-login-open', shopId),
xiaoetongLoginFinish: () => ipcRenderer.invoke('xiaoetong-login-finish'),
xiaoetongLoginClose: () => ipcRenderer.invoke('xiaoetong-login-close'),
xiaoetongLogout: () => ipcRenderer.invoke('xiaoetong-logout'),
xiaoetongPurchased: () => ipcRenderer.invoke('xiaoetong-purchased'),
xiaoetongEpisodes: (seriesId) => ipcRenderer.invoke('xiaoetong-episodes', seriesId),
```

## 3. src/components/Settings.jsx

顶部 import 区（`CustomSources` 那行下面）加：

```jsx
import XiaoetongSettings from './XiaoetongSettings';
```

渲染区（`<CustomSources active={active} />` 下面）加：

```jsx
<XiaoetongSettings active={active} />
```

## 4. 验证

```bash
node --check src/native/xiaoetong.js && node --check src/native/xiaoetong-main.js
npx esbuild --loader:.jsx=jsx src/components/XiaoetongSettings.jsx --outfile=/dev/null
```

启动后进「设置」应看到「小鹅通」卡片：点"扫码登录"弹出 480×800 登录窗口；
微信扫码完成后点"我已完成登录"，状态变为已登录。
