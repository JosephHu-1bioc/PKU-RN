/**
 * MAIN-world 录播下载器。
 *
 * 逻辑移植自 PKU-Art（GPL-3.0，https://github.com/zhuozhiyongde/PKU-Art）的
 * initializeDirectDownload / downloadHlsVideo：截获 get-sub-info-by-auth-data 的
 * 响应，拿到 HLS 地址，按网页播放链路拉取分片、AES-128 解密、流式写成 .ts。
 *
 * 该脚本不直接操作扩展 API；面板通过 dispatchEvent('prn-video-download-request')
 * 请求下载，进度通过 window.postMessage 回传。下载地址和 token 不离开页面。
 */
(function () {
  'use strict';

  if (window.__PRN_DOWNLOAD_PROBE__) return;
  window.__PRN_DOWNLOAD_PROBE__ = true;

  const HLS_TEMP_PREFIX = 'prn-hls-';
  const MAX_SEGMENT_RETRIES = 8;
  let info = null;
  let downloading = false;
  let currentAbort = null;
  let paused = false;
  let pauseWaiters = [];
  let resumePump = null;
  let lastProgressAt = 0;

  function waitIfPaused() {
    if (!paused) return Promise.resolve();
    return new Promise((resolve) => pauseWaiters.push(resolve));
  }

  function wakePauseWaiters() {
    const waiters = pauseWaiters;
    pauseWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function setPaused(value) {
    paused = Boolean(value);
    if (!paused) {
      wakePauseWaiters();
      if (typeof resumePump === 'function') resumePump();
    }
    post({
      type: paused ? 'prn-video-download-paused' : 'prn-video-download-resumed',
    });
  }

  function post(payload) {
    try {
      window.postMessage(Object.assign({ source: 'prn-download-probe' }, payload), '*');
    } catch (error) {
      /* ignore */
    }
  }

  function sanitizeFileName(value) {
    return String(value || '课堂录像.ts')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  function acceptDownloadJson(json) {
    if (!json || !Array.isArray(json.list) || !json.list[0]) return;
    const item = json.list[0];
    if (!item.sub_content) return;
    try {
      const film = typeof item.sub_content === 'string'
        ? JSON.parse(item.sub_content)
        : item.sub_content;
      const playback = film && film.save_playback;
      const contents = playback && playback.contents;
      const first = Array.isArray(contents) ? (contents[0] && (contents[0].preview || contents[0])) : contents;
      const url = typeof first === 'string' ? first : '';
      if (!url) return;
      const isHls = (playback && playback.is_m3u8 === 'yes') || /\.m3u8(?:$|\?)/i.test(url);
      const parts = [item.title, item.sub_title, item.lecturer_name].filter(Boolean);
      info = {
        url: url,
        isHls: isHls,
        href: window.location.href,
        fileName: sanitizeFileName((parts.join(' - ') || '课堂录像') + (isHls ? '.ts' : '.mp4')),
      };
      post({ type: 'prn-download-ready', fileName: info.fileName, isHls: info.isHls, url: info.url, referer: window.location.href });
    } catch (error) {
      /* 页面数据格式变化时静默失败，面板会提示未截获 */
    }
  }

  function inspectResponse(url, response) {
    if (!url || String(url).indexOf('get-sub-info-by-auth-data') < 0) return;
    try {
      if (typeof response === 'string') acceptDownloadJson(JSON.parse(response));
      else if (response && typeof response === 'object') acceptDownloadJson(response);
    } catch (error) {
      /* ignore */
    }
  }

  // 教学网播放器使用 XHR 获取录播信息；必须在页面脚本之前 patch。
  try {
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.setRequestHeader = function () {
      try {
        this.__prnHeaders = this.__prnHeaders || {};
        this.__prnHeaders[String(arguments[0]).toLowerCase()] = String(arguments[1]);
      } catch (error) {
        /* ignore */
      }
      return originalSetRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          let response = this.response;
          if (response == null && typeof this.responseText === 'string') response = this.responseText;
          inspectResponse(this.responseURL, response);
        } catch (error) {
          /* ignore */
        }
      });
      return originalSend.apply(this, arguments);
    };
  } catch (error) {
    /* ignore */
  }

  // 兼容页面改为 fetch 的情况
  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function () {
        const promise = originalFetch.apply(this, arguments);
        try {
          const input = arguments[0];
          const url = typeof input === 'string' ? input : (input && input.url);
          promise.then((response) => {
            try {
              if (url && String(url).indexOf('get-sub-info-by-auth-data') >= 0) {
                response.clone().json().then((json) => acceptDownloadJson(json)).catch(() => {});
              }
            } catch (error) {
              /* ignore */
            }
          }).catch(() => {});
        } catch (error) {
          /* ignore */
        }
        return promise;
      };
    }
  } catch (error) {
    /* ignore */
  }

  function parseAttributes(line) {
    const attributes = {};
    const content = line.slice(line.indexOf(':') + 1);
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match;
    while ((match = pattern.exec(content))) {
      const value = match[2];
      attributes[match[1]] = value.startsWith('"') ? value.slice(1, -1) : value;
    }
    return attributes;
  }

  function parseIv(value) {
    const normalized = String(value).replace(/^0x/i, '').padStart(32, '0');
    if (!/^[0-9a-f]{32}$/i.test(normalized)) throw new Error('不支持的 HLS IV');
    return new Uint8Array(normalized.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
  }

  function sequenceIv(sequence) {
    const iv = new Uint8Array(16);
    let value = BigInt(sequence);
    for (let index = iv.length - 1; index >= 0; index -= 1) {
      iv[index] = Number(value & 0xffn);
      value >>= 8n;
    }
    return iv;
  }

  async function fetchResource(url, responseType, signal) {
    let lastError;
    for (let attempt = 0; attempt < MAX_SEGMENT_RETRIES; attempt += 1) {
      if (signal && signal.aborted) throw new DOMException('已取消', 'AbortError');
      try {
        const response = await fetch(url, {
          credentials: attempt === 0 ? 'include' : 'omit',
          signal: signal,
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return responseType === 'text' ? await response.text() : await response.arrayBuffer();
      } catch (error) {
        lastError = error;
        if (error.name === 'AbortError') throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 8000)));
      }
    }
    throw new Error('获取视频分片失败：' + (lastError && lastError.message ? lastError.message : '未知错误'));
  }

  async function resolvePlaylist(playlistUrl, signal, depth) {
    if ((depth || 0) > 3) throw new Error('HLS 播放列表嵌套过深');
    const text = await fetchResource(playlistUrl, 'text', signal);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attributes = parseAttributes(lines[index]);
      const variantPath = lines.slice(index + 1).find((line) => !line.startsWith('#'));
      if (variantPath) {
        variants.push({
          bandwidth: Number(attributes.BANDWIDTH || 0),
          url: new URL(variantPath, playlistUrl).href,
        });
      }
    }
    if (variants.length) {
      variants.sort((left, right) => right.bandwidth - left.bandwidth);
      return resolvePlaylist(variants[0].url, signal, (depth || 0) + 1);
    }
    let mediaSequence = 0;
    let currentKey = null;
    let pendingDuration = 0;
    const segments = [];
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attributes = parseAttributes(line);
        if (attributes.METHOD === 'NONE') currentKey = null;
        else if (attributes.METHOD === 'AES-128' && attributes.URI) {
          currentKey = {
            url: new URL(attributes.URI, playlistUrl).href,
            iv: attributes.IV ? parseIv(attributes.IV) : null,
          };
        } else {
          throw new Error('不支持的 HLS 加密方式');
        }
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      } else if (line.startsWith('#EXT-X-BYTERANGE:') || line.startsWith('#EXT-X-MAP:')) {
        throw new Error('暂不支持 Byte Range 或 fMP4 的 HLS');
      } else if (!line.startsWith('#')) {
        segments.push({
          url: new URL(line, playlistUrl).href,
          sequence: mediaSequence + segments.length,
          key: currentKey ? Object.assign({}, currentKey) : null,
          duration: pendingDuration,
        });
        pendingDuration = 0;
      }
    }
    if (!segments.length) throw new Error('HLS 播放列表里没有分片');
    return segments;
  }

  async function createOutput(fileName) {
    if (window.top === window.self && typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'MPEG-TS 视频', accept: { 'video/mp2t': ['.ts'] } }],
        });
        const writable = await handle.createWritable();
        return {
          type: 'file-picker',
          write: (chunk) => writable.write(chunk),
          close: () => writable.close(),
          abort: () => writable.abort(),
          async remove() {
            try {
              if (typeof handle.remove === 'function') {
                await handle.remove();
                return true;
              }
            } catch (error) {
              /* 继续尝试截断 */
            }
            try {
              const truncate = await handle.createWritable();
              await truncate.close();
              return true;
            } catch (error) {
              return false;
            }
          },
        };
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        // 用户激活过期 / 浏览器不允许选择器时，退回 OPFS 流式保存
      }
    }
    if (!navigator.storage || !navigator.storage.getDirectory) {
      throw new Error('当前浏览器不支持大文件流式保存');
    }
    const root = await navigator.storage.getDirectory();
    const tempName = HLS_TEMP_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ts';
    const handle = await root.getFileHandle(tempName, { create: true });
    const writable = await handle.createWritable();
    let closed = false;
    return {
      type: 'browser-download',
      async write(chunk) {
        await writable.write(chunk);
      },
      async close() {
        await writable.close();
        closed = true;
        const file = await handle.getFile();
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          root.removeEntry(tempName).catch(() => {});
        }, 5 * 60 * 1000);
      },
      async abort() {
        if (!closed) await writable.abort().catch(() => {});
        await root.removeEntry(tempName).catch(() => {});
      },
      async remove() {
        if (!closed) await writable.abort().catch(() => {});
        try {
          await root.removeEntry(tempName);
          return true;
        } catch (error) {
          return false;
        }
      },
    };
  }

  async function downloadHls(url, fileName) {
    const signal = currentAbort.signal;
    const output = await createOutput(fileName);
    let outputClosed = false;
    try {
      post({ type: 'prn-video-download-progress', stage: '正在读取视频分片列表…', percent: 1 });
      const segments = await resolvePlaylist(url, signal, 0);
      const keys = new Map();
      const getKey = (keyUrl) => {
        if (!keys.has(keyUrl)) {
          keys.set(keyUrl, fetchResource(keyUrl, 'arrayBuffer', signal).then((raw) => {
            if (raw.byteLength !== 16) throw new Error('HLS 密钥长度异常');
            return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
          }));
        }
        return keys.get(keyUrl);
      };
      let downloadedBytes = 0;
      let completed = 0;
      let lastReport = 0;
      const concurrency = 6;
      const windowSize = 18;
      const chunks = new Map();
      let scheduled = 0;
      let active = 0;
      let failed = null;
      let currentBase = 0;

      const pump = (base) => {
        if (paused) return;
        while (!failed && active < concurrency && scheduled < segments.length
          && scheduled - base < windowSize) {
          const index = scheduled;
          scheduled += 1;
          active += 1;
          const segment = segments[index];
          fetchResource(segment.url, 'arrayBuffer', signal)
            .then(async (encrypted) => {
              if (!segment.key) return encrypted;
              const key = await getKey(segment.key.url);
              const iv = segment.key.iv || sequenceIv(segment.sequence);
              return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, encrypted);
            })
            .then((chunk) => chunks.set(index, chunk))
            .catch((error) => { failed = error; })
            .finally(() => { active -= 1; pump(base); });
        }
      };
      resumePump = () => pump(currentBase);

      for (let index = 0; index < segments.length; index += 1) {
        await waitIfPaused();
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        currentBase = index;
        pump(index);
        while (!chunks.has(index) && !failed) {
          if (signal.aborted) throw new DOMException('已取消', 'AbortError');
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        if (failed) throw failed;
        await waitIfPaused();
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        const chunk = chunks.get(index);
        chunks.delete(index);
        await output.write(chunk);
        downloadedBytes += chunk.byteLength;
        completed += 1;
        const now = Date.now();
        if (now - lastReport > 240 || completed === segments.length) {
          lastReport = now;
          post({
            type: 'prn-video-download-progress',
            stage: '正在下载并解密 ' + completed + ' / ' + segments.length + ' 个分片',
            percent: Math.round((completed / segments.length) * 100),
            done: completed,
            total: segments.length,
            bytes: downloadedBytes,
          });
        }
      }
      post({ type: 'prn-video-download-progress', stage: '正在保存 TS 文件…', percent: 99 });
      await output.close();
      outputClosed = true;
      post({ type: 'prn-video-download-done', fileName: fileName, bytes: downloadedBytes });
    } catch (error) {
      if (!outputClosed) {
        await output.abort().catch(() => {});
        if (typeof output.remove === 'function') await output.remove().catch(() => {});
      }
      throw error;
    }
  }

  async function startDownload() {
    if (downloading) {
      post({ type: 'prn-video-download-error', message: '已经有下载任务在进行' });
      return;
    }
    if (!info) {
      post({ type: 'prn-video-download-unavailable', message: '还没有截获课程视频地址，请刷新页面后重试' });
      return;
    }
    downloading = true;
    paused = false;
    pauseWaiters = [];
    resumePump = null;
    currentAbort = new AbortController();
    post({ type: 'prn-video-download-started', fileName: info.fileName, isHls: info.isHls });
    try {
      if (info.isHls) {
        await downloadHls(info.url, info.fileName);
      } else {
        const link = document.createElement('a');
        link.href = info.url;
        link.download = info.fileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        post({ type: 'prn-video-download-done', fileName: info.fileName, bytes: 0 });
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        post({ type: 'prn-video-download-cancelled', message: '已取消，未完成的下载文件已删除' });
      } else if (error && error.name === 'SecurityError') {
        post({ type: 'prn-video-download-error', message: '浏览器没有允许保存文件，请重试并选择保存位置' });
      } else {
        post({
          type: 'prn-video-download-error',
          message: (error && error.message) || '视频下载失败',
        });
      }
    } finally {
      downloading = false;
      paused = false;
      wakePauseWaiters();
      resumePump = null;
      currentAbort = null;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    const type = event.data.type;
    if (type === 'prn-video-download-request') {
      startDownload().catch(() => {});
      return;
    }
    if (type === 'prn-video-download-reset') {
      if (info && event.data.href && info.href !== event.data.href) info = null;
      return;
    }
    if (type === 'prn-video-download-info-request') {
      post({
        type: 'prn-video-download-info',
        videoSource: info ? {
          url: info.url,
          isHls: info.isHls,
          fileName: info.fileName,
          referer: window.location.href,
        } : null,
      });
      return;
    }
    if (!downloading) return;
    if (type === 'prn-video-download-pause') {
      setPaused(true);
      return;
    }
    if (type === 'prn-video-download-resume') {
      setPaused(false);
      return;
    }
    if (type === 'prn-video-download-cancel') {
      post({ type: 'prn-video-download-cancelling' });
      paused = false;
      wakePauseWaiters();
      if (currentAbort) currentAbort.abort();
    }
  });
  window.addEventListener('prn-video-download-request', () => {
    startDownload().catch(() => {});
  });
})();
