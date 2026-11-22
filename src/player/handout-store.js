/*
 * 本节讲义的本地存储（按 subId 存）：时间轴、分页、讲义正文。
 * 只存文字，不存任何画面/图片。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const KEY = 'pku_replay_notes_handout_v1';

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

  PRN.handoutStore = { KEY: KEY, load: load, save: save, clear: clear };
})();
