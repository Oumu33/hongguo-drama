/**
 * src/native/edu51cto-main.js — 51CTO 学堂主进程接线（二开）
 *
 * - 打开 51CTO 统一登录页窗口（home.51cto.com），用户微信扫码登录
 * - 用户点「我已完成登录」后：收窗口 session 里 51cto.com 域 cookie → 加密持久化 → 关窗
 * - IPC：edu51cto-status / login-open / login-finish / login-close / logout /
 *         lessons（课程链接→课时列表）/ download-batch（课时批量下载进队列）
 */
const edu51cto = require('./edu51cto');

let loginWindow = null;
const DEFAULT_LOGIN_URL = edu51cto.loginUrl();

function ctoDomainOk(domain) {
  return /51cto\.com$/.test(String(domain || '').replace(/^\./, ''));
}

function registerEdu51ctoIpc({ ipcMain, BrowserWindow, enqueueEdu51ctoLessons }) {
  // 打开扫码登录窗口（51CTO PC 就是官方播放端，桌面 UA 即可）
  ipcMain.handle('edu51cto-login-open', async () => {
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { success: true }; }
    loginWindow = new BrowserWindow({
      width: 1000, height: 720, title: '51CTO 学堂扫码登录', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    loginWindow.on('closed', () => { loginWindow = null; });
    await loginWindow.loadURL(DEFAULT_LOGIN_URL);
    return { success: true };
  });

  // 用户完成扫码后：收 cookie、加密持久化、关窗
  ipcMain.handle('edu51cto-login-finish', async () => {
    if (!loginWindow || loginWindow.isDestroyed()) throw new Error('请先打开登录窗口完成扫码');
    const all = await loginWindow.webContents.session.cookies.get({});
    const kept = all.filter(c => c && c.name && ctoDomainOk(c.domain));
    if (!kept.length) throw new Error('还没读到登录态：请先在登录窗口里完成微信扫码登录');
    const simple = kept.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly, expirationDate: c.expirationDate || 0 }));
    edu51cto.saveSession({ cookies: simple, userLabel: '' });
    try { loginWindow.close(); } catch (_) {}
    loginWindow = null;
    return { success: true, status: edu51cto.getSessionStatus() };
  });

  ipcMain.handle('edu51cto-login-close', async () => {
    try { loginWindow?.close(); } catch (_) {}
    loginWindow = null;
    return { success: true };
  });

  ipcMain.handle('edu51cto-status', async () => ({ success: true, status: edu51cto.getSessionStatus() }));

  // 退出登录：清登录窗口 session cookie + 删本地会话文件
  ipcMain.handle('edu51cto-logout', async () => {
    try {
      if (loginWindow && !loginWindow.isDestroyed()) {
        const ses = loginWindow.webContents.session;
        const all = await ses.cookies.get({});
        await Promise.all(all.filter(c => ctoDomainOk(c.domain))
          .map(c => ses.cookies.remove(`https://${String(c.domain).replace(/^\./, '')}${c.path || '/'}`, c.name).catch(() => {})));
      }
    } catch (_) {}
    edu51cto.clearSession();
    return { success: true, status: edu51cto.getSessionStatus() };
  });

  // 已购课程列表
  ipcMain.handle('edu51cto-purchased', async () => {
    try { return { success: true, courses: await edu51cto.fetchPurchasedCourses() }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  // 课程链接 → 课时列表
  ipcMain.handle('edu51cto-lessons', async (_event, courseUrl) => {
    try { return { success: true, ...(await edu51cto.fetchCourseLessons(courseUrl)) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  // 批量下载课时（进现有下载队列）
  ipcMain.handle('edu51cto-download-batch', async (_event, payload) => {
    try {
      const { courseId, courseTitle, lessons } = payload || {};
      if (!Array.isArray(lessons) || !lessons.length) return { success: false, error: '未选择课时' };
      const count = await enqueueEdu51ctoLessons({ courseId, courseTitle, lessons });
      return { success: true, count, requested: lessons.length };
    } catch (error) { return { success: false, error: error.message }; }
  });
}

module.exports = { registerEdu51ctoIpc };
