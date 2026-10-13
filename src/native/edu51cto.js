/**
 * src/native/edu51cto.js — 51CTO 学堂适配器（二开）
 *
 * 只做用户自己已购课程的离线下载：登录态 → 课时元信息 → vod-play-auth 换 psign
 * → 腾讯云 getplayinfo v4 换 m3u8 → 复用 hls-media 管线下载合并。
 *
 * 实测链路（2026-10-13，用户账号 Evan0S，微信扫码登录）：
 *   1. GET https://edu.51cto.com/center/course/lesson/index-data?id={课时ID}
 *      → result.data.vodVideoId（腾讯云 fileID）、result.data.vodVideoIdAuth（一次性签名）、
 *        result.data.lesson_list（全课程课时列表）、result.data.is_look
 *   2. GET https://edu.51cto.com/center/player/play/vod-play-auth
 *        ?type=&lesson_id={课时ID}&id={fileID}&sign={vodVideoIdAuth}&lesson_type=course
 *      → result.data.info.appID、result.data.info.playAuth（即腾讯云 psign）
 *   3. GET https://playvideo.qcloud.com/getplayinfo/v4/{appID}/{fileID}?psign={psign}
 *      → {code:0, version:4, media:{streamingInfo:{plainOutput:{url}}}}（m3u8 地址）
 *      只有 drmOutput 而无 plainOutput 时为 DRM 加密课时，不支持下载。
 *
 * 红线：只下载用户已购课程；DRM（Widevine/FairPlay）课时直接报错不碰。
 */
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const PC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const VOD_PLAYINFO = 'https://playvideo.qcloud.com/getplayinfo/v4';

// ---------- 会话持久化（登录态） ----------
let userDataDir = null;
let safeStorage = null;

function sessionFile() {
  if (!userDataDir) throw new Error('51CTO 适配器未初始化：请先调用 init(userDataDir)');
  return path.join(userDataDir, 'edu51cto-session.json');
}
function init(dir, electronSafeStorage) {
  userDataDir = dir;
  safeStorage = electronSafeStorage || null;
}
function encrypt(text) {
  if (safeStorage?.isEncryptionAvailable?.()) return { enc: true, data: safeStorage.encryptString(text).toString('base64') };
  return { enc: false, data: Buffer.from(text, 'utf8').toString('base64') };
}
function decrypt(payload) {
  if (!payload) return '';
  if (payload.enc) {
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('无法解密 51CTO 登录态：系统密钥不可用');
    return safeStorage.decryptString(Buffer.from(payload.data, 'base64'));
  }
  return Buffer.from(payload.data, 'base64').toString('utf8');
}
function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    const cookies = JSON.parse(decrypt(raw.cookies) || '[]');
    return { cookies, userLabel: raw.userLabel || '', savedAt: raw.savedAt || 0 };
  } catch (_) { return { cookies: [], userLabel: '', savedAt: 0 }; }
}
function saveSession({ cookies, userLabel }) {
  const payload = { userLabel: userLabel || '', savedAt: Date.now(), cookies: encrypt(JSON.stringify(cookies || [])) };
  fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
  fs.writeFileSync(sessionFile(), JSON.stringify(payload, null, 2), 'utf8');
}
function clearSession() {
  try { fs.unlinkSync(sessionFile()); } catch (_) {}
}
function cookieHeader(cookies) {
  return (cookies || [])
    .filter(c => c && c.name && (!c.domain || /51cto\.com$/.test(String(c.domain).replace(/^\./, ''))))
    .map(c => `${c.name}=${c.value}`).join('; ');
}
function getSessionStatus() {
  const s = loadSession();
  return { loggedIn: s.cookies.length > 0, userLabel: s.userLabel, savedAt: s.savedAt };
}

// ---------- 登录 ----------
// 登录窗口打开 51CTO 统一登录页（home.51cto.com，微信扫码标签），用户扫码后
// 收窗口 session 里 51cto.com 域的 cookie 调 saveSession 持久化。
function loginUrl() {
  return 'https://home.51cto.com/';
}

// ---------- 带登录态的请求 ----------
async function authedGet(url, params) {
  const s = loadSession();
  if (!s.cookies.length) throw new Error('51CTO 未登录：请先扫码登录');
  const { data } = await axios.get(url, {
    params,
    headers: {
      'User-Agent': PC_UA,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieHeader(s.cookies),
      Referer: 'https://edu.51cto.com/',
    },
    timeout: 20000,
    validateStatus: st => st >= 200 && st < 400,
  });
  return data;
}

