// 扫码手机输入搜索：主进程起一个仅局域网可达的临时小服务，
// 搜索框旁生成二维码（内容=带一次性 token 的本机局域网地址），
// 手机扫码打开极简输入页，打完剧名提交后经回调把关键词送回渲染层回填并搜索。
// 不经过任何公网服务器；token 随机、5 分钟过期、收到一次输入即自动关闭。
const http = require('node:http');
const os = require('node:os');
const { randomBytes } = require('node:crypto');

const MAX_KEYWORD_LENGTH = 100;
const SESSION_TTL_MS = 5 * 60 * 1000;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      out.push(item.address);
    }
  }
  // 常见家用网段优先，其余次之
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

function mobilePage(token) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>输入剧名</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#faf7f2;color:#222}
h1{font-size:20px;margin:0 0 8px}p{color:#666;font-size:14px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;font-size:18px;padding:14px;border:1px solid #ccc;border-radius:10px}
button{width:100%;margin-top:14px;font-size:17px;padding:14px;border:0;border-radius:10px;background:#c8433c;color:#fff}
#msg{margin-top:16px;font-size:15px;min-height:22px}.ok{color:#2e7d32}.err{color:#c8433c}
</style></head><body>
<h1>在手机上输入剧名</h1>
<p>输入后点发送，电脑上的红果短剧会自动填入并搜索。</p>
<form id="f"><input id="kw" type="text" placeholder="例如：一村人养一个神" autocomplete="off" enterkeyhint="search">
<button type="submit">发送到电脑</button></form>
<div id="msg"></div>
<script>
var token=${JSON.stringify(token)};
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();
var kw=document.getElementById('kw').value.trim();var msg=document.getElementById('msg');
if(!kw){msg.className='err';msg.textContent='先输入剧名';return;}
msg.className='';msg.textContent='发送中…';
fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:token,keyword:kw})})
.then(function(r){return r.json()}).then(function(j){
if(j&&j.ok){msg.className='ok';msg.textContent='已发送到电脑，正在为你搜索《'+kw+'》';}
else{msg.className='err';msg.textContent=(j&&j.error)||'发送失败，请重新扫码';}})
.catch(function(){msg.className='err';msg.textContent='网络错误，请确认手机和电脑连着同一个 WiFi';});});
document.getElementById('kw').focus();
</script></body></html>`;
}

function createQrSearchServer({ onKeyword, ttlMs = SESSION_TTL_MS } = {}) {
  if (typeof onKeyword !== 'function') throw new Error('缺少关键词回调');
  const token = randomBytes(18).toString('hex');
  let closed = false;
  let timer = null;
  const server = http.createServer((req, res) => {
    const sendJson = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://lan');
      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('t') !== token) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('链接已失效，请在电脑上重新点「手机输入」生成二维码'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(mobilePage(token));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
        req.on('end', () => {
          let body;
          try { body = JSON.parse(raw || '{}'); } catch (_) { sendJson(400, { ok: false, error: '请求格式不对' }); return; }
          if (body.t !== token) { sendJson(403, { ok: false, error: '链接已失效，请重新扫码' }); return; }
          const keyword = String(body.keyword || '').trim().slice(0, MAX_KEYWORD_LENGTH);
          if (!keyword) { sendJson(400, { ok: false, error: '剧名不能为空' }); return; }
          sendJson(200, { ok: true });
          // 收到即完成使命：先回执再回调并自动关闭，避免 token 继续暴露在局域网里
          try { onKeyword(keyword); } finally { session.close(); }
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (_) {
      try { res.writeHead(500); res.end(); } catch (_) {}
    }
  });
  const session = {
    token,
    port: 0,
    urls: [],
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch (_) {}
    },
    get closed() { return closed; },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', resolve);
      });
      session.port = server.address().port;
      session.urls = lanAddresses().map((ip) => `http://${ip}:${session.port}/?t=${token}`);
      timer = setTimeout(() => session.close(), ttlMs);
      timer.unref?.();
      return session;
    },
  };
  return session;
}

module.exports = { createQrSearchServer, lanAddresses, mobilePage, MAX_KEYWORD_LENGTH, SESSION_TTL_MS };
