/*
 * 画面捕获（隔离世界，播放器文档内）。
 *
 * 为什么要三种策略：视频来自 CDN 时，如果服务端没回 CORS 头，canvas.toDataURL 会抛
 * SecurityError（画布被「污染」）。不同内核/源下还有别的路可走，所以依次尝试：
 *   1. canvas.drawImage(video) → toDataURL            （最快，但最容易被跨域保护拦）
 *   2. video.captureStream() + ImageCapture.grabFrame （抓渲染输出，常常能绕开污染）
 *   3. createImageBitmap(video) → canvas              （部分版本可读）
 * 三个都失败就明确告诉用户「受跨域保护，不能截帧」，绝不静默失败。
 *
 * 隐私：截到的帧只回给面板、用于本次 AI 请求；不写 storage、不写日志。是否发送由用户开关决定。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const MAX_WIDTH = 960;
  const JPEG_QUALITY = 0.72;

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function waitForFrame(video, timeoutMs) {
    if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('seeked', onReady);
        clearTimeout(timer);
        resolve(ok);
      };
      const onReady = () => finish(video.readyState >= 2 && video.videoWidth > 0);
      const timer = setTimeout(() => finish(video.readyState >= 2 && video.videoWidth > 0), timeoutMs);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('seeked', onReady);
    });
  }

  function targetSize(video) {
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) return null;
    const scale = Math.min(1, MAX_WIDTH / width);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  /** 9×8 灰度平均值哈希（aHash），用来判断两帧是不是同一页幻灯片。 */
  function hashFromCanvas(canvas) {
    const small = makeCanvas(9, 8);
    const ctx = small.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 9, 8);
    const data = ctx.getImageData(0, 0, 9, 8).data;
    const gray = [];
    for (let i = 0; i < data.length; i += 4) {
      gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
    }
    const average = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    let bits = '';
    for (const value of gray) bits += value > average ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }

  function fromCanvas(canvas, method) {
    return {
      ok: true,
      method: method,
      dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
      hash: hashFromCanvas(canvas),
      width: canvas.width,
      height: canvas.height,
    };
  }

  async function capture(video) {
    if (!video) return { ok: false, reason: 'no-video' };
    if (!(await waitForFrame(video, 1200))) return { ok: false, reason: 'no-frame' };
    const size = targetSize(video);
    if (!size) return { ok: false, reason: 'no-size' };

    const tried = [];

    // 1. 直接画到 canvas
    try {
      const canvas = makeCanvas(size.width, size.height);
      canvas.getContext('2d').drawImage(video, 0, 0, size.width, size.height);
      return fromCanvas(canvas, 'canvas');
    } catch (err) {
      tried.push('canvas:' + (err && err.name ? err.name : 'error'));
    }

    // 2. captureStream + ImageCapture
    try {
      if (typeof video.captureStream === 'function' && typeof ImageCapture === 'function') {
        const stream = video.captureStream();
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('no-track');
        const grabber = new ImageCapture(track);
        const bitmap = await grabber.grabFrame();
        const canvas = makeCanvas(size.width, size.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height);
        if (bitmap.close) bitmap.close();
        track.stop();
        return fromCanvas(canvas, 'stream');
      }
      tried.push('stream:unavailable');
    } catch (err) {
      tried.push('stream:' + (err && err.name ? err.name : 'error'));
    }

    // 3. createImageBitmap
    try {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(video);
        const canvas = makeCanvas(size.width, size.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height);
        if (bitmap.close) bitmap.close();
        return fromCanvas(canvas, 'bitmap');
      }
      tried.push('bitmap:unavailable');
    } catch (err) {
      tried.push('bitmap:' + (err && err.name ? err.name : 'error'));
    }

    return { ok: false, reason: 'blocked', tried: tried };
  }

  function describe(result) {
    if (!result) return '没有尝试截帧';
    if (result.ok) return '可截取画面（' + result.method + '）';
    if (result.reason === 'no-video') return '播放器里没有可读取的 <video> 画面';
    if (result.reason === 'no-frame') return '画面还没准备好，等视频播放/暂停后再试';
    if (result.reason === 'no-size') return '读不到画面尺寸';
    if (result.reason === 'blocked') return '视频受跨域保护，浏览器不允许截帧（三种方式都失败）';
    return '截帧失败（' + result.reason + '）';
  }

  PRN.capture = { capture: capture, describe: describe, MAX_WIDTH: MAX_WIDTH };
})();
