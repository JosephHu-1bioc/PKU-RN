/*
 * AI 请求代理（MV3 service worker）。
 *
 * 为什么必须有它：
 *   content script 的 fetch 仍然受页面 CORS 约束；扩展申请了服务商的 host_permissions 之后，
 *   由 service worker 发起的请求可以直连服务商，不触发浏览器的 CORS 拦截。
 *
 * 安全约定：
 *   - 只转发「笔记正文 / 字幕 / 资料页」等文字，不转发账号、URL、token、画面；
 *   - 不在 console 打印任何请求体、响应体或 Key；
 *   - 错误只回 code + 中文提示，绝不拼接 Key。
 */
'use strict';

importScripts('../common/ai-config.js');

/* global PRN_AI */
const SETTINGS_KEY = 'pku_replay_notes_ai_v1';
const DUP_PROMPT_KEY = 'pku_replay_notes_dup_prompt_v1';
let duplicateAutoPending = false;

class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

// 新版加载时，如果发现同名的旧版/重复扩展，主动弹一次「移除」确认框。
// 浏览器不允许扩展静默卸载另一个扩展，所以仍需用户点一次确认。
chrome.runtime.onInstalled.addListener(() => {
  cleanupDuplicates({ auto: true }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'prn:ai-explain') {
    explain(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true; // 异步响应
  }

  if (message.type === 'prn:cleanup-duplicates') {
    cleanupDuplicates(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:ai-models') {
    listModels(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:ai-probe-model') {
    probeModel(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-health') {
    localHealth(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-media') {
    localMedia(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-transcribe-path') {
    localTranscribePath(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-transcribe-url') {
    localTranscribeUrl(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-job') {
    localJob(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-simplify') {
    localSimplify(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:doc-begin') {
    try {
      sendResponse(beginDocUpload(message.payload));
    } catch (err) {
      sendResponse(toFailure(err));
    }
    return true;
  }

  if (message.type === 'prn:doc-chunk') {
    try {
      sendResponse(appendDocChunk(message.payload));
    } catch (err) {
      sendResponse(toFailure(err));
    }
    return true;
  }

  if (message.type === 'prn:doc-end') {
    finishDocUpload(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-transcribe-begin') {
    try {
      sendResponse(beginLocalUpload(message.payload));
    } catch (err) {
      sendResponse(toFailure(err));
    }
    return true;
  }

  if (message.type === 'prn:local-transcribe-chunk') {
    try {
      sendResponse(appendLocalChunk(message.payload));
    } catch (err) {
      sendResponse(toFailure(err));
    }
    return true;
  }

  if (message.type === 'prn:local-transcribe-end') {
    finishLocalUpload(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-transcribe-cancel') {
    localUploads.delete(String((message.payload && message.payload.uploadId) || ''));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'prn:ai-slides') {
    recognizeSlides(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:ai-handout') {
    generateHandout(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:ai-chapters') {
    generateChapters(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:ai-lesson') {
    generateLesson(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:ai-lesson-section') {
    generateLessonSection(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:ai-lesson-meta') {
    generateLessonMeta(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  if (message.type === 'prn:local-pdf') {
    localPdf(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse(toFailure(err)));
    return true;
  }

  return undefined;
});

function toFailure(err) {
  return {
    ok: false,
    code: (err && err.code) || 'error',
    message: (err && err.message) || 'AI 请求失败',
  };
}

function readSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(result && result[SETTINGS_KEY] ? result[SETTINGS_KEY] : null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function requireSettings(settings) {
  if (!settings || !settings.key) {
    throw new AiError('config', '还没有配置 AI 讲解服务，点右上角齿轮设置');
  }
  if (!settings.baseURL) {
    throw new AiError('config', '还没有配置服务商地址');
  }
  if (!settings.model) {
    throw new AiError('config', '还没有选择模型');
  }
  return settings;
}

async function fetchJSON(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new AiError('timeout', 'AI 响应超时，请稍后重试');
    }
    throw new AiError('network', '网络不通，或服务商拦截了请求');
  }
  clearTimeout(timer);

  if (!response.ok) {
    const info = PRN_AI.httpError(response.status);
    throw new AiError(info.code, info.message);
  }
  try {
    return await response.json();
  } catch (err) {
    throw new AiError('parse', '服务商返回的不是合法 JSON');
  }
}

function extractContent(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  const message = choice && choice.message;
  let content = message && message.content;
  if (Array.isArray(content)) {
    content = content
      .map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : ''))
      .join('');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new AiError('empty', 'AI 没有返回内容，稍后重试');
  }
  return content.trim();
}

/**
 * 组装 OpenAI 兼容的请求体。
 * DeepSeek V4 / 智谱 GLM 默认会「思考」（reasoning_content）；随堂讲解默认关掉更快，也避免多花 token。
 */
function buildChatBody(settings, messages, options) {
  const body = {
    model: settings.model,
    messages: messages,
    temperature: (options && options.temperature) || 0.3,
    max_tokens: (options && options.max_tokens) || PRN_AI.MAX_TOKENS,
  };
  const provider = PRN_AI.getProvider(settings.providerId);
  // DeepSeek V4 / GLM 默认开启思考；随堂讲解默认关掉，响应快、也省 token。
  if (provider && provider.supportsThinking) {
    const enabled = !!(settings && settings.deepThink);
    body.thinking = { type: enabled ? 'enabled' : 'disabled' };
    if (enabled) body.reasoning_effort = 'low';
  } else if (provider && provider.disableThinking) {
    body.thinking = { type: 'disabled' };
  }
  return body;
}

async function explain(payload) {
  const noteText = String((payload && payload.noteText) || '').trim();
  if (!noteText) throw new AiError('empty-note', '这条笔记是空的，先写点内容再让 AI 讲解');

  const settings = requireSettings(await readSettings());
  const frameDataUrl = typeof (payload && payload.frameDataUrl) === 'string' ? payload.frameDataUrl : '';
  const withFrame = frameDataUrl.indexOf('data:image/') === 0
    && frameDataUrl.length <= PRN_AI.MAX_IMAGE_BYTES;

  const messages = withFrame
    ? PRN_AI.buildFrameExplainMessages(Object.assign({}, payload, { noteText: noteText, frameDataUrl: frameDataUrl }))
    : PRN_AI.buildExplainMessages(Object.assign({}, payload, { noteText: noteText }));

  const response = await fetchJSON(
    PRN_AI.joinURL(settings.baseURL, '/chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.key,
      },
      body: JSON.stringify(buildChatBody(settings, messages, {
        temperature: 0.3,
        max_tokens: PRN_AI.MAX_TOKENS,
      })),
    },
    PRN_AI.REQUEST_TIMEOUT_MS
  );

  return {
    ok: true,
    text: extractContent(response),
    model: settings.model,
    via: withFrame ? 'frame' : 'text',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带 429 退避的 JSON 调用；免费模型（如 GLM-4.6V-Flash）经常限流。 */
async function chatJSON(settings, messages, maxTokens) {
  const body = buildChatBody(settings, messages, { temperature: 0.2, max_tokens: maxTokens });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchJSON(
        PRN_AI.joinURL(settings.baseURL, '/chat/completions'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + settings.key,
          },
          body: JSON.stringify(body),
        },
        90000
      );
      return extractContent(response);
    } catch (err) {
      if (err && err.code === 'rate' && attempt < 2) {
        await sleep(10000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new AiError('rate', '请求太频繁，请等一会儿再试');
}

/** 一批画面帧 → 每帧的幻灯片标题/要点。 */
/** 只允许访问本机字幕服务；由 worker 代发，绕开公网页面访问 127.0.0.1 的本地网络限制。 */
function localServiceURL(baseURL) {
  const raw = String(baseURL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new AiError('local-url', '本地字幕服务地址不合法');
  }
  const host = parsed.hostname;
  if (parsed.protocol !== 'http:' || (host !== '127.0.0.1' && host !== 'localhost')) {
    throw new AiError('local-url', '只允许 http://127.0.0.1 或 http://localhost 的字幕服务');
  }
  return raw;
}

async function localHealth(payload) {
  const base = localServiceURL(payload && payload.baseURL);
  const response = await fetchJSON(base + '/health', { method: 'GET' }, 20000);
  return { ok: true, health: response };
}

/** 列出服务配置目录里的媒体文件（只允许该目录，避免任意读盘）。 */
async function localMedia(payload) {
  const base = localServiceURL(payload && payload.baseURL);
  const response = await fetchJSON(base + '/media', { method: 'GET' }, 20000);
  return { ok: true, result: response };
}

/** 直接转写服务目录里的文件，不上传大文件。 */
async function localTranscribePath(payload) {
  const base = localServiceURL(payload && payload.baseURL);
  const name = String((payload && payload.name) || '');
  if (!name) throw new AiError('local-path', '没有选择文件');
  const response = await fetchJSON(base + '/transcribe-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name,
      language: String((payload && payload.language) || 'zh'),
    }),
  }, 3600000);
  return { ok: true, result: response };
}

/** HLS 的 key 常和播放列表不同 path，单独取 key URL 对应的 Cookie。 */
async function cookiesForKeyUrl(playlistUrl) {
  try {
    if (!chrome.cookies || typeof chrome.cookies.getAll !== 'function') return [];
    const response = await fetch(playlistUrl, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return [];
    const text = await response.text();
    const match = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/i.exec(text);
    if (!match) return [];
    const keyUrl = new URL(match[1], playlistUrl).href;
    return await chrome.cookies.getAll({ url: keyUrl }).catch(() => []);
  } catch (err) {
    return [];
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** 浏览器替本地服务取 HLS key（key 接口常要登录态；服务拿不到）。 */
async function hlsAuthPayload(playlistUrl) {
  try {
    const response = await fetch(playlistUrl, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return null;
    const playlistText = await response.text();
    if (!playlistText.includes('#EXTM3U')) return null;
    if (!/#EXT-X-KEY:[^\n]*METHOD=AES-128/i.test(playlistText)) {
      return { playlistText: playlistText };
    }
    const match = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/i.exec(playlistText);
    if (!match) return { playlistText: playlistText };
    const keyUrl = new URL(match[1], playlistUrl).href;
    const keyResponse = await fetch(keyUrl, { credentials: 'include', cache: 'no-store' });
    if (!keyResponse.ok) return { playlistText: playlistText };
    const buffer = await keyResponse.arrayBuffer();
    if (buffer.byteLength !== 16) return { playlistText: playlistText };
    return {
      playlistText: playlistText,
      keyBase64: bytesToBase64(new Uint8Array(buffer)),
    };
  } catch (err) {
    return null;
  }
}

/** 取当前视频地址所在域名的 Cookie；HLS 的 AES key 接口经常要求登录态。 */
async function cookiesForVideoUrl(url) {
  try {
    if (!chrome.cookies || typeof chrome.cookies.getAll !== 'function') return '';
    const parsed = new URL(url);
    const [byUrl, byDomain, byKey] = await Promise.all([
      chrome.cookies.getAll({ url: url }).catch(() => []),
      chrome.cookies.getAll({ domain: parsed.hostname }).catch(() => []),
      cookiesForKeyUrl(url),
    ]);
    const seen = new Set();
    const parts = [];
    // key URL 的 Cookie 优先，其余用域名下所有 path 兜底
    for (const cookie of [...byKey, ...byDomain, ...byUrl]) {
      if (!cookie || !cookie.name || seen.has(cookie.name)) continue;
      seen.add(cookie.name);
      parts.push(cookie.name + '=' + cookie.value);
    }
    return parts.join('; ');
  } catch (err) {
    return '';
  }
}

/** 只把页面截获到的 HLS/MP4 地址交给本机服务；服务只取音频，不下载整段视频。 */
async function localTranscribeUrl(payload) {
  const base = localServiceURL(payload && payload.baseURL);
  const url = String((payload && payload.url) || '');
  if (!/^https?:\/\//i.test(url) || url.length > 8192) {
    throw new AiError('local-url-source', '视频地址无效');
  }
  const cookie = String((payload && payload.cookie) || '') || await cookiesForVideoUrl(url);
  const auth = await hlsAuthPayload(url);
  const response = await fetchJSON(base + '/transcribe-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: url,
      referer: String((payload && payload.referer) || ''),
      cookie: cookie,
      user_agent: String((payload && payload.user_agent) || ''),
      playlist_text: String((auth && auth.playlistText) || ''),
      key_base64: String((auth && auth.keyBase64) || ''),
      name: String((payload && payload.name) || '课堂录像'),
      language: String((payload && payload.language) || 'auto'),
    }),
  }, 60000);
  return { ok: true, result: response };
}

async function localJob(payload) {
  const base = localServiceURL(payload && payload.baseURL);
  const jobId = String((payload && payload.jobId) || '');
  if (!jobId) throw new AiError('local-job', '任务 id 为空');
  const response = await fetchJSON(base + '/job?id=' + encodeURIComponent(jobId), { method: 'GET' }, 20000);
  return { ok: true, result: response };
}

async function localSimplify(payload) {
  const base = localServiceURL(payload && payload.baseURL);
  const texts = Array.isArray(payload && payload.texts) ? payload.texts.slice(0, 5000).map(String) : [];
  if (!texts.length) throw new AiError('local-simplify', '没有可转换的字幕');
  const response = await fetchJSON(base + '/simplify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: texts }),
  }, 60000);
  return { ok: true, result: response };
}

/**
 * 本地转写走 worker 代理 + 分片上传：
 * 公网页面（HTTPS）直接 fetch 127.0.0.1 会被浏览器的本地网络访问策略拦掉，
 * 但从扩展 service worker 发请求是可以的；文件太大不能一条消息发完，按 4MB 分片。
 */
const localUploads = new Map();
const LOCAL_MAX_BYTES = 500 * 1024 * 1024;

function beginLocalUpload(payload) {
  const baseURL = localServiceURL(payload && payload.baseURL);
  const size = Number(payload && payload.size) || 0;
  if (size <= 0 || size > LOCAL_MAX_BYTES) {
    throw new AiError('local-size', '文件为空或超过 500MB');
  }
  const uploadId = 'u' + Date.now() + '_' + Math.random().toString(16).slice(2, 8);
  localUploads.set(uploadId, {
    baseURL: baseURL,
    filename: String((payload && payload.filename) || 'media.mp4'),
    language: String((payload && payload.language) || 'auto'),
    size: size,
    received: 0,
    chunks: [],
    createdAt: Date.now(),
  });
  return { ok: true, uploadId: uploadId };
}

function appendLocalChunk(payload) {
  const uploadId = String((payload && payload.uploadId) || '');
  const upload = localUploads.get(uploadId);
  if (!upload) throw new AiError('local-upload', '上传会话不存在或已过期');
  const data = payload && payload.data;
  if (typeof data !== 'string' || !data) throw new AiError('local-upload', '分片数据格式不对');
  let bytes;
  try {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch (err) {
    throw new AiError('local-upload', '分片数据不是合法 base64');
  }
  if (upload.received + bytes.byteLength > LOCAL_MAX_BYTES) {
    localUploads.delete(uploadId);
    throw new AiError('local-size', '文件超过 500MB');
  }
  upload.chunks.push(bytes);
  upload.received += bytes.byteLength;
  return { ok: true, received: upload.received };
}

/**
 * 文档（PDF/Word/PPT）走同样的分片上传，服务解析出每页/每节文字。
 * 文档解析不依赖媒体目录，但仍然是本机服务。
 */
const documentUploads = new Map();
const DOC_MAX_BYTES = 200 * 1024 * 1024;

function beginDocUpload(payload) {
  const baseURL = localServiceURL(payload && payload.baseURL);
  const size = Number(payload && payload.size) || 0;
  if (size <= 0 || size > DOC_MAX_BYTES) throw new AiError('doc-size', '文件为空或超过 200MB');
  const uploadId = 'd' + Date.now() + '_' + Math.random().toString(16).slice(2, 8);
  documentUploads.set(uploadId, {
    baseURL: baseURL,
    filename: String((payload && payload.filename) || 'document.pptx'),
    size: size,
    received: 0,
    chunks: [],
  });
  return { ok: true, uploadId: uploadId };
}

function appendDocChunk(payload) {
  const uploadId = String((payload && payload.uploadId) || '');
  const upload = documentUploads.get(uploadId);
  if (!upload) throw new AiError('doc-upload', '上传会话不存在或已过期');
  const data = payload && payload.data;
  if (typeof data !== 'string' || !data) throw new AiError('doc-upload', '分片数据格式不对');
  let bytes;
  try {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch (err) {
    throw new AiError('doc-upload', '分片数据不是合法 base64');
  }
  upload.chunks.push(bytes);
  upload.received += bytes.byteLength;
  return { ok: true, received: upload.received };
}

async function finishDocUpload(payload) {
  const uploadId = String((payload && payload.uploadId) || '');
  const upload = documentUploads.get(uploadId);
  if (!upload) throw new AiError('doc-upload', '上传会话不存在或已过期');
  const blob = new Blob(upload.chunks, { type: 'application/octet-stream' });
  const url = upload.baseURL + '/document?filename=' + encodeURIComponent(upload.filename);
  try {
    const result = await fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }, 300000);
    return { ok: true, result: result };
  } finally {
    documentUploads.delete(uploadId);
  }
}

async function finishLocalUpload(payload) {  const uploadId = String((payload && payload.uploadId) || '');
  const upload = localUploads.get(uploadId);
  if (!upload) throw new AiError('local-upload', '上传会话不存在或已过期');
  const blob = new Blob(upload.chunks, { type: 'application/octet-stream' });
  const url = upload.baseURL + '/transcribe?filename=' + encodeURIComponent(upload.filename)
    + '&language=' + encodeURIComponent(upload.language);
  try {
    const result = await fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }, 3600000);
    return { ok: true, result: result };
  } finally {
    localUploads.delete(uploadId);
  }
}

async function recognizeSlides(payload) {
  const frames = Array.isArray(payload && payload.frames) ? payload.frames.slice(0, 6) : [];
  const clean = frames.filter((frame) => frame
    && typeof frame.dataUrl === 'string'
    && frame.dataUrl.indexOf('data:image/') === 0
    && frame.dataUrl.length <= PRN_AI.MAX_IMAGE_BYTES);
  if (!clean.length) throw new AiError('empty-frames', '没有可识别的画面');

  const settings = requireSettings(await readSettings());
  const content = await chatJSON(settings, PRN_AI.buildSlideMessages(clean), 1600);
  let slides;
  try {
    slides = PRN_AI.normalizeSlides(PRN_AI.parseJSONLoose(content));
  } catch (err) {
    throw new AiError('parse', '画面识别结果不是合法 JSON');
  }
  return { ok: true, slides: slides, model: settings.model };
}

/** 分页资料 → 一页讲义。 */
async function generateHandout(payload) {
  const segments = Array.isArray(payload && payload.segments) ? payload.segments.slice(0, 40) : [];
  if (!segments.length) throw new AiError('empty-segments', '没有可汇总的页面');

  const settings = requireSettings(await readSettings());
  const content = await chatJSON(settings, PRN_AI.buildHandoutMessages(payload), 4000);
  let handout;
  try {
    handout = PRN_AI.normalizeHandout(PRN_AI.parseJSONLoose(content));
  } catch (err) {
    throw new AiError('parse', '讲义结果不是合法 JSON');
  }
  return { ok: true, handout: handout, model: settings.model };
}

/** 转写窗口 → 章节标题/摘要。 */
/** 转写单元 + 资料页 → 一份完整课程讲义（章节/术语/差异一次生成）。 */
async function generateLesson(payload) {
  const units = Array.isArray(payload && payload.units) ? payload.units.slice(0, 180) : [];
  if (!units.length) throw new AiError('empty-units', '还没有字幕，无法生成讲义');
  const settings = requireSettings(await readSettings());
  const content = await chatJSON(settings, PRN_AI.buildLessonMessages(Object.assign({}, payload, { units })), 8000);
  let lesson;
  try {
    lesson = PRN_AI.normalizeLesson(PRN_AI.parseJSONLoose(content));
  } catch (err) {
    try {
      const repaired = await chatJSON(settings, [
        {
          role: 'system',
          content: '你是 JSON 修复器。只输出课程讲义 JSON：{title,summary,sections:[{start,end,page,heading,body,gaps}],terms,gaps}，不要解释。',
        },
        {
          role: 'user',
          content: '把下面的内容整理成合法讲义 JSON：\n' + String(content || '').slice(0, 8000),
        },
      ], 8000);
      lesson = PRN_AI.normalizeLesson(PRN_AI.parseJSONLoose(repaired));
    } catch (retryErr) {
      throw new AiError('parse', '讲义结果不是合法 JSON');
    }
  }
  if (!lesson.sections.length) {
    // 有些模型会返回数组、chapters 或别的字段名；再给一次最简单的「只要 sections 数组」机会
    try {
      const fallbackContent = await chatJSON(
        settings,
        PRN_AI.buildLessonFallbackMessages(Object.assign({}, payload, { units })),
        4000
      );
      const parsed = PRN_AI.parseJSONLoose(fallbackContent);
      const list = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed.sections) ? parsed.sections : (Array.isArray(parsed.chapters) ? parsed.chapters : []));
      lesson = PRN_AI.normalizeLesson(Object.assign({}, lesson, { sections: list }));
    } catch (fallbackErr) {
      throw new AiError('empty-lesson', 'AI 没有生成讲义章节');
    }
  }
  if (!lesson.sections.length) throw new AiError('empty-lesson', 'AI 没有生成讲义章节');
  return { ok: true, lesson: lesson, model: settings.model };
}

/** 本地服务直接生成 PDF，返回 base64，面板用 Blob 下载。 */
async function localPdf(payload) {
  const base = localServiceURL(payload && payload.baseURL);
  const html = String((payload && payload.html) || '');
  if (!html.trim()) throw new AiError('empty-pdf', '讲义内容为空');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(base + '/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: html }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.ok || !data.pdfBase64) {
      throw new AiError('pdf-failed', (data && data.error) || 'PDF 生成失败');
    }
    return {
      ok: true,
      pdfBase64: data.pdfBase64,
      pages: data.pages,
      bytes: data.bytes,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 单节扩写：用这一节的转写把正文写厚。 */
async function generateLessonSection(payload) {
  const settings = requireSettings(await readSettings());
  const content = await chatJSON(settings, PRN_AI.buildLessonSectionMessages(payload), 4000);
  const parsed = PRN_AI.parseJSONLoose(content);
  const lesson = PRN_AI.normalizeLesson({
    sections: Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed.sections) ? parsed.sections : [parsed]),
  });
  if (!lesson.sections.length) throw new AiError('empty-section', '这一节没有生成可用内容');
  return { ok: true, section: lesson.sections[0] };
}

/** 术语/自测/目标：基于已经写完的章节。 */
async function generateLessonMeta(payload) {
  const settings = requireSettings(await readSettings());
  const content = await chatJSON(settings, PRN_AI.buildLessonMetaMessages(payload), 3000);
  const parsed = PRN_AI.parseJSONLoose(content);
  const lesson = PRN_AI.normalizeLesson(parsed);
  return {
    ok: true,
    meta: {
      objectives: lesson.objectives,
      summary: lesson.summary,
      terms: lesson.terms,
      review: lesson.review,
      gaps: lesson.gaps,
    },
  };
}

async function generateChapters(payload) {
  const units = Array.isArray(payload && payload.units)
    ? payload.units.slice(0, 180)
    : (Array.isArray(payload && payload.windows) ? payload.windows.slice(0, 180) : []);
  if (!units.length) throw new AiError('empty-windows', '没有可汇总的转写片段');

  const settings = requireSettings(await readSettings());
  const content = await chatJSON(settings, PRN_AI.buildChapterMessages(Object.assign({}, payload, { units: units })), 4000);
  let chapters;
  try {
    chapters = PRN_AI.normalizeChapters(PRN_AI.parseJSONLoose(content));
  } catch (err) {
    // 有些模型会多说话/被截断：让模型把上一次输出整理成合法 JSON，再解析一次
    try {
      const repaired = await chatJSON(settings, [
        {
          role: 'system',
          content: '你是 JSON 修复器。只输出合法 JSON 数组，元素字段为 start/end/title/summary/page/gaps，不要解释，不要 Markdown 围栏。',
        },
        {
          role: 'user',
          content: '把下面的章节内容整理成合法 JSON 数组：\n' + String(content || '').slice(0, 8000),
        },
      ], 4000);
      chapters = PRN_AI.normalizeChapters(PRN_AI.parseJSONLoose(repaired));
    } catch (retryErr) {
      throw new AiError('parse', '章节结果不是合法 JSON');
    }
  }
  return { ok: true, chapters: chapters, model: settings.model };
}

function modelEndpointCandidates(baseURL) {
  const base = PRN_AI.normalizeBaseURL(baseURL);
  const urls = [];
  const add = (value) => {
    if (value && urls.indexOf(value) === -1) urls.push(value);
  };
  const stripped = base.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  add(stripped + '/models');
  if (!/\/v\d+$/i.test(stripped)) add(stripped + '/v1/models');
  const withoutVersion = stripped.replace(/\/v\d+$/i, '');
  if (withoutVersion !== stripped) add(withoutVersion + '/models');
  return urls;
}

function parseModelList(payload) {
  const list = [];
  const push = (id, name) => {
    const value = String(id || '').trim();
    if (!value) return;
    if (list.some((item) => item.id === value)) return;
    list.push({ id: value, name: String(name || '').trim() });
  };
  const items = Array.isArray(payload && payload.data)
    ? payload.data
    : (Array.isArray(payload && payload.models) ? payload.models : []);
  for (const item of items) {
    if (typeof item === 'string') push(item, '');
    else if (item && typeof item.id === 'string') push(item.id, item.name);
    else if (item && typeof item.model === 'string') push(item.model, item.name);
  }
  return list;
}

/**
 * 读取服务商的模型列表。不同中转 / 兼容实现的地址不一定是 <base>/models，
 * 这里按 <base>/models → <base>/v1/models → 去掉版本号的 <base>/models 依次尝试。
 */
function versionParts(value) {
  return String(value || '0').split('.').map((part) => parseInt(part, 10) || 0);
}

function versionOlder(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function readDuplicatePrompt() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(DUP_PROMPT_KEY, (result) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(result && result[DUP_PROMPT_KEY] ? result[DUP_PROMPT_KEY] : null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function writeDuplicatePrompt(version) {
  return new Promise((resolve) => {
    try {
      const value = {};
      value[DUP_PROMPT_KEY] = { version: version, at: Date.now() };
      chrome.storage.local.set(value, () => resolve());
    } catch (err) {
      resolve();
    }
  });
}

/** 找到同名、开发模式加载的其他扩展（旧版本或重复加载的另一个副本）。 */
function listDuplicateExtensions(includeSameVersion) {
  return new Promise((resolve) => {
    if (!chrome.management || typeof chrome.management.getAll !== 'function') {
      resolve({ supported: false, list: [] });
      return;
    }
    try {
      chrome.management.getAll((items) => {
        if (chrome.runtime.lastError) {
          resolve({ supported: false, list: [] });
          return;
        }
        const self = chrome.runtime.id;
        const manifest = chrome.runtime.getManifest();
        const list = (Array.isArray(items) ? items : [])
          .filter((item) => item
            && item.id
            && item.id !== self
            && item.name === manifest.name
            && item.installType === 'development'
            && (includeSameVersion || versionOlder(item.version, manifest.version)))
          .map((item) => ({ id: item.id, name: item.name, version: item.version }));
        resolve({ supported: true, list: list });
      });
    } catch (err) {
      resolve({ supported: false, list: [] });
    }
  });
}

/**
 * 清理旧版残留。浏览器不允许扩展静默卸载另一个扩展，所以这里会调起系统
 * 的「移除扩展」确认框；用户点一次「移除」即可。自动模式只针对旧版本，
 * 手动模式（齿轮里的按钮）可以清掉包括同版本在内的重复副本。
 */
async function cleanupDuplicates(payload) {
  const options = payload || {};
  const all = !!options.all;
  const auto = !!options.auto;
  const info = await listDuplicateExtensions(all);
  if (!info.supported) {
    return {
      ok: false,
      supported: false,
      code: 'unsupported',
      message: '当前浏览器不支持自动清理；Safari 版请运行「修复扩展检测.command」',
    };
  }
  if (!info.list.length) return { ok: true, supported: true, found: [], requested: [] };

  if (auto) {
    // 多个 iframe 会同时请求；先把标志立起来，避免同一时间弹出多个确认框
    if (duplicateAutoPending) {
      return { ok: true, supported: true, found: info.list, requested: [], suppressed: true };
    }
    duplicateAutoPending = true;
    const current = chrome.runtime.getManifest().version;
    const prompted = await readDuplicatePrompt();
    if (prompted && prompted.version === current) {
      duplicateAutoPending = false;
      return { ok: true, supported: true, found: info.list, requested: [], suppressed: true };
    }
    await writeDuplicatePrompt(current);
  }

  const requested = [];
  for (const item of info.list) {
    try {
      chrome.management.uninstall(item.id, { showConfirmDialog: true }, () => {
        if (chrome.runtime.lastError) void chrome.runtime.lastError;
      });
      requested.push(item);
    } catch (err) {
      /* 单个失败不影响其他副本 */
    }
  }
  duplicateAutoPending = false;
  return { ok: true, supported: true, found: info.list, requested: requested };
}

async function listModels(payload) {
  const stored = await readSettings();
  const draft = payload || {};
  const provider = PRN_AI.getProvider(draft.providerId || (stored && stored.providerId) || 'deepseek');
  const baseURL = PRN_AI.normalizeBaseURL(draft.baseURL || (stored && stored.baseURL) || (provider && provider.baseURL) || '');
  const key = String(draft.key || (stored && stored.key) || '').trim();

  if (!baseURL) throw new AiError('config', '还没有配置服务商地址');
  if (!key) throw new AiError('config', '先填 API Key');

  const endpoints = modelEndpointCandidates(baseURL);
  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await fetchJSON(
        url,
        { method: 'GET', headers: { Authorization: 'Bearer ' + key } },
        20000
      );
      const models = parseModelList(response);
      if (!models.length) {
        lastError = new AiError('models-empty', '接口没有返回模型列表，可以手填模型名');
        continue;
      }
      return { ok: true, models: models, endpoint: url };
    } catch (err) {
      if (err && (err.code === 'unauthorized' || err.code === 'payment' || err.code === 'rate')) throw err;
      lastError = err;
    }
  }
  throw lastError || new AiError('models-empty', '接口没有返回模型列表，可以手填模型名');
}

/**
 * 用一条最小的对话请求验证「模型名是否真的可调用」。
 * 服务商的 /models 经常滞后或漏模型（例如只返回旧别名），这是最可靠的兜底。
 */
async function probeModel(payload) {
  const draft = payload || {};
  const provider = PRN_AI.getProvider(draft.providerId);
  const baseURL = PRN_AI.normalizeBaseURL(draft.baseURL || (provider && provider.baseURL) || '');
  const key = String(draft.key || '').trim();
  const model = String(draft.model || '').trim();
  if (!baseURL) throw new AiError('config', '还没有配置服务商地址');
  if (!key) throw new AiError('config', '先填 API Key');
  if (!model) throw new AiError('config', '先选一个模型');

  const settings = { providerId: draft.providerId, baseURL: baseURL, key: key, model: model, deepThink: false };
  const body = buildChatBody(settings, [{ role: 'user', content: 'ping' }], { temperature: 0, max_tokens: 1 });
  if (PRN_AI.supportsThinking(provider) || (provider && provider.disableThinking)) {
    body.thinking = { type: 'disabled' };
    delete body.reasoning_effort;
  }
  await fetchJSON(
    PRN_AI.joinURL(baseURL, '/chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(body),
    },
    30000
  );
  return { ok: true, model: model };
}

