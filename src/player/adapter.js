/*
 * 播放器适配层（隔离世界）。
 *
 * 这一层只做三件事：
 *   1. 通过 postMessage 向 MAIN world 的 probe.js 要「原始数值」（因为隔离世界看不到页面对象）；
 *   2. 用 time.js 判定单位、缓存时长、算调试信息；
 *   3. 需要时用 <video> 兜底（L2）——DOM 是隔离世界可见的，所以 L2 可以完全本地完成。
 *
 * 为什么先探测再选路径：华栖云把播放能力封装在播放器对象里，<video> 只是它的内部实现，
 * 有的皮肤甚至拿不到。L1 拿不到才降级 L2，L2 也没有就只读。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const CHANNEL = 'v1'; // 与 probe.js 约定的 postMessage 通道
  const PROBE_TIMEOUT_MS = 1200;
  const READY_TIMEOUT_MS = 15000;
  const PROBE_STEP_MS = 400;
  const SEEK_SETTLE_MS = 260;
  const L2_SETTLE_MS = 120;

  const internal = {
    duration: NaN,
    durationAt: 0,
    hasSeek: false,
    video: null,
  };

  const adapter = {
    level: 'none', // 'L1' | 'L2' | 'none'
    rawTime: null, // 播放器返回的原始值（调试区原样展示）
    rawDuration: null,
    unit: '?', // 时间单位判定：'s' | 'ms' | 'unknown'
    seekArgUnit: '?', // seekAndPause 实际接受的参数单位
    methods: [],
    playerFrom: '',
  };

  // ---- 与 MAIN world 的请求/应答 ------------------------------------------

  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__prn !== CHANNEL || data.kind !== 'res') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    entry.resolve(data);
  });

  /** 回 null 表示桥接没响应（probe.js 没注入 / 页面世界还没就绪）。 */
  function request(op, arg, timeoutMs) {
    const id = (seq += 1);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs || PROBE_TIMEOUT_MS);
      pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
      });
      try {
        window.postMessage({ __prn: CHANNEL, kind: 'req', id, op, arg }, '*');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- L2：<video> 兜底（DOM 在隔离世界可见）------------------------------

  function findVideo() {
    let videos = [];
    try {
      videos = Array.from(document.querySelectorAll('video'));
    } catch (err) {
      videos = [];
    }
    if (!videos.length) return null;
    return videos.find((video) => !video.paused || video.readyState > 0) || videos[0];
  }

  function setLevelL2(video) {
    internal.video = video;
    internal.duration = NaN;
    internal.durationAt = 0;
    adapter.level = 'L2';
    adapter.playerFrom = 'video';
    adapter.methods = ['video.currentTime', 'video.duration', 'video.pause', 'video.play'];
  }

  function setLevelNone() {
    adapter.level = 'none';
    adapter.playerFrom = '';
    adapter.methods = [];
    adapter.rawTime = null;
    internal.duration = NaN;
    internal.durationAt = 0;
  }

  function readL1(reply) {
    const duration = normalizeDuration(reply.rawDuration);
    const normalized = PRN.time.normalizePlayTime(reply.rawTime, duration);
    adapter.rawTime = reply.rawTime;
    adapter.rawDuration = reply.rawDuration;
    adapter.unit = normalized.unit;
    internal.duration = duration;
    internal.durationAt = Date.now();
    internal.hasSeek = !!reply.hasSeek;
    return { level: 'L1', seconds: normalized.seconds, duration: duration };
  }

  function normalizeDuration(raw) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return NaN;
    adapter.rawDuration = raw;
    return PRN.time.normalizePlayTime(raw, null).seconds;
  }

  function readL2() {
    const video = internal.video && internal.video.isConnected ? internal.video : findVideo();
    if (!video) {
      setLevelNone();
      return { level: 'none', seconds: NaN, duration: NaN };
    }
    internal.video = video;
    const seconds = Number(video.currentTime);
    const duration = Number(video.duration);
    adapter.rawTime = Number.isFinite(seconds) ? seconds : null;
    adapter.unit = 's';
    return {
      level: 'L2',
      seconds: Number.isFinite(seconds) ? seconds : NaN,
      duration: Number.isFinite(duration) && duration > 0 ? duration : NaN,
    };
  }

  /** 探测一次：先问页面世界的播放器，再退到 <video>。 */
  async function probe() {
    const reply = await request('probe');
    if (reply && reply.level === 'L1') {
      adapter.level = 'L1';
      adapter.playerFrom = reply.from || 'page';
      adapter.methods = Array.isArray(reply.methods) ? reply.methods : [];
      internal.hasSeek = !!reply.hasSeek;
      internal.duration = NaN;
      internal.durationAt = 0;
      return 'L1';
    }
    const video = findVideo();
    if (video) {
      setLevelL2(video);
      return 'L2';
    }
    setLevelNone();
    return 'none';
  }

  /** 取一次完整样本（时间 + 时长）。读不到时 seconds 为 NaN。 */
  async function sample() {
    if (adapter.level === 'L1') {
      const reply = await request('sample');
      if (reply && reply.level === 'L1') return readL1(reply);
      // 桥接失联或播放器消失：重新探测，别卡死在 L1
      const level = await probe();
      if (level === 'L2') return readL2();
      return { level: level, seconds: NaN, duration: NaN };
    }
    if (adapter.level === 'L2') return readL2();
    return { level: 'none', seconds: NaN, duration: NaN };
  }

  /** 等播放器就绪：轮询 + MutationObserver 唤醒，超时返回 'none'。 */
  async function waitReady(timeoutMs) {
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : READY_TIMEOUT_MS;
    const deadline = Date.now() + limit;
    let wake = null;

    const observer = new MutationObserver(() => {
      if (!wake) return;
      const resolve = wake;
      wake = null;
      resolve();
    });
    try {
      // 文档结构变化（#cmcPlayer_container 挂载）时立刻再探一次，而不是死等轮询
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) {
      /* ignore */
    }

    try {
      for (;;) {
        const level = await probe();
        if (level !== 'none') return level;
        if (Date.now() >= deadline) return 'none';
        await Promise.race([
          sleep(PROBE_STEP_MS),
          new Promise((resolve) => {
            wake = resolve;
          }),
        ]);
      }
    } finally {
      observer.disconnect();
    }
  }

  async function seek(seconds) {
    const target = Number(seconds);
    if (!Number.isFinite(target) || target < 0) return { ok: false, reason: 'invalid-target' };

    if (adapter.level === 'L1') {
      const preferMs = adapter.unit === 'ms';
      adapter.seekArgUnit = preferMs ? 'ms' : 's';
      const first = await request('seek', preferMs ? target * 1000 : target);
      if (!first || !first.ok) return { ok: false, reason: first ? first.reason : 'no-bridge' };

      await sleep(SEEK_SETTLE_MS);
      const check = await sample();
      if (Number.isFinite(check.seconds) && Math.abs(check.seconds - target) <= 1.5) {
        return { ok: true, actual: check.seconds, unit: adapter.seekArgUnit };
      }

      // 参数单位猜错了：换另一种单位再试一次，结论留在调试区
      adapter.seekArgUnit = preferMs ? 's' : 'ms';
      const second = await request('seek', preferMs ? target : target * 1000);
      if (!second || !second.ok) return { ok: false, reason: 'seek-failed' };
      await sleep(SEEK_SETTLE_MS);
      const retry = await sample();
      return {
        ok: Number.isFinite(retry.seconds) && Math.abs(retry.seconds - target) <= 1.5,
        actual: retry.seconds,
        unit: adapter.seekArgUnit,
      };
    }

    if (adapter.level === 'L2') {
      const video = internal.video || findVideo();
      if (!video) return { ok: false, reason: 'no-target' };
      try {
        video.currentTime = target;
        adapter.seekArgUnit = 's';
        await sleep(L2_SETTLE_MS);
        const after = readL2();
        return { ok: Math.abs(after.seconds - target) <= 1.5, actual: after.seconds, unit: 's' };
      } catch (err) {
        return { ok: false, reason: 'video-seek-failed' };
      }
    }

    return { ok: false, reason: 'no-target' };
  }

  async function pause() {
    if (adapter.level === 'L1') {
      const reply = await request('pause');
      return !!(reply && reply.ok);
    }
    if (adapter.level === 'L2') {
      const video = internal.video || findVideo();
      if (!video) return false;
      try {
        video.pause();
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  }

  async function resume() {
    if (adapter.level === 'L1') {
      const reply = await request('resume');
      return !!(reply && reply.ok);
    }
    if (adapter.level === 'L2') {
      const video = internal.video || findVideo();
      if (!video) return false;
      try {
        const result = video.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  }

  /**
   * 给画面捕获用：拿当前文档里的 <video>。
   * 即使 L1 找到了播放器对象，DOM 里通常也还有一个 <video> 在出画面。
   */
  function getVideo() {
    if (internal.video && internal.video.isConnected) return internal.video;
    const found = findVideo();
    if (found) internal.video = found;
    return found;
  }

  adapter.probe = probe;
  async function media() {
    if (adapter.level === 'L1') {
      const reply = await request('media');
      return reply && Array.isArray(reply.urls) ? reply.urls : [];
    }
    return [];
  }

  adapter.getVideo = getVideo;
  adapter.sample = sample;
  adapter.media = media;
  adapter.waitReady = waitReady;
  adapter.seek = seek;
  adapter.pause = pause;
  adapter.resume = resume;

  PRN.adapter = adapter;
})();
