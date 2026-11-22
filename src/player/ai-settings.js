/*
 * AI 设置的本地存储（独立于笔记的根键，避免和笔记 schema 混在一起）。
 *
 * 只存：providerId / baseURL / key / model / models / deepThink。
 * 不存任何笔记、材料、画面；Key 只留在本机 chrome.storage.local。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const KEY = 'pku_replay_notes_ai_v1';
  const MAX_MODELS = 200;

  function cleanModels(value) {
    if (!Array.isArray(value)) return [];
    const models = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const model = item.trim();
      if (model && models.indexOf(model) === -1) models.push(model);
      if (models.length >= MAX_MODELS) break;
    }
    return models;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      version: 1,
      providerId: String(raw.providerId || 'deepseek'),
      baseURL: String(raw.baseURL || '').trim(),
      key: String(raw.key || '').trim(),
      model: String(raw.model || '').trim(),
      models: cleanModels(raw.models),
      deepThink: !!raw.deepThink,
    };
  }

  function load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(normalize(result && result[KEY]));
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function save(settings) {
    return new Promise((resolve, reject) => {
      const value = normalize(settings) || {};
      value.updatedAt = Date.now();
      try {
        chrome.storage.local.set({ [KEY]: value }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(value);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function clear() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(KEY, () => resolve());
      } catch (err) {
        resolve();
      }
    });
  }

  PRN.aiSettings = { KEY, load, save, clear };
})();
