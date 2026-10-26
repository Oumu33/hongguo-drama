const assert = require('node:assert/strict');
const { HlsStreamSession, rewritePlaylist, pickVariantUrl } = require('./hls-stream');

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1080x1920
hi/index.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
https://cdn.example.com/abs/seg1.ts
#EXT-X-ENDLIST
`;
const pages = {
  'https://src.example.com/master.m3u8': MASTER,
  'https://src.example.com/hi/index.m3u8': MEDIA,
};
const fetchText = async (url) => { if (!(url in pages)) throw new Error('404 ' + url); return pages[url]; };

(async () => {
  // 变体选择：最高码率
  assert.equal(pickVariantUrl(MASTER, 'https://src.example.com/master.m3u8'), 'https://src.example.com/hi/index.m3u8');

  // 纯改写：相对/绝对分片、密钥、初始化段都被登记
  const seen = [];
  const rewritten = rewritePlaylist(MEDIA, 'https://src.example.com/hi/index.m3u8', (kind, abs) => { seen.push([kind, abs]); return `${kind}/index/${seen.length - 1}`; });
  assert.match(rewritten, /URI="key\/index\/0"/);
  assert.ok(seen.some(([k, u]) => k === 'key' && u === 'https://src.example.com/hi/key.bin'));
  assert.ok(seen.some(([k, u]) => k === 'seg' && u === 'https://src.example.com/hi/seg0.ts'));
  assert.ok(seen.some(([k, u]) => k === 'seg' && u === 'https://cdn.example.com/abs/seg1.ts'));
  assert.ok(seen.some(([k, u]) => k === 'seg' && u === 'https://src.example.com/hi/init.mp4'));

  // 会话：init 走主清单选最高变体，playlistText 改写后可按编号取回原始地址
  const session = new HlsStreamSession({ url: 'https://src.example.com/master.m3u8', fetchText });
  await session.init();
  const text = await session.playlistText('index');
  assert.match(text, /seg\/index\/\d+/);
  assert.match(text, /key\/index\/0/);
  const segUrls = [0, 1, 2].map((i) => { try { return session.resourceUrl('index', 'seg', i); } catch (_) { return null; } }).filter(Boolean);
  assert.ok(segUrls.includes('https://src.example.com/hi/seg0.ts'));
  assert.ok(segUrls.includes('https://cdn.example.com/abs/seg1.ts'));
  assert.equal(session.resourceUrl('index', 'key', 0), 'https://src.example.com/hi/key.bin');
  assert.throws(() => session.resourceUrl('index', 'seg', 99), /不存在/);

  // 直播清单（无 ENDLIST）在 init/media 阶段被拒，调用方据此回退
  const live = new HlsStreamSession({ url: 'https://src.example.com/master.m3u8', fetchText: async (url) => url.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlive.m3u8\n' : '#EXTM3U\n#EXTINF:6.0,\na.ts\n' });
  await assert.rejects(() => live.init(), /直播/);

  console.log('hls-stream: variant pick, playlist rewrite, session tables, live rejection passed');
})().catch((error) => { console.error(error); process.exit(1); });
