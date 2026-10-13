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
  const s = loadSession();
  if (!s.cookies.length) throw new Error('51CTO 未登录：请先扫码登录');
  const input = String(courseUrl || '').trim();
  // 直接给课时链接（已购列表的"继续学习"入口就是这种）：跳过课程页解析
  const lessonMatch = input.match(/edu\.51cto\.com\/lesson\/(\d+)/);
  if (lessonMatch) return lessonsFromLessonId(lessonMatch[1], input);
  const m = input.match(/edu\.51cto\.com\/course\/(\d+)/);
  if (!m) throw new Error('链接无效，应为课程页 https://edu.51cto.com/course/{课程ID}.html 或课时页 https://edu.51cto.com/lesson/{课时ID}.html');
  const courseId = m[1];
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
  return { courseId, courseTitle, lessons: normalizeLessonList(meta.lessonList, ids) };
}

async function lessonsFromLessonId(lessonId, referer) {
  const meta = await fetchLessonMeta(lessonId);
  const ids = meta.lessonList.length
    ? meta.lessonList.map(l => String(l.id || l.lesson_id || '')).filter(Boolean)
    : [String(lessonId)];
  return { courseId: '', courseTitle: '', lessons: normalizeLessonList(meta.lessonList, ids), referer };
}

function normalizeLessonList(rawList, fallbackIds) {
  if (Array.isArray(rawList) && rawList.length) {
    return rawList.map((l, i) => ({
      lessonId: String(l.id || l.lesson_id || ''),
      title: String(l.title || l.lesson_title || l.name || `第${i + 1}节`),
      isLook: l.is_look,
    })).filter(l => l.lessonId);
  }
  return (fallbackIds || []).map((id, i) => ({ lessonId: String(id), title: `第${i + 1}节`, isLook: undefined }));
}

/** 已购课程列表：POST /center/course/user/get-study-course（表单 page/size，返回 {status:1, data:[...]}） */
async function fetchPurchasedCourses(page = 1, size = 20) {
  const s = loadSession();
  if (!s.cookies.length) throw new Error('51CTO 未登录：请先扫码登录');
  const body = new URLSearchParams({ page: String(page), size: String(size) }).toString();
  const { data } = await axios.post('https://edu.51cto.com/center/course/user/get-study-course', body, {
    headers: {
      'User-Agent': PC_UA,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieHeader(s.cookies),
      Referer: 'https://edu.51cto.com/center/course/user/get-study-course',
    },
    timeout: 20000,
    validateStatus: st => st >= 200 && st < 400,
  });
  if (data?.status === -9) throw new Error('登录已过期，请重新扫码登录');
  if (data?.status !== 1) throw new Error(`获取已购课程失败（status=${data?.status}，可能接口变化）`);
  let list = Array.isArray(data.data) ? data.data : [];
  if (!list.length && data.data && typeof data.data === 'object') {
    const arr = Object.values(data.data).find(v => Array.isArray(v));
    if (arr) list = arr;
  }
  return list.map(normalizePurchasedCourse).filter(c => c.title || c.courseId);
}

/** 已购记录字段名防御式归一化（JSON 原始字段名以实际返回为准） */
function normalizePurchasedCourse(c) {
  c = c || {};
  const lessonUrl = c.lesson_url || c.lessonUrl || c.url || c.study_url || '';
  const lessonMatch = String(lessonUrl).match(/\/lesson\/(\d+)\.html/);
  return {
    courseId: String(c.course_id ?? c.courseId ?? c.id ?? ''),
    title: String(c.course_title ?? c.courseTitle ?? c.title ?? c.name ?? ''),
    lessonCount: c.lesson_count ?? c.lessonCount ?? c.total_lesson ?? null,
    duration: c.duration ?? c.total_time ?? null,
    progress: c.study_progress ?? c.progress ?? null,
    lessonId: lessonMatch ? lessonMatch[1] : String(c.lesson_id ?? c.lessonId ?? ''),
    raw: c,
  };
}

module.exports = {
  init, loginUrl, saveSession, clearSession, getSessionStatus, cookieHeader, loadSession,
  fetchLessonMeta, fetchPlayAuth, fetchM3u8Url, resolveLessonStream,
  parseLessonIdsFromCourseHtml, fetchCourseLessons, fetchPurchasedCourses,
};
