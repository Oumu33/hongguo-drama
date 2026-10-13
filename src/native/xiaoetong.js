/**
* xiaoetong.js - 小鹅通课程平台适配器（二开）
*
* 目标：扫码登录自己的小鹅通账号 → 拉取已购课程/章节 → 取视频流地址 → 下载到本地离线看。
*
* 已实测确认（2026-10-13，只读侦察）：
* - 商家可开「课程查看限制」：PC 端点播放直接 302 跳转到
* service.h5.xiaoeknow.com 的「限制访问引导」页（"商家已设置课程权限，请使用手机微信扫一扫查看"）。
* 绕法：用手机 UA + 用户登录态嵌 H5 播放页，走官方播放器。
* - 登录页：https://<shop>.h5.xiaoeknow.com/p/t/free/v1/basic-platform/h5_basic/login/auth
* 支持 手机号+验证码 / 微信 / QQ（微信扫码可用）。
* - 课时播放页：https://service.h5.xiaoeknow.com/p/learn-app/guide?app_id=<shop>&params=<base64>
* params 解码后含 { resource_id: 'v_...', resource_type: 3, product_id: 'course_...', user_id, type: 4}。
* - PC 端页面源码里没有任何 <video> / MP4 / m3u8 地址，真实流格式必须登录后实测。
*
* 红线：只看自己已购内容；若实测为 HLS 内容加密流，则只做"看"不做"下载"。
*/
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const ID = /^[A-Za-z0-9_-]{1,120}$/;

// ---------- 会话持久化（登录态） ----------
// 会话文件放在 Electron userData 下，cookie 用 safeStorage 加密存放。
// main.js 集成时：app.getPath('userData') 传入 init()。
let userDataDir = null;
let safeStorage = null; // Electron safeStorage（main 进程），没有则明文+警告（仅开发联调）

function sessionFile() {
if (!userDataDir) throw new Error('小鹅通适配器未初始化：请先调用 init(userDataDir)');
return path.join(userDataDir, 'xiaoetong-session.json');
}

function init(dir, electronSafeStorage) {
userDataDir = dir;
safeStorage = electronSafeStorage || null;
}

function encrypt(text) {
if (safeStorage?.isEncryptionAvailable?.()) return { enc: true, data: safeStorage.encryptString(text).toString('base64')};
return { enc: false, data: Buffer.from(text, 'utf8').toString('base64')};
}
function decrypt(payload) {
if (!payload) return '';
if (payload.enc) {
if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('无法解密小鹅通登录态：系统密钥不可用');
return safeStorage.decryptString(Buffer.from(payload.data, 'base64'));
}
return Buffer.from(payload.data, 'base64').toString('utf8');
}

function loadSession() {
try {
const raw = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
const cookies = JSON.parse(decrypt(raw.cookies) || '[]');
return { shopId: raw.shopId || '', cookies, userLabel: raw.userLabel || '', savedAt: raw.savedAt || 0};
} catch (_) { return { shopId: '', cookies: [], userLabel: '', savedAt: 0};}
}

function saveSession({ shopId, cookies, userLabel}) {
const payload = { shopId, userLabel: userLabel || '', savedAt: Date.now(), cookies: encrypt(JSON.stringify(cookies || []))};
fs.mkdirSync(path.dirname(sessionFile()), { recursive: true});
fs.writeFileSync(sessionFile(), JSON.stringify(payload, null, 2), 'utf8');
}

function clearSession() {
try { fs.unlinkSync(sessionFile());} catch (_) {}
}

function cookieHeader(cookies, domain) {
return (cookies || [])
.filter(c => c && c.name && (!domain ||!c.domain || domain.endsWith(c.domain.replace(/^\./, '')) || c.domain.replace(/^\./, '') === domain))
.map(c => `${c.name}=${c.value}`).join('; ');
}

// ---------- 登录 ----------
// 集成说明（main.js）：
// const win = new BrowserWindow({ width: 480, height: 800,...});
// win.loadURL(`https://${shopId}.h5.xiaoeknow.com/p/t/free/v1/basic-platform/h5_basic/login/auth`);
// 用户在窗口内微信扫码 / 验证码登录成功后，读取该窗口 session 的全部 cookie，
// 调 xiaoetong.saveSession({ shopId, cookies, userLabel}) 持久化，然后关闭窗口。
// 登录态有效性校验：带 cookie 请求一次「我的已购」页，200 且含课程数据即有效。
function loginUrl(shopId) {
if (!ID.test(shopId)) throw new Error('店铺 ID 无效');
return `https://${shopId}.h5.xiaoeknow.com/p/t/free/v1/basic-platform/h5_basic/login/auth`;
}

function getSessionStatus() {
const s = loadSession();
return { loggedIn: s.cookies.length > 0, shopId: s.shopId, userLabel: s.userLabel, savedAt: s.savedAt};
}

