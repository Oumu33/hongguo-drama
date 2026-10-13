import React, { useCallback, useEffect, useState } from 'react';
import { Globe } from './icons';
import './CustomSources.css';

/**
 * Edu51ctoSettings - 设置页「51CTO 学堂」卡片（二开）
 *
 * 流程：在 App 里点"扫码登录"→ 弹出 51CTO 统一登录窗口 → 用户微信扫码 →
 * 回到这里点"我已完成登录" → 主进程收 cookie 加密存本地。
 * 然后粘贴课程链接（如 https://edu.51cto.com/course/23845.html）→「获取课时」→
 * 勾选课时 →「下载选中」→ 进入下载队列（登录态→鉴权→m3u8→分片下载合并）。
 *
 * 只下载用户自己已购课程；DRM 加密课时不支持下载。
 */
export default function Edu51ctoSettings({ active = true }) {
  const [status, setStatus] = useState({ loggedIn: false, savedAt: 0 });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [courseUrl, setCourseUrl] = useState('');
  const [course, setCourse] = useState(null); // {courseId, courseTitle, lessons:[{lessonId,title,isLook}]}
  const [selected, setSelected] = useState({});

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.edu51ctoStatus();
      if (result?.success) setStatus(result.status || { loggedIn: false });
      else throw new Error(result?.error || '状态读取失败');
    } catch (cause) { setError(cause.message || '状态读取失败'); }
  }, []);

  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  const run = async (kind, fn) => {
    if (busy) return null;
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
    const result = await window.electronAPI.edu51ctoLoginOpen();
    if (result?.success) setMessage('登录窗口已打开：请在窗口内用微信扫码登录，完成后点「我已完成登录」。');
    return result;
  });
  const finishLogin = () => run('finish', async () => {
    const result = await window.electronAPI.edu51ctoLoginFinish();
    if (result?.success) setMessage('登录成功，登录态已加密保存到本机。');
    return result;
  });
  const logout = () => run('logout', async () => {
    const result = await window.electronAPI.edu51ctoLogout();
    if (result?.success) { setMessage('已退出登录，本地登录态已清除。'); setCourse(null); setSelected({}); }
    return result;
  });

  const fetchLessons = () => run('lessons', async () => {
    const result = await window.electronAPI.edu51ctoLessons(courseUrl.trim());
    if (result?.success) {
      setCourse({ courseId: result.courseId, courseTitle: result.courseTitle, lessons: result.lessons });
      setSelected({});
      setMessage(`已获取《${result.courseTitle}》共 ${result.lessons.length} 节课时，勾选后点「下载选中」。`);
    }
    return result;
  });

  const toggle = lessonId => setSelected(prev => ({ ...prev, [lessonId]: !prev[lessonId] }));
  const toggleAll = on => {
    const next = {};
    (course?.lessons || []).forEach(l => { next[l.lessonId] = on; });
    setSelected(next);
  };
  const selectedLessons = (course?.lessons || []).filter(l => selected[l.lessonId]);

  const downloadSelected = () => run('download', async () => {
    const result = await window.electronAPI.edu51ctoDownloadBatch({
      courseId: course.courseId, courseTitle: course.courseTitle, lessons: selectedLessons,
    });
    if (result?.success) {
      setMessage(`已提交 ${result.count} 节到下载队列（共勾选 ${result.requested} 节），去「下载管理」查看进度。`);
      setSelected({});
    }
    return result;
  });

  return <section className="settings-card custom-sources" aria-labelledby="edu51cto-title">
    <div className="custom-sources-heading"><Globe size={18} /><h3 id="edu51cto-title">51CTO 学堂</h3></div>
    <p className="settings-hint">扫码登录你自己的 51CTO 账号，把已购课程下载到本地离线看。登录态加密只存本机，不上传。</p>
    <div className="custom-source-list" aria-label="51CTO 登录状态">
      <div className="custom-source-row">
        <div className="custom-source-info">
          <strong>{status.loggedIn ? '已登录' : '未登录'}</strong>
          {status.loggedIn && status.savedAt
            ? <span>{new Date(status.savedAt).toLocaleString()} 登录</span>
            : <span>登录后可下载已购课程</span>}
        </div>
        <div className="custom-source-actions">
          {!status.loggedIn && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={openLogin}>{busy === 'open' ? '打开中…' : '扫码登录'}</button>}
          {!status.loggedIn && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={finishLogin}>{busy === 'finish' ? '确认中…' : '我已完成登录'}</button>}
          {status.loggedIn && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={logout}>{busy === 'logout' ? '退出中…' : '退出登录'}</button>}
        </div>
      </div>
    </div>
    {status.loggedIn && <div className="custom-source-row" style={{ marginTop: 8 }}>
      <input type="text" className="input" style={{ flex: 1 }} placeholder="粘贴课程链接，如 https://edu.51cto.com/course/23845.html"
        value={courseUrl} onChange={e => setCourseUrl(e.target.value)} disabled={!!busy} />
      <div className="custom-source-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !courseUrl.trim()} onClick={fetchLessons}>
          {busy === 'lessons' ? '获取中…' : '获取课时'}
        </button>
      </div>
    </div>}
    {course && <div style={{ marginTop: 8 }}>
      <div className="custom-source-row">
        <div className="custom-source-info"><strong>《{course.courseTitle}》</strong><span>共 {course.lessons.length} 节</span></div>
        <div className="custom-source-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => toggleAll(true)}>全选</button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => toggleAll(false)}>全不选</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !selectedLessons.length} onClick={downloadSelected}>
            {busy === 'download' ? '提交中…' : `下载选中（${selectedLessons.length}）`}
          </button>
        </div>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 6 }}>
        {course.lessons.map((l, i) => <label key={l.lessonId} className="proxy-switch-row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={!!selected[l.lessonId]} onChange={() => toggle(l.lessonId)} />
          <span className="proxy-switch-text">{String(i + 1).padStart(2, '0')} · {l.title}{l.isLook === 1 ? '（试看）' : ''}</span>
        </label>)}
      </div>
    </div>}
    {message && <p className="custom-source-message" role="status">{message}</p>}
    {error && <div className="custom-source-error" role="alert"><p>{error}</p></div>}
  </section>;
}
