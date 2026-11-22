/*
 * 本节字幕/章节的本地存储（按 subId），以及本地字幕服务配置。
 * 只存文字与时间点，不存音频/视频。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const KEY = 'pku_replay_notes_transcript_v1';
  const CFG_KEY = 'pku_replay_notes_transcript_cfg_v1';

  function readRoot() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          const root = result && result[KEY];
          resolve(root && root.bySubId && typeof root.bySubId === 'object' ? root.bySubId : {});
        });
      } catch (err) {
        resolve({});
      }
    });
  }

  function writeRoot(bySubId) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [KEY]: { version: 1, bySubId: bySubId } }, () => {
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

  async function load(subId) {
    const key = String(subId || '');
    if (!key) return null;
    const bySubId = await readRoot();
    return bySubId[key] || null;
  }

  async function save(subId, value) {
    const key = String(subId || '');
    if (!key) return;
    const bySubId = await readRoot();
    bySubId[key] = value;
    await writeRoot(bySubId);
  }

  async function clear(subId) {
    const key = String(subId || '');
    if (!key) return;
    const bySubId = await readRoot();
    delete bySubId[key];
    await writeRoot(bySubId);
  }

  function loadConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(CFG_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve({ serviceURL: 'http://127.0.0.1:8765', language: 'zh' });
            return;
          }
          const value = result && result[CFG_KEY];
          resolve({
            serviceURL: (value && value.serviceURL) || 'http://127.0.0.1:8765',
            language: (value && value.language) || 'zh',
          });
        });
      } catch (err) {
        resolve({ serviceURL: 'http://127.0.0.1:8765', language: 'zh' });
      }
    });
  }

  function saveConfig(value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [CFG_KEY]: value }, () => {
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

  PRN.transcriptStore = {
    KEY: KEY,
    CFG_KEY: CFG_KEY,
    load: load,
    save: save,
    clear: clear,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
  };
})();
