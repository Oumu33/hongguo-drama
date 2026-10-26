// HLS 真流式会话：只改写播放列表、按需取分片，不再整集下载 remux。
// 原理：主进程把远端 m3u8 改写成本地协议地址（分片/密钥/子列表都换成会话内编号），
// 渲染层用 hls.js 边播边向主进程要分片，主进程收到请求才去源站取那一片。
// 解密（AES-128）由 hls.js 按列表里的 EXT-X-KEY 在本地完成，与整集下载路径的密钥处理互不干扰。
// 仅支持点播（须有 EXT-X-ENDLIST）；直播列表在 init 时抛错，调用方回退旧的整集准备路径（旧路径同样不支持直播）。

function rewritePlaylist(text, baseUrl, register) {
  // register(kind, absoluteUrl) -> 本地相对地址；kind: 'seg' | 'key' | 'sub'
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let expectUri = null; // 'seg' 表示下一行 URI 是媒体/变体地址
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const value = line.trim();
    if (!value) { out.push(rawLine); continue; }
    if (!value.startsWith('#')) {
      const abs = new URL(value, baseUrl).href;
      out.push(register(expectUri || 'seg', abs));
      expectUri = null;
      continue;
    }
    let kind = null;
    if (/^#EXT-X-(?:SESSION-)?KEY:/.test(value)) kind = 'key';
    else if (/^#EXT-X-MAP:/.test(value)) kind = 'seg';
    else if (/^#EXT-X-MEDIA:/.test(value) || /^#EXT-X-I-FRAME-STREAM-INF:/.test(value)) kind = 'sub';
    if (value.startsWith('#EXT-X-STREAM-INF:')) { out.push(line); expectUri = 'sub'; continue; }
    if (!kind) { out.push(line); continue; }
    const matches = [...line.matchAll(/\bURI="([^"]*)"/g)];
    if ((line.match(/\bURI\s*=/g) || []).length !== matches.length) throw new Error('HLS 地址格式无效');
    let result = line;
    for (const match of matches) {
      const abs = new URL(match[1], baseUrl).href;
      result = result.replace(match[0], `URI="${register(kind, abs)}"`);
    }
    out.push(result);
  }
  return out.join('\n');
}

function pickVariantUrl(masterText, baseUrl) {
  const lines = String(masterText).split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(lines[i].slice(lines[i].indexOf(':') + 1))?.[1]) || 0;
    const uri = lines[i + 1]?.trim();
    if (uri && !uri.startsWith('#') && (!best || bandwidth > best.bandwidth)) best = { bandwidth, url: new URL(uri, baseUrl).href };
  }
  return best?.url || null;
}

class HlsStreamSession {
  // fetchText(url) -> Promise<string>，由调用方注入（带源站请求头与安全校验）
  constructor({ url, fetchText }) {
    if (!url) throw new Error('缺少 HLS 地址');
    if (typeof fetchText !== 'function') throw new Error('缺少清单读取函数');
    this.rootUrl = url;
    this.fetchText = fetchText;
    this.playlists = new Map(); // name -> { sourceUrl, text|null, tables: { seg: [], key: [], sub: [] } }
    this.subCount = 0;
  }

  async init() {
    const rootText = await this.fetchText(this.rootUrl);
    if (!rootText.trimStart().startsWith('#EXTM3U')) throw new Error('无效 HLS 清单');
    let mediaUrl = this.rootUrl;
    let mediaText = rootText;
    if (/#EXT-X-STREAM-INF:/.test(rootText)) {
      const variant = pickVariantUrl(rootText, this.rootUrl);
      if (!variant) throw new Error('HLS 主清单没有可用变体');
      mediaUrl = variant;
      mediaText = await this.fetchText(mediaUrl);
      if (!mediaText.trimStart().startsWith('#EXTM3U')) throw new Error('无效 HLS 清单');
    }
    if (/#EXTINF:/.test(mediaText) && !/#EXT-X-ENDLIST/.test(mediaText)) {
      throw new Error('暂不支持未结束的直播清单');
    }
    this.playlists.set('index', { sourceUrl: mediaUrl, text: mediaText, tables: null });
    return this;
  }

  registerSub(sourceUrl) {
    for (const [name, pl] of this.playlists) if (pl.sourceUrl === sourceUrl && name !== 'index') return name;
    const name = `sub${this.subCount++}`;
    this.playlists.set(name, { sourceUrl, text: null, tables: null });
    return name;
  }

  async playlistText(name) {
    const pl = this.playlists.get(name);
    if (!pl) throw new Error('HLS 子清单不存在');
    if (pl.text == null) pl.text = await this.fetchText(pl.sourceUrl);
    if (!pl.text.trimStart().startsWith('#EXTM3U')) throw new Error('无效 HLS 清单');
    const tables = { seg: [], key: [], sub: [] };
    const register = (kind, abs) => {
      if (kind === 'sub') {
        const subName = this.registerSub(abs);
        return `${subName}.m3u8`;
      }
      const list = tables[kind];
      let idx = list.indexOf(abs);
      if (idx === -1) { list.push(abs); idx = list.length - 1; }
      return `${kind}/${name}/${idx}`;
    };
    const rewritten = rewritePlaylist(pl.text, pl.sourceUrl, register);
    pl.tables = tables;
    return rewritten;
  }

  resourceUrl(name, kind, index) {
    const pl = this.playlists.get(name);
    const list = pl?.tables?.[kind];
    const url = list?.[Number(index)];
    if (!url) throw new Error('HLS 资源不存在');
    return url;
  }
}

module.exports = { HlsStreamSession, rewritePlaylist, pickVariantUrl };