// ---------- 链路步骤 ----------
async function fetchLessonMeta(lessonId) {
  const id = String(lessonId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('课时 ID 无效');
  const data = await authedGet('https://edu.51cto.com/center/course/lesson/index-data', { id });
  const info = data?.result?.data;
  if (!info || !info.vodVideoId) throw new Error('取课时元信息失败：未返回 vodVideoId（可能登录过期或无该课时权限）');
  return {
    lessonId: id,
    fileID: String(info.vodVideoId),
    sign: String(info.vodVideoIdAuth || ''),
    isLook: info.is_look,
    lessonList: Array.isArray(info.lesson_list) ? info.lesson_list : [],
  };
}

async function fetchPlayAuth(lessonId, fileID, sign) {
  const data = await authedGet('https://edu.51cto.com/center/player/play/vod-play-auth', {
    lesson_id: lessonId, id: fileID, sign, lesson_type: 'course',
  });
  const info = data?.result?.data?.info;
  if (!info || !info.playAuth || !info.appID) throw new Error('换取播放凭证失败：未返回 playAuth（可能签名过期，请重试）');
  return { appID: String(info.appID), psign: String(info.playAuth) };
}

async function fetchM3u8Url(appID, fileID, psign) {
  const url = `${VOD_PLAYINFO}/${encodeURIComponent(appID)}/${encodeURIComponent(fileID)}`;
  const { data } = await axios.get(url, {
    params: { psign },
    headers: { 'User-Agent': PC_UA, Referer: 'https://edu.51cto.com/', Accept: 'application/json' },
    timeout: 20000,
    validateStatus: st => st >= 200 && st < 500,
  });
  if (!data || data.code !== 0) throw new Error(`腾讯云换取播放地址失败（code=${data?.code}, message=${data?.message || '未知'}），psign 可能已过期，请重试`);
  const streaming = data?.version === 4 ? data?.media?.streamingInfo : null;
  const plainUrl = streaming?.plainOutput?.url;
  if (plainUrl) return String(plainUrl);
  const drmTypes = Array.isArray(streaming?.drmOutput) ? streaming.drmOutput.map(d => d.type).filter(Boolean) : [];
  throw new Error(drmTypes.length ? `该课时为 DRM 加密视频（${drmTypes.join('/')}），不支持下载` : '未找到可用的明文播放地址');
}

/** 完整链路：课时 ID → m3u8 地址（含标题信息） */
async function resolveLessonStream(lessonId) {
  const meta = await fetchLessonMeta(lessonId);
  const auth = await fetchPlayAuth(meta.lessonId, meta.fileID, meta.sign);
  const m3u8Url = await fetchM3u8Url(auth.appID, meta.fileID, auth.psign);
  return { lessonId: meta.lessonId, m3u8Url, isLook: meta.isLook };
}

/** 从课程页 HTML 里解析课时 ID 列表（lesson/{id}.html） */
function parseLessonIdsFromCourseHtml(html) {
  const ids = [];
  const seen = new Set();
  const re = /\/lesson\/(\d+)\.html/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}

/** 课程链接 → 课时列表（含标题）：取课程页解析出一个课时 ID，再调 index-data 拿全量 lesson_list */
async function fetchCourseLessons(courseUrl) {
  const m = String(courseUrl || '').match(/edu\.51cto\.com\/course\/(\d+)/);
  if (!m) throw new Error('课程链接无效，应为 https://edu.51cto.com/course/{课程ID}.html 格式');
  const courseId = m[1];
  const s = loadSession();
  if (!s.cookies.length) throw new Error('51CTO 未登录：请先扫码登录');
  const { data: html } = await axios.get(`https://edu.51cto.com/course/${courseId}.html`, {
    headers: { 'User-Agent': PC_UA, Cookie: cookieHeader(s.cookies), Referer: 'https://edu.51cto.com/' },
    timeout: 20000, responseType: 'text',
    validateStatus: st => st >= 200 && st < 400,
  });
  const titleMatch = String(html).match(/<title>([^<]{1,120})<\/title>/);
  const courseTitle = (titleMatch?.[1] || `课程${courseId}`).replace(/_51CTO.*$/, '').trim();
  const ids = parseLessonIdsFromCourseHtml(html);
  if (!ids.length) throw new Error('课程页未解析到课时列表（页面结构可能变化）');
  // 用第一个课时调 index-data 拿全量 lesson_list（含标题、试看标记）
  const meta = await fetchLessonMeta(ids[0]);
  const lessons = meta.lessonList.length ? meta.lessonList.map((l, i) => ({
    lessonId: String(l.id || l.lesson_id || ''),
    title: String(l.title || l.lesson_title || `第${i + 1}节`),
    isLook: l.is_look,
  })).filter(l => l.lessonId) : ids.map((id, i) => ({ lessonId: id, title: `第${i + 1}节`, isLook: undefined }));
  return { courseId, courseTitle, lessons };
}

module.exports = {
  init, loginUrl, saveSession, clearSession, getSessionStatus, cookieHeader, loadSession,
  fetchLessonMeta, fetchPlayAuth, fetchM3u8Url, resolveLessonStream,
  parseLessonIdsFromCourseHtml, fetchCourseLessons,
};
