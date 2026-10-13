/**
 * xiaoetong-main.js - 小鹅通主进程集成（二开）
 *
 * 在 main.js 里加三行即可：
 *   const { registerXiaoetongIpc } = require('./src/native/xiaoetong-main');
 *   const xiaoetong = require('./src/native/xiaoetong');
 *   // app ready 后：
 *   xiaoetong.init(app.getPath('userData'), safeStorage);
 *   registerXiaoetongIpc({ ipcMain, BrowserWindow, session });
 *
 * 流程：渲染进程调 xiaoetongLoginOpen → 弹出 480×800 登录窗口（小鹅通 H5 登录页，
 * 用户微信扫码 / 手机号验证码登录）→ 用户点"我已完成登录" →
 * 主进程读该窗口 session 的 xiaoeknow.com cookies → safeStorage 加密存 userData →
 * 关窗。退出登录时清 cookie + 删文件。
 */
const xiaoetong = require('./xiaoetong');

const XE_COOKIE_DOMAIN = /(^|\.)h5\.xiaoeknow\.com$/;
const DEFAULT_SHOP = 'appsqo5wx226057'; // 大乔乔教育；多店铺以后可做店铺管理

let loginWindow = null;
let loginShopId = DEFAULT_SHOP;

function xeDomainOk(domain) {
  return XE_COOKIE_DOMAIN.test(String(domain || '').replace(/^\./, ''));
}

function registerXiaoetongIpc({ ipcMain, BrowserWindow }) {
  // 打开扫码登录窗口
  ipcMain.handle('xiaoetong-login-open', async (_event, shopId) => {
    loginShopId = String(shopId || DEFAULT_SHOP);
    const url = xiaoetong.loginUrl(loginShopId);
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { success: true, url }; }
    loginWindow = new BrowserWindow({
      width: 480, height: 800, title: '小鹅通扫码登录', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    loginWindow.on('closed', () => { loginWindow = null; });
    await loginWindow.loadURL(url);
    return { success: true, url };
  });

  // 用户完成扫码后：收 cookie、加密持久化、关窗
  ipcMain.handle('xiaoetong-login-finish', async () => {
    if (!loginWindow || loginWindow.isDestroyed()) throw new Error('请先打开登录窗口完成扫码');
    const all = await loginWindow.webContents.session.cookies.get({});
    const kept = all.filter(c => c && c.name && xeDomainOk(c.domain));
    if (!kept.length) throw new Error('还没读到登录态：请先在登录窗口里完成微信扫码 / 验证码登录');
    const simple = kept.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      expirationDate: c.expirationDate || 0 }));
    xiaoetong.saveSession({ shopId: loginShopId, cookies: simple, userLabel: '' });
    try { loginWindow.close(); } catch (_) {}
    loginWindow = null;
    return { success: true, status: xiaoetong.getSessionStatus() };
  });

  ipcMain.handle('xiaoetong-login-close', async () => {
    try { loginWindow?.close(); } catch (_) {}
    loginWindow = null;
    return { success: true };
  });

  // 登录态查询
  ipcMain.handle('xiaoetong-status', async () => ({ success: true, status: xiaoetong.getSessionStatus() }));

  // 退出登录：清登录窗口 session cookie + 删本地会话文件
  ipcMain.handle('xiaoetong-logout', async () => {
    try {
      if (loginWindow && !loginWindow.isDestroyed()) {
        const ses = loginWindow.webContents.session;
        const all = await ses.cookies.get({});
        await Promise.all(all.filter(c => xeDomainOk(c.domain))
          .map(c => ses.cookies.remove(`https://${String(c.domain).replace(/^\./, '')}${c.path || '/'}`, c.name).catch(() => {})));
      }
    } catch (_) {}
    xiaoetong.clearSession();
    return { success: true, status: xiaoetong.getSessionStatus() };
  });

  // 已购课程（待联调：真实接口发现后在 xiaoetong.js 里实现，这里直接透传）
  ipcMain.handle('xiaoetong-purchased', async () => {
    try { return await xiaoetong.listPurchased(); }
    catch (error) { return { success: false, error: error.message }; }
  });

  // 课程分集（待联调）
  ipcMain.handle('xiaoetong-episodes', async (_event, seriesId) => {
    try { return await xiaoetong.fetchEpisodeList(seriesId); }
    catch (error) { return { success: false, error: error.message }; }
  });
}

module.exports = { registerXiaoetongIpc };
