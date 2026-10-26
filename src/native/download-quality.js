const DOWNLOAD_QUALITIES = ['auto', '1080p', '720p'];

function normalizeDownloadQuality(value = 'auto') {
  if (!DOWNLOAD_QUALITIES.includes(value)) throw new Error('下载清晰度无效，请选择自动、1080p 或 720p');
  return value;
}

function meetsDownloadQuality({ width, height } = {}, quality = 'auto') {
  quality = normalizeDownloadQuality(quality);
  if (quality === 'auto') return true;
  const dimensions = [Number(width), Number(height)];
  return dimensions.every(value => Number.isFinite(value) && value > 0)
    && Math.min(...dimensions) >= Number.parseInt(quality, 10);
}

// 播放清晰度与下载清晰度分开：同一组档位（auto/1080p/720p），但播放失败时的
// 处理不同（播放允许提示后回退自动档，下载不自动降级），故独立校验入口。
const PLAY_QUALITIES = ['auto', '1080p', '720p'];

function normalizePlayQuality(value = 'auto') {
  if (value == null || value === '') return 'auto';
  if (!PLAY_QUALITIES.includes(value)) throw new Error('播放清晰度无效，请选择自动、1080p 或 720p');
  return value;
}

// 在线缓存键：auto 沿用 vid 本身（兼容既有下载复用/转码缓存按 vid 查找）；
// 指定档位用 vid#quality 隔离，避免先缓存的低清挡住后选的高清（反之亦然）。
function onlineCacheKey(vid, quality = 'auto') {
  const q = normalizePlayQuality(quality);
  return q === 'auto' ? String(vid) : `${vid}#${q}`;
}

module.exports = { normalizeDownloadQuality, meetsDownloadQuality, normalizePlayQuality, onlineCacheKey, PLAY_QUALITIES };
