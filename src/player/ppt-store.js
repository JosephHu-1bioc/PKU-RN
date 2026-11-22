/*
 * 课程资料的本地存储（按每节课 sub_id 存在本机，不发送到任何地方）。
 * 同一节重新打开保留；换节/换课互不影响。只存文件名与每页文字；页面图片不存。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const KEY = 'pku_replay_notes_ppt_v1';

  function readRoot() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          const root = result && result[KEY];
          resolve(root && root.byCourse && typeof root.byCourse === 'object' ? root.byCourse : {});
        });
      } catch (err) {
        resolve({});
      }
    });
  }

  function writeRoot(byCourse) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [KEY]: { version: 1, byCourse: byCourse } }, () => {
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

  async function load(courseId) {
    const key = String(courseId || '');
    if (!key) return null;
    const byCourse = await readRoot();
    return byCourse[key] || null;
  }

  async function save(courseId, value) {
    const key = String(courseId || '');
    if (!key) return;
    const byCourse = await readRoot();
    byCourse[key] = value;
    await writeRoot(byCourse);
  }

  async function clear(courseId) {
    const key = String(courseId || '');
    if (!key) return;
    const byCourse = await readRoot();
    delete byCourse[key];
    await writeRoot(byCourse);
  }

  PRN.pptStore = { KEY: KEY, load: load, save: save, clear: clear };
})();