// ---------- 带登录态的请求 ----------
async function authedGet(url, { mobile = true} = {}) {
const s = loadSession();
if (!s.cookies.length) throw new Error('小鹅通未登录：请先扫码登录');
const u = new URL(url);
const { data, headers, status} = await axios.get(url, {
headers: {
'User-Agent': mobile? MOBILE_UA: PC_UA,
Accept: 'application/json, text/html',
Cookie: cookieHeader(s.cookies, u.hostname),
Referer: `https://${s.shopId}.h5.xiaoeknow.com/`,
},
timeout: 15000, maxRedirects: 0,
validateStatus: st => st >= 200 && st < 400,
}).catch(err => {
if (err.response?.status === 302) return { data: '', headers: err.response.headers, status: 302};
throw err;
});
// 302 跳到「限制访问引导」页 = 被商家 PC 限制拦截（预期内，用手机 UA 重试或走内嵌 H5）
if (status === 302 && String(headers.location || '').includes('learn-app/guide')) {
const e = new Error('商家开启了课程查看限制（PC 端被拦截）');
e.code = 'XE_PC_BLOCKED'; e.location = headers.location; throw e;
}
return { data, headers, status};
}

// ---------- ID 编解码 ----------
// series: xiaoetong:<shopId>:<productId> episode: xiaoetong:<shopId>:<productId>:<resourceId>
function parseId(value, episode = false) {
const parts = String(value || '').split(':');
if (parts[0]!== 'xiaoetong' || parts.length!== (episode? 4: 3) ||!parts.slice(1).every(p => ID.test(p))) {
throw new Error('小鹅通编号无效');
}
return { shopId: parts[1], productId: parts[2], resourceId: episode? parts[3]: null,
seriesId: parts.slice(0, 3).join(':')};
}

function plainText(v) { return String(v || '').replace(/<[^>]*>/g, '').trim();}

// ---------- 已购课程 / 章节（待登录后联调发现真实接口） ----------
// 【已发现】课程目录接口（2026-10-13 逆向 H5 前端 js/6323.js 实锤）：
//   POST https://<shop>.h5.xiaoeknow.com/xe.course.business_go.courseware_list.get/2.0.0
//   JSON body，响应 pack "bizData"（即取响应的 bizData 字段）。
//   课程包子课程列表：POST /xe.entity_goods.goods_package.get_goods_list/1.0.0
//     body {resource_id, resource_type}。
//   直接 curl 探返回空（需走它自家的 request_js 封装头），参数名与课时字段名
//   待登录后在真实客户端抓包补全。联调方法见 docs/XIAOETONG-PLAN.md。
// H5「我的已购」页的真实 XHR 接口。联调方法见 docs/XIAOETONG-PLAN.md。
const COURSEWARE_LIST_API = '/xe.course.business_go.courseware_list.get/2.0.0';
const GOODS_PACKAGE_API = '/xe.entity_goods.goods_package.get_goods_list/1.0.0';
async function listPurchased() {
// TODO(联调): 登录后抓包 h5.xiaoeknow.com 的已购列表接口，填到这里。
// 候选：店铺 H5 首页「我的」→「已购」Tab 的 XHR。
throw new Error('小鹅通已购列表接口待联调发现（需登录后抓包），详见 docs/XIAOETONG-PLAN.md');
}

function lessonPageUrl(shopId, resourceId, productId) {
const params = Buffer.from(JSON.stringify({
resource_id: resourceId, resource_type: 3, product_id: productId, type: 4,
})).toString('base64');
return `https://service.h5.xiaoeknow.com/p/learn-app/guide?app_id=${shopId}&params=${encodeURIComponent(params)}`;
}

// 课程包 → 子课程 → 章节 → 课时的完整结构接口。
// 已知：课程详情页 window.initData / __INIT_DATA__ 含章节信息（未登录可见目录）。
async function fetchEpisodeList(seriesId) {
// TODO(联调): 解析课程详情页 initData 或已购详情接口，组出 episodes。
// episode: { vid: `xiaoetong:<shopId>:<productId>:<resourceId>`, vid_index, title,
// series_id, series_title, cover, locked, source: 'xiaoetong'}
throw new Error('小鹅通章节接口待联调发现（需登录后抓包），详见 docs/XIAOETONG-PLAN.md');
}

// ---------- 取流地址（关键！决定下载是否可行） ----------
// 必须登录后实际播一节课，看 H5 播放器请求的是什么：
// - 普通 MP4 / 明文 m3u8 → 可下载，接进现有下载管线。
// - HLS 内容加密（含 #EXT-X-KEY 或私有加密）→ 只做"看"，不做"下载"。
async function fetchPlayUrlSingle(vid, sid) {
const id = parseId(vid, true);
if (sid && String(sid)!== id.seriesId) throw new Error('小鹅通分集不属于当前课程');
// TODO(实测): 带登录态 + 手机 UA 请求 lessonPageUrl，跟踪播放器 XHR 拿到真实视频地址。
// 注意：若返回 XE_PC_BLOCKED，说明仍被商家限制拦截，需走内嵌 H5 播放器（看），而非直链（下）。
throw new Error('小鹅通取流地址待登录后实测，详见 docs/XIAOETONG-PLAN.md');
}

module.exports = {
init, loginUrl, getSessionStatus, saveSession, clearSession,
listPurchased, fetchEpisodeList, fetchPlayUrlSingle, lessonPageUrl, parseId,
};
