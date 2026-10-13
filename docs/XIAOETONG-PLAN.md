# 小鹅通二开计划（hongguo-drama fork）

目标：扫码登录自己的小鹅通账号 → 下载已购课程到本地 → 没网也能看。

## 一、已实测确认的事实（2026-10-13，只读侦察）

| 项目 | 结论 |
|---|---|
| 示例店铺 | 大乔乔教育，`appsqo5wx226057.h5.xiaoeknow.com` |
| 示例课程 | 《golang从入门到通天(三部曲合集)》￥1100，课程包（3 子课程：150+197+144 节）|
| PC 播放 | **被商家「课程查看限制」拦截**：PC 点试看直接 302 到 `service.h5.xiaoeknow.com` 的「限制访问引导」页（"商家已设置课程权限，请使用手机微信扫一扫查看"）|
| 登录页 | `https://<shop>.h5.xiaoeknow.com/p/t/free/v1/basic-platform/h5_basic/login/auth`，支持 手机号+验证码 / 微信 / QQ |
| 课时播放页 | `https://service.h5.xiaoeknow.com/p/learn-app/guide?app_id=<shop>&params=<base64>`；params 解码含 `resource_id`（形如 `v_69a95f85e4b0694c5b92faa4`）、`resource_type: 3`（视频）、`product_id`（形如 `course_2tbaIK1d2ZoEOTxWQYnEkW8UIjy`）|
| 视频地址 | PC 端页面源码无 `<video>`/MP4/m3u8，必须登录后实测 |

## 二、红线

- 只看自己已购内容；不做付费解锁。
- 若实测为 HLS 内容加密流（含 `#EXT-X-KEY` 或私有加密）：**只做"看"（内嵌官方 H5 播放器），不做"下载"**。

## 三、联调发现清单（需用户扫码登录后，用测试版抓包）

1. **已购列表接口**：登录后进 H5「我的」→「已购」，抓 XHR（看域名是 `h5.xiaoeknow.com` 还是独立 API 域、路径、参数、返回结构）。
2. **课程包/章节接口**：课程详情页 `window.initData`（未登录可见目录）或已购详情 XHR，确认 课程包→子课程→章→节 的字段映射。
3. **取流接口（关键）**：登录后播一节课，看播放器请求的视频地址：
   - 普通 MP4 / 明文 m3u8 → 可下载 → 填 `fetchPlayUrlSingle`，接下载管线。
   - 加密 → 只做内嵌播放。
4. **登录态字段**：确认 auth cookie 名（便于有效性校验与过期刷新）。

## 四、main.js 集成点（对照现有 xifan/hema）

- `require('./src/native/xiaoetong')`，`init(app.getPath('userData'), safeStorage)`。
- IPC：`xiaoetong-login-url`（返回扫码页地址）→ 主进程开 `BrowserWindow`（480×800，手机 UA 可选）→ 用户扫码 → 读该窗口 session cookies → `saveSession` → 关窗 → 通知渲染进程。
- IPC：`xiaoetong-status` / `xiaoetong-logout` / `xiaoetong-purchased` / `xiaoetong-episodes`。
- 下载管线：`vid` 前缀 `xiaoetong:`，在现有 `sourceId` 分发处加分支；`fetchPlayUrlSingle` 返回 `{url, source:'xiaoetong'}` 即可复用整套下载/合并/断点续播。
- 渲染进程：`BUILTIN_MEDIA_SOURCES` 加 `{id:'xiaoetong', label:'小鹅通'}`；设置页加「小鹅通」卡片（登录按钮/二维码、已购课程列表）。

## 五、当前进度

- [x] 工作区搭建（`upstream/` 纯净对照，`app/` 二开目录）
- [x] `src/native/xiaoetong.js` 骨架：会话加密持久化、登录 URL、ID 编解码、接口桩
- [x] `src/native/xiaoetong-main.js`：主进程登录窗口 + IPC（open/finish/close/status/logout/purchased/episodes）
- [x] `src/components/XiaoetongSettings.jsx`：设置页「小鹅通」卡片（esbuild JSX 校验通过）
- [x] `docs/INTEGRATION.md`：合进 main.js / preload.js / Settings.jsx 的三处补丁
- [ ] 用户 fork 仓库（GitHub App 无写权限，需手动点 Fork）
- [ ] 联调发现（需用户扫码登录测试版）
- [ ] 取流实测 → 定"下载/只看"
- [ ] 接下载管线 + 设置页 UI
