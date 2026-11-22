/*
 * MAIN world 播放器探针（注入到页面世界，不是隔离世界）。
 *
 * 为什么必须有这个文件：
 *   content script 默认跑在「隔离世界」，只共享 DOM；页面 JS 的全局变量（window.CmcPlayer）
 *   和挂在 DOM 节点上的 expando（el.__vue__）在隔离世界里全都看不到。
 *   华栖云播放器实例恰好是页面世界的对象，所以只能在页面世界（MAIN）里读，
 *   再通过 window.postMessage 把「原始数值」传回隔离世界的面板。
 *   实测：隔离世界里 window.CmcPlayer === undefined、el.__vue__ === undefined，DOM 正常。
 *
 * 这个文件的职责刻意做薄：只做「找到播放器 + 转发指令」，不做单位判定、不碰存储、
 * 不发网络请求、不打印任何 URL 或 token。单位换算留在隔离世界，那里有 time.js。
 */
(function () {
  'use strict';

  const CHANNEL = 'v1'; // 与 adapter.js 约定的 postMessage 通道
  const MAX_METHODS = 24;
  const PLAYER_SELECTOR = '#cmcPlayer_container';

  // Object.prototype 上的通用方法对排障没有价值，方法名列表只留播放器自己的 API
  const NOISE_METHODS = new Set([
    'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
    'toString', 'valueOf', 'constructor',
  ]);

  // 这些是真正要用的播放器 API，排在方法名列表最前面；
  // 真实页面里找到的实例可能同时是个 Vue 组件，$xxx / _xxx 这类框架内部方法会非常多，
  // 如果按字母序截断，getPlayTime 会被挤掉（实测踩过一次）。
  const PLAYER_API = [
    'getPlayTime', 'getDuration', 'seekAndPause', 'playSlice', 'pausePlay', 'resumePlay',
    'stopPlay', 'getPlayerById', 'setVolume', 'getVolume', 'mute', 'screenshot', 'pause', 'play',
  ];

  let player = null;
  let from = '';
  let methods = [];

  function isPlayerLike(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
      return typeof value.getPlayTime === 'function';
    } catch (err) {
      return false;
    }
  }

  function collectMethods(object) {
    const names = new Set();
    let current = object;
    let depth = 0;
    while (current && depth < 3) {
      let props = [];
      try {
        props = Object.getOwnPropertyNames(current);
      } catch (err) {
        props = [];
      }
      for (const key of props) {
        if (key === 'constructor' || key.indexOf('__') === 0 || NOISE_METHODS.has(key)) continue;
        try {
          if (typeof object[key] === 'function') names.add(key);
        } catch (err) {
          /* getter 抛错就跳过 */
        }
      }
      try {
        current = Object.getPrototypeOf(current);
      } catch (err) {
        current = null;
      }
      depth += 1;
      if (names.size > MAX_METHODS * 2) break;
    }
    const api = PLAYER_API.filter((name) => names.has(name));
    const rest = Array.from(names)
      .filter((name) => PLAYER_API.indexOf(name) === -1 && name.charAt(0) !== '$' && name.charAt(0) !== '_')
      .sort();
    return api.concat(rest).slice(0, MAX_METHODS);
  }

  // ---- 三级来源 -----------------------------------------------------------

  /** 1. 全局构造器上的静态方法 / 实例注册表（CmcPlayer.getPlayerById 之类）。 */
  function staticLookup() {
    const names = ['CmcPlayer', 'CmcMediaPlayer'];
    for (const name of names) {
      let ctor;
      try {
        ctor = window[name];
      } catch (err) {
        continue;
      }
      if (!ctor) continue;
      if (isPlayerLike(ctor)) return { object: ctor, from: 'window.' + name };

      for (const method of ['getPlayerById', 'getPlayer', 'getInstance', 'get']) {
        let fn;
        try {
          fn = ctor[method];
        } catch (err) {
          continue;
        }
        if (typeof fn !== 'function') continue;
        const ids = ['cmcPlayer_container', 'cmcPlayer', 'player'];
        for (const id of ids) {
          try {
            const candidate = fn.call(ctor, id);
            if (isPlayerLike(candidate)) return { object: candidate, from: name + '.' + method + '(' + id + ')' };
          } catch (err) {
            /* 签名不对，继续试 */
          }
        }
        try {
          const candidate = fn.call(ctor);
          if (isPlayerLike(candidate)) return { object: candidate, from: name + '.' + method + '()' };
        } catch (err) {
          /* ignore */
        }
      }

      for (const mapName of ['players', 'instances', 'playerMap', '_players', 'list']) {
        let map;
        try {
          map = ctor[mapName];
        } catch (err) {
          continue;
        }
        if (!map || typeof map !== 'object') continue;
        let values = [];
        try {
          values = map instanceof Map ? Array.from(map.values()) : Object.keys(map).map((key) => map[key]);
        } catch (err) {
          values = [];
        }
        for (const value of values) {
          if (isPlayerLike(value)) return { object: value, from: name + '.' + mapName };
        }
      }
    }
    return null;
  }

  /** 2. 挂载点上的 Vue 实例树（Vue 2: __vue__；Vue 3: __vueParentComponent）。 */
  function walkVm(vm, seen, depth) {
    if (!vm || typeof vm !== 'object' || depth > 6 || seen.has(vm)) return null;
    seen.add(vm);

    const holders = ['player', 'cmcPlayer', 'cmcPlayerInstance', 'playerInstance', 'mediaPlayer', '_player', 'cmc'];
    for (const key of holders) {
      let candidate;
      try {
        candidate = vm[key];
      } catch (err) {
        continue;
      }
      if (isPlayerLike(candidate)) return candidate;
    }

    try {
      const refs = vm.$refs || {};
      for (const key of Object.keys(refs)) {
        if (isPlayerLike(refs[key])) return refs[key];
      }
    } catch (err) {
      /* ignore */
    }

    try {
      const data = vm._data || vm.$data;
      if (data && typeof data === 'object') {
        for (const key of Object.keys(data)) {
          if (isPlayerLike(data[key])) return data[key];
        }
      }
    } catch (err) {
      /* ignore */
    }

    try {
      const setupState = vm.setupState;
      if (setupState && typeof setupState === 'object') {
        for (const key of Object.keys(setupState)) {
          if (isPlayerLike(setupState[key])) return setupState[key];
        }
      }
    } catch (err) {
      /* ignore */
    }

    let children = [];
    try {
      children = Array.isArray(vm.$children) ? vm.$children : [];
    } catch (err) {
      children = [];
    }
    for (const child of children) {
      const found = walkVm(child, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function vueLookup() {
    const roots = [];
    const pushRoot = (element) => {
      if (!element || roots.length >= 6) return;
      try {
        if (element.__vue__) roots.push(element.__vue__);
      } catch (err) {
        /* ignore */
      }
      try {
        if (element.__vueParentComponent) roots.push(element.__vueParentComponent);
      } catch (err) {
        /* ignore */
      }
    };

    const container = document.querySelector(PLAYER_SELECTOR);
    pushRoot(container);
    pushRoot(document.querySelector('#app'));
    if (container) {
      const descendants = container.querySelectorAll('*');
      for (let i = 0; i < descendants.length && i < 80 && roots.length < 6; i += 1) pushRoot(descendants[i]);
    }

    const seen = new Set();
    for (const root of roots) {
      const found = walkVm(root, seen, 0);
      if (found) return { object: found, from: 'vue' };
    }
    return null;
  }

  /** 3. 全局属性扫描：最脏但最有效，实例常常直接挂在 window 上。 */
  const SKIP_KEYS = new Set([
    'window', 'self', 'document', 'location', 'top', 'parent', 'frames', 'globalThis', 'chrome',
    'console', 'navigator', 'history', 'screen', 'performance', 'localStorage', 'sessionStorage',
    'crypto', 'indexedDB', 'speechSynthesis', 'customElements',
  ]);

  // 扫 window 会碰到页面的 getter，别在每次轮询都扫一遍：最多 1.5 秒一次
  const WINDOW_SCAN_INTERVAL_MS = 1500;
  let lastWindowScanAt = 0;

  function windowLookup() {
    const now = Date.now();
    if (now - lastWindowScanAt < WINDOW_SCAN_INTERVAL_MS) return null;
    lastWindowScanAt = now;

    let keys;
    try {
      keys = Object.getOwnPropertyNames(window);
    } catch (err) {
      return null;
    }
    let scanned = 0;
    for (const key of keys) {
      if (SKIP_KEYS.has(key) || key.indexOf('webkit') === 0) continue;
      if (scanned > 2500) break;
      scanned += 1;
      let value;
      try {
        value = window[key];
      } catch (err) {
        continue;
      }
      if (isPlayerLike(value)) return { object: value, from: 'window.' + key };
    }
    return null;
  }

  function ensurePlayer() {
    if (player && isPlayerLike(player)) return true;
    const found = staticLookup() || vueLookup() || windowLookup();
    if (!found) {
      player = null;
      from = '';
      methods = [];
      return false;
    }
    player = found.object;
    from = found.from;
    methods = collectMethods(player);
    return true;
  }

  // ---- 指令 ---------------------------------------------------------------

  /** 只从页面自己的 resource timing 里读媒体地址，不主动发请求。 */
  function collectMedia() {
    const urls = new Set();
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        const name = entry && entry.name ? String(entry.name) : '';
        if (!/^https?:/i.test(name)) continue;
        if (/\.(m3u8|mp4|m4a|mp3|aac|flv|ts)(\?|#|$)/i.test(name)) urls.add(name);
      }
    } catch (err) {
      /* 拿不到就算了 */
    }
    try {
      const video = document.querySelector('video');
      const src = video && (video.currentSrc || video.src);
      if (src && /^https?:/i.test(src)) urls.add(src);
    } catch (err) {
      /* ignore */
    }
    return Array.from(urls).slice(0, 30);
  }

  function readState() {
    if (!ensurePlayer()) return { level: 'none' };
    const rawTime = readNumber(player, 'getPlayTime');
    const rawDuration = readNumber(player, 'getDuration');
    return {
      level: 'L1',
      from: from,
      methods: methods,
      rawTime: rawTime,
      rawDuration: rawDuration,
      hasSeek: typeof player.seekAndPause === 'function',
      hasPause: typeof player.pausePlay === 'function' || typeof player.pause === 'function',
      hasResume: typeof player.resumePlay === 'function' || typeof player.play === 'function',
    };
  }

  function readNumber(target, method) {
    try {
      if (typeof target[method] !== 'function') return null;
      const value = Number(target[method]());
      return Number.isFinite(value) ? value : null;
    } catch (err) {
      return null;
    }
  }

  function callFirst(names) {
    if (!player) return false;
    for (const name of names) {
      try {
        if (typeof player[name] === 'function') {
          player[name]();
          return true;
        }
      } catch (err) {
        /* 试下一个 */
      }
    }
    return false;
  }

  function seek(arg) {
    if (!ensurePlayer()) return { ok: false, reason: 'no-player' };
    if (typeof player.seekAndPause !== 'function') return { ok: false, reason: 'no-seek' };
    try {
      player.seekAndPause(arg);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'throw' };
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__prn !== CHANNEL || data.kind !== 'req') return;
    let payload;
    switch (data.op) {
      case 'probe':
      case 'sample':
        payload = readState();
        break;
      case 'seek':
        payload = seek(Number(data.arg));
        break;
      case 'pause':
        payload = { ok: callFirst(['pausePlay', 'pause']) };
        break;
      case 'resume':
        payload = { ok: callFirst(['resumePlay', 'play']) };
        break;
      case 'media':
        payload = { ok: true, urls: collectMedia() };
        break;
      default:
        payload = { ok: false, reason: 'unknown-op' };
    }
    try {
      window.postMessage(Object.assign({ __prn: CHANNEL, kind: 'res', id: data.id }, payload), '*');
    } catch (err) {
      /* ignore */
    }
  }, false);
})();
