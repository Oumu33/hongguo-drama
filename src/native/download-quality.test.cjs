const assert = require('node:assert/strict');
const { normalizeDownloadQuality, meetsDownloadQuality, normalizePlayQuality, onlineCacheKey } = require('./download-quality');

// 下载清晰度：原有行为不变
assert.equal(normalizeDownloadQuality('1080p'), '1080p');
assert.equal(normalizeDownloadQuality(), 'auto');
assert.throws(() => normalizeDownloadQuality('540p'), /下载清晰度无效/);
assert.equal(meetsDownloadQuality({ width: 1080, height: 1920 }, '1080p'), true);
assert.equal(meetsDownloadQuality({ width: 720, height: 1280 }, '1080p'), false);
assert.equal(meetsDownloadQuality({ width: 720, height: 1280 }, 'auto'), true);

// 播放清晰度：独立校验，空值按自动
assert.equal(normalizePlayQuality(), 'auto');
assert.equal(normalizePlayQuality(null), 'auto');
assert.equal(normalizePlayQuality(''), 'auto');
assert.equal(normalizePlayQuality('720p'), '720p');
assert.throws(() => normalizePlayQuality('4k'), /播放清晰度无效/);

// 在线缓存键：auto 沿用 vid（兼容下载复用按 vid 查找），指定档位隔离
assert.equal(onlineCacheKey('123', 'auto'), '123');
assert.equal(onlineCacheKey('123'), '123');
assert.equal(onlineCacheKey('123', '1080p'), '123#1080p');
assert.equal(onlineCacheKey('custom:a:9', '720p'), 'custom:a:9#720p');
assert.throws(() => onlineCacheKey('123', 'bad'), /播放清晰度无效/);

console.log('download/play quality: normalization, threshold and cache-key isolation passed');
