import React, { useCallback, useEffect, useState } from 'react';
import { Globe } from './icons';
import './CustomSources.css';

/**
 * XiaoetongSettings - 设置页「小鹅通」卡片（二开）
 *
 * 流程：在 App 里点"扫码登录"→ 弹出小鹅通 H5 登录窗口 → 用户微信扫码 /
 * 手机号验证码登录 → 回到这里点"我已完成登录" → 主进程收 cookie 加密存本地。
 * 登录态用于拉取已购课程与取视频流地址（取流实测通过后接下载管线）。
 */
export default function XiaoetongSettings({ active = true }) {
  const [status, setStatus] = useState({ loggedIn: false, shopId: '', savedAt: 0 });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.xiaoetongStatus();
      if (result?.success) setStatus(result.status || { loggedIn: false });
      else throw new Error(result?.error || '状态读取失败');
    } catch (cause) { setError(cause.message || '状态读取失败'); }
  }, []);

  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  const run = async (kind, fn) => {
    if (busy) return;
    setBusy(kind); setMessage(''); setError('');
    try {
      const result = await fn();
      if (!result?.success) throw new Error(result?.error || '操作失败');
      if (result.status) setStatus(result.status);
      await refresh();
      return result;
    } catch (cause) { setError(cause.message || '操作失败'); return null; }
    finally { setBusy(''); }
  };

  const openLogin = () => run('open', async () => {
    const result = await window.electronAPI.xiaoetongLoginOpen();
    if (result?.success) setMessage('登录窗口已打开：请在窗口内用微信扫码（或手机号验证码）登录，完成后点「我已完成登录」。');
    return result;
  });
  const finishLogin = () => run('finish', async () => {
    const result = await window.electronAPI.xiaoetongLoginFinish();
    if (result?.success) setMessage('登录成功，登录态已加密保存到本机。');
    return result;
  });
  const logout = () => run('logout', async () => {
    const result = await window.electronAPI.xiaoetongLogout();
    if (result?.success) setMessage('已退出登录，本地登录态已清除。');
    return result;
  });

  return <section className="settings-card custom-sources" aria-labelledby="xiaoetong-title">
    <div className="custom-sources-heading"><Globe size={18} /><h3 id="xiaoetong-title">小鹅通</h3></div>
    <p className="settings-hint">扫码登录你自己的小鹅通账号，用于拉取已购课程与下载到本地离线看。登录态加密只存本机，不上传。</p>
    <div className="custom-source-list" aria-label="小鹅通登录状态">
      <div className="custom-source-row">
        <div className="custom-source-info">
          <strong>{status.loggedIn ? '已登录' : '未登录'}</strong>
          {status.loggedIn && status.savedAt
            ? <span>{new Date(status.savedAt).toLocaleString()} 登录</span>
            : <span>登录后可拉取已购课程</span>}
        </div>
        <div className="custom-source-actions">
          {!status.loggedIn && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={openLogin}>{busy === 'open' ? '打开中…' : '扫码登录'}</button>}
          {!status.loggedIn && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={finishLogin}>{busy === 'finish' ? '确认中…' : '我已完成登录'}</button>}
          {status.loggedIn && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={logout}>{busy === 'logout' ? '退出中…' : '退出登录'}</button>}
        </div>
      </div>
    </div>
    {message && <p className="custom-source-message" role="status">{message}</p>}
    {error && <div className="custom-source-error" role="alert"><p>{error}</p></div>}
    <p className="settings-hint">已购课程列表与下载接线在取流实测通过后启用（见 docs/XIAOETONG-PLAN.md）。</p>
  </section>;
}
