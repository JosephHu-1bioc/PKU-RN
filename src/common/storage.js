/*
 * chrome.storage.local 封装。
 *
 * 取舍：
 *  - 单一根键。列表页与播放器两个 content script 通过「同一个键 + storage.onChanged」同步，
 *    不引入消息传递（本轮硬约束），也没有 service worker 参与。
 *  - 所有写操作走 mutate()：读-改-写串行排队。两个 script 同时写也不会互相覆盖。
 *  - 任何含 PII 的原始 URL（学号 / 姓名 / sign / nonce / token）都不进 storage，这里是唯一写入口，
 *    所以只接受「已经是业务字段」的数据。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const KEY = 'pku_replay_notes_v1';
  const VERSION = 1;

  function emptyRoot() {
    return { version: VERSION, records: {}, notes: [] };
  }

  function warn(message) {
    console.warn('[PRN:storage] ' + message);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function toNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /** AI 讲解是笔记的可选附加字段；没有或坏了就当没有，不影响笔记本身。 */
  function normalizeExplain(value) {
    if (!value || typeof value !== 'object') return null;
    const text = typeof value.text === 'string' ? value.text.trim().slice(0, 4000) : '';
    if (!text) return null;
    return {
      text: text,
      model: typeof value.model === 'string' ? value.model.slice(0, 80) : '',
      at: toNumber(value.at, 0),
      via: value.via === 'frame' ? 'frame' : 'text',
    };
  }

  /** 把任意版本/残缺的存储内容收敛成当前 schema；坏数据丢弃而不是抛错。 */
  function normalize(input) {
    const root = emptyRoot();
    if (!input || typeof input !== 'object') return root;

    const records = input.records && typeof input.records === 'object' ? input.records : {};
    Object.keys(records).forEach((key) => {
      const value = records[key];
      if (!value || typeof value !== 'object') return;
      const subId = String(value.subId || key || '').trim();
      if (!subId || subId === 'undefined' || subId === 'null') return;
      root.records[subId] = {
        subId,
        hqyCourseId: value.hqyCourseId != null ? String(value.hqyCourseId) : null,
        label: typeof value.label === 'string' ? value.label : '',
        duration: toNumber(value.duration, 0),
        lastTime: toNumber(value.lastTime, 0),
        updatedAt: toNumber(value.updatedAt, 0),
      };
    });

    const notes = Array.isArray(input.notes) ? input.notes : [];
    root.notes = notes
      .filter((note) => note && typeof note === 'object' && typeof note.id === 'string' && note.subId != null)
      .map((note) => ({
        id: note.id,
        subId: String(note.subId),
        // null 表示「打点时读不到播放位置」，仍然保留这条笔记（无时间戳）
        t: typeof note.t === 'number' && Number.isFinite(note.t) ? note.t : null,
        text: typeof note.text === 'string' ? note.text : '',
        createdAt: toNumber(note.createdAt, 0),
        explain: normalizeExplain(note.explain),
      }));

    if (toNumber(input.version, VERSION) > VERSION) {
      warn('存储版本 ' + input.version + ' 高于当前扩展版本，按当前 schema 只读兼容');
    }
    root.version = VERSION;
    return root;
  }

  function readRaw() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (result) => {
          if (chrome.runtime.lastError) {
            warn('读取失败：' + chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(result ? result[KEY] : null);
        });
      } catch (err) {
        warn('storage 不可用：' + (err && err.message));
        resolve(null);
      }
    });
  }

  function writeRaw(value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [KEY]: value }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function read() {
    return normalize(await readRaw());
  }

  // 所有写入串行化：避免「读-改-写」在两次写之间丢掉对方的改动
  let chain = Promise.resolve();

  function mutate(mutator) {
    const run = chain.then(async () => {
      const draft = clone(await read());
      await mutator(draft);
      draft.version = VERSION;
      await writeRaw(draft);
      return draft;
    });
    chain = run.catch(() => {});
    return run;
  }

  function ensureRecord(root, subId) {
    if (!root.records[subId]) {
      root.records[subId] = {
        subId,
        hqyCourseId: null,
        label: '',
        duration: 0,
        lastTime: 0,
        updatedAt: 0,
      };
    }
    return root.records[subId];
  }

  /**
   * 播放进度回写。duration 只在有效时覆盖，label 只在传入时覆盖
   * （label 由列表页负责，播放器拿不到节次名）。
   */
  async function writePlayhead(subId, patch) {
    if (!subId) return null;
    const lastTime = Number.isFinite(patch.lastTime) ? Math.max(0, patch.lastTime) : null;
    if (lastTime == null) return null;
    const duration = Number.isFinite(patch.duration) && patch.duration > 0 ? patch.duration : null;
    const label = typeof patch.label === 'string' ? patch.label : '';
    return mutate((root) => {
      const record = ensureRecord(root, subId);
      record.lastTime = Math.max(Number(record.lastTime) || 0, lastTime);
      if (duration != null) record.duration = duration;
      if (label.trim()) record.label = label.trim();
      if (patch.hqyCourseId) record.hqyCourseId = String(patch.hqyCourseId);
      record.updatedAt = Date.now();
    });
  }

  function randomTag() {
    const bytes = new Uint8Array(2);
    try {
      crypto.getRandomValues(bytes);
    } catch (err) {
      bytes[0] = Math.floor(Math.random() * 256);
      bytes[1] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function addNote(input) {
    const subId = input && input.subId ? String(input.subId) : '';
    const text = input && typeof input.text === 'string' ? input.text.trim().slice(0, 300) : '';
    if (!subId || !text) return null;
    const note = {
      id: 'n_' + Date.now() + '_' + randomTag(),
      subId,
      t: typeof input.t === 'number' && Number.isFinite(input.t) ? Math.round(input.t * 10) / 10 : null,
      text,
      createdAt: Date.now(),
    };
    await mutate((root) => {
      root.notes.push(note);
    });
    return note;
  }

  async function deleteNote(id) {
    if (!id) return null;
    return mutate((root) => {
      root.notes = root.notes.filter((note) => note.id !== id);
    });
  }

  /** 写入 / 清除某条笔记的 AI 讲解。 */
  async function setNoteExplain(id, explain) {
    if (!id) return null;
    return mutate((root) => {
      const note = root.notes.find((entry) => entry.id === id);
      if (!note) return;
      const normalized = normalizeExplain(explain);
      if (normalized) note.explain = normalized;
      else delete note.explain;
    });
  }

  function notesOf(root, subId) {
    const list = (root && root.notes) || [];
    return list.filter((note) => note.subId === subId).sort((a, b) => {
      const at = a.t == null ? Number.POSITIVE_INFINITY : a.t;
      const bt = b.t == null ? Number.POSITIVE_INFINITY : b.t;
      if (at !== bt) return at - bt;
      return a.createdAt - b.createdAt;
    });
  }

  /** 订阅本地存储变化（两个 content script 之间的唯一同步方式）。 */
  function subscribe(callback) {
    try {
      const listener = (changes, areaName) => {
        if (areaName !== 'local' || !changes || !changes[KEY]) return;
        callback(normalize(changes[KEY].newValue));
      };
      chrome.storage.onChanged.addListener(listener);
      return function unsubscribe() {
        try {
          chrome.storage.onChanged.removeListener(listener);
        } catch (err) {
          /* ignore */
        }
      };
    } catch (err) {
      warn('订阅失败：' + (err && err.message));
      return function noop() {};
    }
  }

  PRN.storage = {
    KEY,
    VERSION,
    read,
    mutate,
    subscribe,
    writePlayhead,
    addNote,
    deleteNote,
    setNoteExplain,
    notesOf,
  };
})();
