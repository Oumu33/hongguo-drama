const assert = require('node:assert/strict');
const { createQrSearchServer, mobilePage } = require('./qr-search');

(async () => {
  // 手机页包含 token 提交逻辑
  assert.match(mobilePage('abc123'), /发送到电脑/);
  assert.match(mobilePage('abc123'), /abc123/);

  let received = null;
  const session = createQrSearchServer({ onKeyword: (kw) => { received = kw; }, ttlMs: 60000 });
  await session.listen();
  assert.ok(session.port > 0);
  const base = `http://127.0.0.1:${session.port}`;

  // 无 token / 错 token 打不开页面
  assert.equal((await fetch(`${base}/`)).status, 403);
  assert.equal((await fetch(`${base}/?t=wrong`)).status, 403);
  const page = await fetch(`${base}/?t=${session.token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /输入剧名/);

  // 错 token 发送被拒且不触发回调
  const bad = await fetch(`${base}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: 'wrong', keyword: '测试剧' }) });
  assert.equal(bad.status, 403);
  assert.equal(received, null);

  // 空关键词被拒
  const empty = await fetch(`${base}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: session.token, keyword: '  ' }) });
  assert.equal(empty.status, 400);
  assert.equal(received, null);

  // 正确发送：回调收到裁剪后的关键词，且会话自动关闭
  const okRes = await fetch(`${base}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: session.token, keyword: '  一村人养一个神  ' }) });
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { ok: true });
  assert.equal(received, '一村人养一个神');
  assert.equal(session.closed, true);

  console.log('qr-search: page auth, send validation, one-shot close passed');
})().catch((error) => { console.error(error); process.exit(1); });
