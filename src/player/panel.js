/*
 * 面板入口（隔离世界，注入到播放器所在文档）。
 *
 * 关键取舍
 *  1. 用 Shadow DOM 承载全部 DOM 与样式，避免被播放器全局 CSS 污染；用页面内 fixed 面板，
 *     不用 chrome.sidePanel（Edge 的侧边栏行为不一致，而且跨域 iframe 里拿不到播放数据）。
 *  2. 读取播放位置要通过 adapter → probe.js（MAIN world）的异步桥：隔离世界看不到页面对象。
 *  3. 面板只负责「显示 / 打点 / 跳转 / AI 讲解 / 调试」，持久化都走 PRN.storage，与列表页靠
 *     chrome.storage.onChanged 同步，不引入跨页消息传递。
 *  4. 不允许把任何 URL、token、账号、姓名写进 storage 或 console —— 这里只处理 subId / 时间 / 笔记正文。
 *  5. AI 讲解：只把「课程名 / 节次 / 时间点 / 笔记正文」发给 service worker，再由它直连用户配置的服务商；
 *     AI 看不到视频和声音，prompt 里明确禁止编造老师说过的话。Key 存在独立的 chrome.storage 键里，不进笔记。
 */
(function () {
  'use strict';

  const PRN = globalThis.PRN;
  const AI = globalThis.PRN_AI;
  if (!PRN || !PRN.storage || !PRN.adapter || !PRN.panelCss) return;
  if (!AI) return;
  if (window.__PRN_PANEL_LOADED__) return;
  window.__PRN_PANEL_LOADED__ = true;

  const DEBUG = true; // 调试区开关。本轮必须有，成品阶段改 false 即可整块隐藏。
  const TICK_MS = 250;
  const SAVE_INTERVAL_MS = 5000;
  const READY_TIMEOUT_MS = 15000;
  const REPROBE_INTERVAL_MS = 5000;
  const AI_REQUEST_TIMEOUT_MS = 60000;

  const { storage, adapter, time } = PRN;

  const state = {
    subId: null,
    courseId: null,
    label: '',
    level: 'pending', // 'pending' | 'L1' | 'L2' | 'none'
    notes: [],
    notesSignature: '',
    composerTime: null,
    ai: null, // { providerId, baseURL, key, model }
    aiModels: [],
    aiStatus: new Map(), // noteId -> { state: 'loading' | 'error', message }
    duplicates: [], // 检测到的旧版/重复扩展
    cleanupSupported: false,
    ppt: null, // 合并后的资料视图：{ name, kind, pages }
    materials: [], // 上传的多个文件：[{ name, kind, pages, warning }]
    handout: null, // 本节讲义：{ generatedAt, model, segments, handout }
    handoutError: '',
    lessonBusy: false,
    lessonProgress: '',
    scan: null, // 扫片状态
    cues: [], // 字幕：{ start, end, text }
    chapters: [], // 章节：{ start, end, title, summary, page }
    segments: [], // 进度条分段：{ start, end, title, page }
    transcriptSource: '',
    transcriptError: '',
    transcriptBusy: false,
    transcriptAbort: null,
    transcriptProgress: 0,
    transcriptElapsed: 0,
    transcriptStage: '',
    transcriptService: 'http://127.0.0.1:8765',
    transcriptLanguage: 'zh',
    transcriptServiceStatus: '',
    mediaUrls: [],
    mediaUrlsScanned: false,
    localMedia: [],
    localMediaDir: '',
    localMediaError: '',
    ccEnabled: true,
    currentCueIndex: -1,
    lastSeconds: 0,
    downloadStatus: '',
    downloadBusy: false,
    downloadAck: false,
    downloadPaused: false,
    downloadCancelling: false,
    videoSource: null,
  };

  // ---- DOM ---------------------------------------------------------------

  const host = document.createElement('div');
  host.id = 'prn-panel-host';
  host.setAttribute('data-prn', 'panel');

  // 定位/尺寸在 v0.9.3 由 applyPanelRect 动态设置（可拖动、可缩放）；
  // 这里只锁定 fixed / z-index / 盒模型，防止被页面全局样式改掉。
  host.style.cssText = [
    'position: fixed !important',
    'left: 12px !important',
    'top: 72px !important',
    'right: auto !important',
    'bottom: auto !important',
    'width: 360px !important',
    'height: 600px !important',
    'max-width: calc(100vw - 16px) !important',
    'max-height: calc(100vh - 16px) !important',
    'min-width: 0 !important',
    'min-height: 0 !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'border: 0 !important',
    'display: block !important',
    'z-index: 2147483000 !important',
    'transform: none !important',
    'filter: none !important',
    'float: none !important',
    'border-radius: 14px !important',
  ].join(';');

  function installPageLayout() {
    document.documentElement.classList.add('prn-panel-open');
    const css = `
      html.prn-panel-open {
        --prn-font: "Arial", "Helvetica Neue", "SimHei", "Microsoft YaHei", sans-serif;
      }
      @media (min-width: 1180px) {
        html.prn-panel-open body {
          padding-right: var(--prn-panel-pad, 0px) !important;
          box-sizing: border-box !important;
          transition: padding-right .28s cubic-bezier(.4, 0, .2, 1);
        }
      }
      html.prn-panel-open body,
      html.prn-panel-open body button,
      html.prn-panel-open body input,
      html.prn-panel-open body textarea,
      html.prn-panel-open body select,
      html.prn-panel-open .course-info__wrapper,
      html.prn-panel-open .course-info__header span {
        font-family: var(--prn-font) !important;
      }
      html.prn-panel-open .course-info__wrapper {
        box-sizing: border-box;
        max-width: 100% !important;
      }
      html.prn-panel-open #app {
        max-width: 100% !important;
      }
      html.prn-panel-open .course-info__main {
        border-radius: 0 !important;
        overflow: hidden;
      }
      html.prn-panel-open .course-info__main video,
      html.prn-panel-open .course-info__main .video-js,
      html.prn-panel-open .course-info__main .prism-player,
      html.prn-panel-open .course-info__main canvas {
        border-radius: 0 !important;
      }
      .prn-ch-card {
        width: min(100%, 960px) !important;
        margin: 12px auto 0 !important;
        padding: 12px 14px !important;
        background: #fff !important;
        border: 1px solid #E3DAD6 !important;
        border-radius: 8px !important;
        box-sizing: border-box !important;
        font-family: Arial, "SimHei", "Microsoft YaHei", sans-serif !important;
        color: #212121 !important;
      }
      .prn-ch-head {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        margin-bottom: 8px !important;
      }
      .prn-ch-title { font-size: 14px !important; font-weight: 700 !important; }
      .prn-ch-count { color: #958A84 !important; font-size: 11px !important; }
      .prn-ch-now {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        text-align: right !important;
        color: #666 !important;
        font-size: 11px !important;
      }
      .prn-ch-download {
        flex: 0 0 auto !important;
        height: 28px !important;
        padding: 0 12px !important;
        border: 1px solid #E3DAD6 !important;
        border-radius: 6px !important;
        background: #fff !important;
        color: #94070A !important;
        font: 700 12px Arial, "SimHei", sans-serif !important;
        cursor: pointer !important;
      }
      .prn-ch-download:hover { background: #FBF0EF !important; border-color: #94070A !important; }
      .prn-ch-bar {
        display: flex !important;
        gap: 2px !important;
        height: 10px !important;
        overflow: hidden !important;
        border-radius: 3px !important;
        background: #e5e7eb !important;
      }
      .prn-ch-seg {
        flex-basis: 0 !important;
        position: relative !important;
        min-width: 3px !important;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        cursor: pointer !important;
        overflow: hidden !important;
      }
      .prn-ch-fill {
        display: block !important;
        width: 0 !important;
        height: 100% !important;
        background: #94070A !important;
        transition: width .2s linear !important;
      }
      .prn-ch-seg.done .prn-ch-fill { width: 100% !important; opacity: .38 !important; }
      .prn-ch-seg.active .prn-ch-fill { width: 100% !important; opacity: 1 !important; }
      .prn-ch-labels {
        display: flex !important;
        gap: 2px !important;
        margin-top: 4px !important;
      }
      .prn-ch-label {
        flex: 1 1 0 !important;
        flex-basis: 0 !important;
        min-width: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        color: #958A84 !important;
        font: 10px Arial, "SimHei", sans-serif !important;
        text-align: left !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        cursor: pointer !important;
      }
      .prn-ch-label.active { color: #94070A !important; font-weight: 700 !important; }
      .prn-ch-label.done { color: #666 !important; }
      body.prn-hide-pku-download #injectDownloadButton { display: none !important; }
      html.prn-panel-open .course-info__footer {
        width: min(100%, 960px) !important;
        margin: 12px auto 18px !important;
      }
      html.prn-panel-open .course-info__footer button,
      html.prn-panel-open .course-info__footer a {
        border-radius: 6px !important;
        font-family: Arial, "SimHei", "Microsoft YaHei", sans-serif !important;
      }
      .prn-ch-card {
        width: var(--prn-ch-width, 100%) !important;
        max-width: 100% !important;
        margin: 8px auto 0 !important;
        padding: 0 !important;
        background: transparent !important;
        border: 0 !important;
        box-sizing: border-box !important;
        font-family: Arial, "SimHei", "Microsoft YaHei", sans-serif !important;
      }
      .prn-ch-track {
        position: relative !important;
        height: 8px !important;
        border-radius: 4px !important;
        background: #dbe4ec !important;
        cursor: pointer !important;
      }
      .prn-ch-fill {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        height: 100% !important;
        width: 0 !important;
        border-radius: 4px !important;
        background: #94070A !important;
        transition: width .2s linear !important;
      }
      .prn-ch-dot {
        position: absolute !important;
        top: 50% !important;
        width: 10px !important;
        height: 10px !important;
        padding: 0 !important;
        border: 2px solid #fff !important;
        border-radius: 50% !important;
        background: #94070A !important;
        box-shadow: 0 1px 4px rgba(0,0,0,.25) !important;
        transform: translate(-50%, -50%) !important;
        cursor: pointer !important;
        z-index: 2 !important;
      }
      .prn-ch-dot.active {
        width: 13px !important;
        height: 13px !important;
        background: #C0392B !important;
      }
      .prn-ch-tip {
        display: none !important;
        position: absolute !important;
        left: 50% !important;
        bottom: 16px !important;
        transform: translateX(-50%) !important;
        padding: 3px 7px !important;
        border: 1px solid #E3DAD6 !important;
        border-radius: 6px !important;
        background: #fff !important;
        color: #212121 !important;
        font: 11px Arial, "SimHei", sans-serif !important;
        white-space: nowrap !important;
        max-width: 220px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        z-index: 5 !important;
        box-shadow: 0 4px 14px rgba(0,0,0,.12) !important;
      }
      .prn-ch-dot:hover .prn-ch-tip,
      .prn-ch-dot:focus .prn-ch-tip { display: block !important; }
      .prn-ch-dot:first-of-type .prn-ch-tip { left: -4px !important; transform: none !important; }
      .prn-ch-dot:last-of-type .prn-ch-tip { left: auto !important; right: 0 !important; transform: none !important; }
      .prn-ch-foot {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        margin-top: 6px !important;
      }
      .prn-ch-status {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        color: #958A84 !important;
        font-size: 11px !important;
      }
      .prn-ch-download {
        flex: 0 0 auto !important;
        height: 28px !important;
        padding: 0 12px !important;
        border: 1px solid #E3DAD6 !important;
        border-radius: 6px !important;
        background: #fff !important;
        color: #94070A !important;
        font: 700 12px Arial, "SimHei", sans-serif !important;
        cursor: pointer !important;
      }
      .prn-ch-download:hover {
        background: #FBF0EF !important;
        border-color: #94070A !important;
      }
      .prn-ch-pause,
      .prn-ch-cancel {
        flex: 0 0 auto !important;
        height: 28px !important;
        padding: 0 10px !important;
        border: 1px solid #E3DAD6 !important;
        border-radius: 6px !important;
        background: #fff !important;
        color: #666 !important;
        font: 700 12px Arial, "SimHei", sans-serif !important;
        cursor: pointer !important;
      }
      .prn-ch-pause:hover { background: #F7F4F2 !important; border-color: #94070A !important; }
      .prn-ch-cancel { color: #C0392B !important; }
      .prn-ch-cancel:hover { background: #FBF0EF !important; border-color: #C0392B !important; }
      .prn-ch-foot [hidden] { display: none !important; }
    `;
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        return;
      }
    } catch (err) {
      /* fall through */
    }
    const style = document.createElement('style');
    style.id = 'prn-page-layout';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  const shadow = host.attachShadow({ mode: 'open' });

  // 优先用 constructable stylesheet：不往页面里插 <style>，不受页面 style-src CSP 影响。
  // 老一点的 Edge 上退回 <style>，两种方式都不产生网络请求。
  function applyStyles(root, css) {
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (err) {
      /* 继续走 <style> */
    }
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
  }

  applyStyles(shadow, PRN.panelCss);

  // 面板骨架全部用 DOM API 搭：不拼 HTML 字符串，页面上的任何内容都不会被当成标记解析。
  function element(tagName, className, content) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  const wrap = element('div', 'wrap');

  const header = element('header', 'hd');
  const grip = element('span', 'hd-grip', '⠿');
  grip.setAttribute('aria-hidden', 'true');
  const title = element('div', 'hd-title', '课堂实录回放笔记');
  title.id = 'title';
  const aiGear = element('button', 'icon-btn hd-icon', '⚙');
  aiGear.id = 'ai-settings';
  aiGear.type = 'button';
  aiGear.title = 'AI 讲解设置';
  aiGear.setAttribute('aria-label', 'AI 讲解设置');
  const pptBtn = element('button', 'hd-text-btn', '资料');
  pptBtn.id = 'ppt-btn';
  pptBtn.type = 'button';
  pptBtn.title = '导入课程资料（PPT / PDF / Word）';
  const handoutBtn = element('button', 'hd-text-btn', '讲义');
  handoutBtn.id = 'handout-btn';
  handoutBtn.type = 'button';
  handoutBtn.title = '扫描本节并生成按页讲义';
  const ccBtn = element('button', 'hd-text-btn', '字幕');
  ccBtn.id = 'transcript-btn';
  ccBtn.type = 'button';
  ccBtn.title = '字幕、转写与按音频分章节';
  header.append(grip, title, ccBtn, pptBtn, handoutBtn, aiGear);
  pptBtn.title = '上传课程资料';
  handoutBtn.title = '生成详细讲义';
  ccBtn.title = '字幕、转写与智能分段';

  const bar = element('div', 'bar');
  const dot = element('span', 'dot');
  dot.id = 'dot';
  dot.dataset.state = 'idle';
  const clock = element('span', 'clock');
  const cur = element('span', null, '--:--');
  cur.id = 'cur';
  const clockSep = element('span', 'sep', '/');
  const dur = element('span', 'dur', '--:--');
  dur.id = 'dur';
  clock.append(cur, clockSep, dur);
  const mark = element('button', 'btn', '在此打点');
  mark.id = 'mark';
  mark.type = 'button';
  bar.append(dot, clock, mark);

  const chapterRail = element('div', 'chapter-rail');
  chapterRail.id = 'chapter-rail';
  chapterRail.hidden = true;

  const notice = element('div', 'notice');
  notice.id = 'notice';
  notice.hidden = true;

  const composer = element('form', 'composer');
  composer.id = 'composer';
  composer.hidden = true;
  const composerTime = element('div', 'composer-time');
  composerTime.id = 'composerTime';
  const noteInput = element('input');
  noteInput.id = 'noteInput';
  noteInput.type = 'text';
  noteInput.maxLength = 300;
  noteInput.autocomplete = 'off';
  noteInput.placeholder = '这一处讲了什么？';
  const composerActions = element('div', 'composer-actions');
  const saveButton = element('button', 'btn btn-sm', '保存');
  saveButton.type = 'submit';
  const cancelButton = element('button', 'ghost', '取消');
  cancelButton.id = 'cancel';
  cancelButton.type = 'button';
  const composerHint = element('span', 'composer-hint', 'Enter 保存 · Esc 取消');
  composerHint.id = 'composerHint';
  composerActions.append(saveButton, cancelButton, composerHint);
  composer.append(composerTime, noteInput, composerActions);

  const listWrap = element('div', 'listwrap');
  const notes = element('ul', 'notes');
  notes.id = 'notes';
  const empty = element('div', 'empty');
  empty.id = 'empty';
  listWrap.append(notes, empty);

  const dbg = element('div', 'dbg');
  dbg.id = 'dbg';
  dbg.hidden = true;

  // AI 讲解设置（面板内的浮层，不走 chrome.sidePanel / options 页）
  // v0.9.3：音频统一走「本机转写 → 字幕」，AI 只读文字，所以这里不再有画面 / 视觉模型 /
  // 检测画面之类的控件，只保留「服务商 / 地址 / Key / 模型」。
  const aiSheet = element('div', 'ai-sheet');
  aiSheet.id = 'ai-sheet';
  aiSheet.hidden = true;

  const aiCard = element('div', 'ai-card ai-card-scroll');

  const aiHead = element('div', 'ai-head');
  const aiTitle = element('div', 'ai-title', 'AI 讲解设置');
  const aiClose = element('button', 'icon-btn', '×');
  aiClose.id = 'ai-close';
  aiClose.type = 'button';
  aiClose.title = '关闭';
  aiHead.append(aiTitle, aiClose);

  const aiHint = element('p', 'ai-hint',
    '音频先在本机转成文字，AI 只处理文字。面板可拖标题栏移动、拖边角缩放。');
  aiHint.id = 'ai-hint';

  const aiDupBox = element('div', 'ai-dup');
  aiDupBox.id = 'ai-dup';
  aiDupBox.hidden = true;
  const aiDupText = element('p', 'ai-note', '');
  const aiCleanup = element('button', 'ghost ai-cleanup', '清理旧版残留');
  aiCleanup.id = 'ai-cleanup';
  aiCleanup.type = 'button';
  aiDupBox.append(aiDupText, aiCleanup);

  const aiProviderLabel = element('label', 'ai-field');
  aiProviderLabel.appendChild(element('span', 'ai-label', '服务商'));
  const aiProvider = element('select', 'ai-input');
  aiProvider.id = 'ai-provider';
  for (const provider of AI.PROVIDERS) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name;
    aiProvider.appendChild(option);
  }
  aiProviderLabel.appendChild(aiProvider);

  const aiBaseLabel = element('label', 'ai-field');
  aiBaseLabel.appendChild(element('span', 'ai-label', '接入地址（OpenAI 兼容，一般不用改）'));
  const aiBaseURL = element('input', 'ai-input');
  aiBaseURL.id = 'ai-baseurl';
  aiBaseURL.type = 'text';
  aiBaseURL.autocomplete = 'off';
  aiBaseURL.spellcheck = false;
  aiBaseURL.placeholder = 'https://api.deepseek.com';
  aiBaseLabel.appendChild(aiBaseURL);

  const aiKeyLabel = element('label', 'ai-field');
  aiKeyLabel.appendChild(element('span', 'ai-label', 'API Key'));
  const aiKey = element('input', 'ai-input');
  aiKey.id = 'ai-key';
  aiKey.type = 'password';
  aiKey.autocomplete = 'off';
  aiKey.spellcheck = false;
  aiKey.placeholder = 'sk-…';
  aiKeyLabel.appendChild(aiKey);

  const aiModelLabel = element('label', 'ai-field');
  aiModelLabel.appendChild(element('span', 'ai-label', '模型'));
  const aiModel = element('input', 'ai-input');
  aiModel.id = 'ai-model';
  aiModel.type = 'text';
  aiModel.autocomplete = 'off';
  aiModel.spellcheck = false;
  aiModel.placeholder = 'deepseek-flash / deepseek-v4-pro';
  aiModel.setAttribute('list', 'ai-model-list');
  const aiModelList = element('datalist');
  aiModelList.id = 'ai-model-list';
  const aiFetchModels = element('button', 'ghost ai-fetch', '获取模型');
  aiFetchModels.id = 'ai-fetch-models';
  aiFetchModels.type = 'button';
  aiFetchModels.title = '用当前地址和 Key 读取服务商 /models 返回的模型';
  const aiModelRow = element('div', 'ai-row');
  aiModelRow.append(aiModel, aiFetchModels);
  aiModelLabel.append(aiModelRow, aiModelList);
  const aiModelChips = element('div', 'ai-chips');
  aiModelChips.id = 'ai-model-chips';
  const aiModelStatus = element('p', 'ai-note', '');
  aiModelStatus.id = 'ai-model-status';

  const aiAdvanced = document.createElement('details');
  aiAdvanced.className = 'advanced';
  const aiAdvancedSummary = document.createElement('summary');
  aiAdvancedSummary.textContent = '高级：思考模式';
  aiAdvanced.appendChild(aiAdvancedSummary);
  const aiThinkLabel = element('label', 'ai-check');
  const aiThink = document.createElement('input');
  aiThink.type = 'checkbox';
  aiThink.id = 'ai-think';
  aiThinkLabel.append(aiThink, element('span', null, '让模型先思考再回答（更慢、更稳；默认关闭）'));
  aiAdvanced.append(aiThinkLabel, element('p', 'ai-note',
    'DeepSeek V4 / 智谱 GLM 默认会思考；关闭后响应更快，适合随堂讲解。'));

  const aiTestRow = element('div', 'ai-test-row');
  const aiTest = element('button', 'ghost ai-test', '测试连接');
  aiTest.id = 'ai-test';
  aiTest.type = 'button';
  const aiTestResult = element('span', 'ai-test-result');
  aiTestResult.id = 'ai-test-result';
  aiTestRow.append(aiTest, aiTestResult);

  const aiActions = element('div', 'ai-actions');
  const aiSave = element('button', 'btn ai-save', '保存');
  aiSave.id = 'ai-save';
  aiSave.type = 'button';
  aiActions.append(aiTestRow, aiSave);

  const aiFootRow = element('div', 'ai-foot-row');
  const aiFoot = element('p', 'ai-foot', 'Key 只保存在本机；AI 请求由扩展直接发往你填的服务商。');
  const aiPanelReset = element('button', 'ai-foot-reset', '重置面板位置');
  aiPanelReset.id = 'ai-panel-reset';
  aiPanelReset.type = 'button';
  aiPanelReset.title = '面板被拖到屏幕外、或尺寸不合适时，点这里恢复默认位置和大小';
  aiFootRow.append(aiFoot, aiPanelReset);

  aiCard.append(
    aiHead, aiHint, aiDupBox, aiProviderLabel, aiBaseLabel, aiKeyLabel,
    aiModelLabel, aiModelChips, aiModelStatus, aiAdvanced,
    aiActions, aiFootRow
  );
  aiSheet.appendChild(aiCard);


  // 课程 PPT 浮层：解析页面文字，供自动分段/讲义使用
  const pptSheet = element('div', 'ai-sheet');
  pptSheet.id = 'ppt-sheet';
  pptSheet.hidden = true;
  const pptCard = element('div', 'ai-card');
  const pptHead = element('div', 'ai-head');
  const pptTitle = element('div', 'ai-title', '课程资料');
  const pptClose = element('button', 'icon-btn', '×');
  pptClose.id = 'ppt-close';
  pptClose.type = 'button';
  pptHead.append(pptTitle, pptClose);
  const pptHint = element('p', 'ai-hint',
    '支持 PPTX / PPT / PDF / DOCX / DOC / TXT / MD；可一次选多个文件，AI 会按内容匹配，'
    + '不要求文件和讲课顺序一致。文字只在本机解析，不上传。');
  const pptFileRow = element('div', 'ppt-file-row');
  const pptFileBtn = element('button', 'ghost ai-test', '添加文件（可多选）');
  pptFileBtn.id = 'ppt-file-btn';
  pptFileBtn.type = 'button';
  const pptInput = document.createElement('input');
  pptInput.type = 'file';
  pptInput.id = 'ppt-input';
  pptInput.multiple = true;
  pptInput.accept = '.pptx,.ppt,.pdf,.docx,.doc,.txt,.md';
  pptInput.hidden = true;
  pptFileRow.append(pptFileBtn, pptInput);
  const pptStatus = element('div', 'ppt-status', '还没有上传资料');
  pptStatus.id = 'ppt-status';
  const pptList = element('ol', 'ppt-list');
  pptList.id = 'ppt-list';
  const pptClear = element('button', 'link-btn', '移除全部资料');
  pptClear.id = 'ppt-clear';
  pptClear.type = 'button';
  pptClear.hidden = true;
  pptCard.classList.add('ppt-card');
  pptCard.append(pptHead, pptHint, pptFileRow, pptStatus, pptList, pptClear);
  pptSheet.appendChild(pptCard);

  // 本节讲义浮层
  const handoutSheet = element('div', 'ai-sheet');
  handoutSheet.id = 'handout-sheet';
  handoutSheet.hidden = true;
  const handoutCard = element('div', 'ai-card handout-card');
  const handoutHead = element('div', 'ai-head');
  const handoutTitle = element('div', 'ai-title', '本节讲义');
  const handoutClose = element('button', 'icon-btn', '×');
  handoutClose.id = 'handout-close';
  handoutClose.type = 'button';
  handoutHead.append(handoutTitle, handoutClose);
  const handoutBody = element('div', 'handout-body');
  handoutBody.id = 'handout-body';
  const handoutFoot = element('div', 'handout-foot');
  handoutFoot.hidden = true;
  const handoutPreviewFoot = element('button', 'btn', '全屏预览');
  handoutPreviewFoot.id = 'handout-preview-foot';
  handoutPreviewFoot.type = 'button';
  const handoutDownloadFoot = element('button', 'ghost', '下载 PDF');
  handoutDownloadFoot.id = 'handout-download-foot';
  handoutDownloadFoot.type = 'button';
  handoutFoot.append(handoutPreviewFoot, handoutDownloadFoot);
  handoutCard.append(handoutHead, handoutBody, handoutFoot);
  handoutSheet.appendChild(handoutCard);

  // 字幕 + 章节浮层
  const transcriptSheet = element('div', 'ai-sheet');
  transcriptSheet.id = 'transcript-sheet';
  transcriptSheet.hidden = true;
  const transcriptCard = element('div', 'ai-card transcript-card');
  const transcriptHead = element('div', 'ai-head');
  const transcriptTitle = element('div', 'ai-title', '字幕');
  const transcriptClose = element('button', 'icon-btn', '×');
  transcriptClose.id = 'transcript-close';
  transcriptClose.type = 'button';
  transcriptHead.append(transcriptTitle, transcriptClose);
  const transcriptBody = element('div', 'transcript-body');
  transcriptBody.id = 'transcript-body';
  const srtInput = document.createElement('input');
  srtInput.type = 'file';
  srtInput.id = 'transcript-srt-input';
  srtInput.accept = '.srt,.vtt,text/plain';
  srtInput.hidden = true;
  transcriptCard.append(transcriptHead, transcriptBody, srtInput);
  transcriptSheet.appendChild(transcriptCard);

  // 字幕覆盖层放在页面层级（不在面板里），才能盖在视频上
  const ccBar = element('div', 'prn-cc-bar');
  ccBar.id = 'prn-cc-bar';
  ccBar.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);'
    + 'max-width:min(74vw,960px);padding:10px 16px;border-radius:8px;background:rgba(0,0,0,.74);'
    + 'color:#fff;font:600 20px/1.4 Arial,"SimHei","Microsoft YaHei",sans-serif;text-align:center;'
    + 'z-index:2147483000;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.8);display:none;';
  (document.body || document.documentElement).appendChild(ccBar);

  wrap.append(header, bar, chapterRail, notice, composer, listWrap, dbg, aiSheet, pptSheet, handoutSheet, transcriptSheet);
  shadow.appendChild(wrap);

  // ---- 面板位置 / 大小（v0.9.3）-------------------------------------------
  // 不同尺寸的屏幕上，固定 360px 的侧栏会挡住播放器。这里改成一个可拖动、可缩放的
  // 浮动面板，并把位置/尺寸写进 chrome.storage.local：
  //   - 拖动标题栏移动；拖四边/四角缩放；双击标题栏复位；
  //   - 宽度变化由 CSS 容器查询触发布局自适应（窄屏压缩字号与间距，宽屏放大阅读区）；
  //   - 停靠在右侧时给页面 body 让出 padding，避免压住视频；移开即恢复。
  const LAYOUT_KEY = 'pku_replay_notes_panel_layout_v1';
  const LAYOUT_MIN_WIDTH = 300;
  const LAYOUT_MIN_HEIGHT = 260;
  const LAYOUT_MAX_WIDTH = 720;

  let panelRect = null;
  let layoutSaveTimer = 0;
  let dragState = null;
  let layoutLastPad = null;

  function viewportSize() {
    return {
      width: Math.max(320, window.innerWidth || 320),
      height: Math.max(320, window.innerHeight || 320),
    };
  }

  function defaultPanelRect() {
    const vp = viewportSize();
    const width = Math.round(Math.min(380, Math.max(320, vp.width * 0.28)));
    const height = Math.min(Math.max(LAYOUT_MIN_HEIGHT, vp.height - 96), vp.height - 24);
    return {
      x: Math.max(8, vp.width - width - 12),
      y: 72,
      width: width,
      height: height,
    };
  }

  function clampPanelRect(rect) {
    const vp = viewportSize();
    const width = Math.min(
      Math.max(LAYOUT_MIN_WIDTH, Math.round(Number(rect.width) || LAYOUT_MIN_WIDTH)),
      Math.max(LAYOUT_MIN_WIDTH, Math.min(LAYOUT_MAX_WIDTH, vp.width - 16))
    );
    const height = Math.min(
      Math.max(LAYOUT_MIN_HEIGHT, Math.round(Number(rect.height) || LAYOUT_MIN_HEIGHT)),
      Math.max(LAYOUT_MIN_HEIGHT, vp.height - 16)
    );
    const x = Math.min(Math.max(8, Math.round(Number(rect.x) || 8)), Math.max(8, vp.width - width - 8));
    const y = Math.min(Math.max(0, Math.round(Number(rect.y) || 0)), Math.max(0, vp.height - height - 8));
    return { x: x, y: y, width: width, height: height };
  }

  function isDockedRight(rect) {
    const vp = viewportSize();
    return vp.width - (rect.x + rect.width) <= 24;
  }

  function pagePaddingFor(rect) {
    const vp = viewportSize();
    if (!isDockedRight(rect)) return 0;
    // 小屏不挤正文：面板浮动，用户自己拖开；宽屏把正文让出来，避免被挡住
    if (vp.width < 1180) return 0;
    return Math.min(rect.width + 24, Math.round(vp.width * 0.46));
  }

  function applyPanelRect(rect, options) {
    const next = clampPanelRect(rect);
    panelRect = next;
    const style = host.style;
    style.setProperty('position', 'fixed', 'important');
    style.setProperty('left', next.x + 'px', 'important');
    style.setProperty('top', next.y + 'px', 'important');
    style.setProperty('right', 'auto', 'important');
    style.setProperty('bottom', 'auto', 'important');
    style.setProperty('width', next.width + 'px', 'important');
    style.setProperty('height', next.height + 'px', 'important');
    style.setProperty('max-width', 'calc(100vw - 16px)', 'important');
    style.setProperty('max-height', 'calc(100vh - 16px)', 'important');
    if (!dragState) {
      const pad = pagePaddingFor(next);
      if (pad !== layoutLastPad) {
        layoutLastPad = pad;
        document.documentElement.style.setProperty('--prn-panel-pad', pad + 'px');
      }
    }
    wrap.classList.toggle('is-short', next.height < 560);
    wrap.classList.toggle('is-tiny', next.height < 430);
    wrap.classList.toggle('is-docked', isDockedRight(next));
    if (!options || !options.silent) scheduleLayoutSave();
    return next;
  }

  function scheduleLayoutSave() {
    if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => {
      layoutSaveTimer = 0;
      savePanelLayout();
    }, 300);
  }

  function savePanelLayout() {
    if (!panelRect) return;
    try {
      const payload = {};
      payload[LAYOUT_KEY] = {
        version: 1,
        x: panelRect.x,
        y: panelRect.y,
        width: panelRect.width,
        height: panelRect.height,
      };
      chrome.storage.local.set(payload, () => {
        if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    } catch (err) {
      /* 存不了位置不影响面板使用 */
    }
  }

  function loadPanelLayout() {
    applyPanelRect(defaultPanelRect(), { silent: true });
    try {
      chrome.storage.local.get(LAYOUT_KEY, (result) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        const saved = result && result[LAYOUT_KEY];
        if (!saved || typeof saved !== 'object') return;
        const rect = {
          x: Number(saved.x),
          y: Number(saved.y),
          width: Number(saved.width),
          height: Number(saved.height),
        };
        if (![rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value))) return;
        applyPanelRect(rect, { silent: true });
      });
    } catch (err) {
      /* 读取失败就用默认位置 */
    }
  }

  function resetPanelLayout() {
    applyPanelRect(defaultPanelRect());
    savePanelLayout();
  }

  function beginPanelDrag(event) {
    if (event.button !== 0 || !panelRect) return;
    const target = event.target;
    if (target && target.closest && target.closest('button, input, select, textarea, a, label')) return;
    event.preventDefault();
    dragState = {
      mode: 'move',
      startX: event.clientX,
      startY: event.clientY,
      rect: { x: panelRect.x, y: panelRect.y, width: panelRect.width, height: panelRect.height },
    };
    wrap.classList.add('is-dragging');
    try {
      header.setPointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
  }

  function beginPanelResize(event, dir) {
    if (event.button !== 0 || !panelRect) return;
    event.preventDefault();
    event.stopPropagation();
    dragState = {
      mode: 'resize',
      dir: dir,
      startX: event.clientX,
      startY: event.clientY,
      rect: { x: panelRect.x, y: panelRect.y, width: panelRect.width, height: panelRect.height },
    };
    wrap.classList.add('is-resizing');
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
  }

  function onPanelPointerMove(event) {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    const base = dragState.rect;
    const vp = viewportSize();
    let rect;
    if (dragState.mode === 'move') {
      rect = { x: base.x + dx, y: base.y + dy, width: base.width, height: base.height };
    } else {
      const dir = dragState.dir;
      const right = base.x + base.width;
      const bottom = base.y + base.height;
      let width = base.width;
      let height = base.height;
      let x = base.x;
      let y = base.y;
      if (dir.indexOf('e') !== -1) width = Math.min(LAYOUT_MAX_WIDTH, base.width + dx);
      if (dir.indexOf('s') !== -1) height = base.height + dy;
      if (dir.indexOf('w') !== -1) {
        width = Math.min(LAYOUT_MAX_WIDTH, base.width - dx);
        width = Math.min(width, right - 8);
        x = right - width;
      }
      if (dir.indexOf('n') !== -1) {
        height = base.height - dy;
        height = Math.min(height, bottom - 8);
        y = bottom - height;
      }
      rect = { x: x, y: y, width: width, height: height };
    }
    applyPanelRect(rect, { silent: true });
  }

  function endPanelDrag() {
    if (!dragState) return;
    dragState = null;
    wrap.classList.remove('is-dragging', 'is-resizing');
    if (panelRect) applyPanelRect(panelRect, { silent: true });
    scheduleLayoutSave();
  }

  function installPanelChrome() {
    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const dir of dirs) {
      const handle = element('div', 'rz rz-' + dir);
      handle.dataset.dir = dir;
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (event) => beginPanelResize(event, dir));
      wrap.appendChild(handle);
    }
    header.title = '拖动标题栏移动面板；双击恢复默认位置';
    header.addEventListener('pointerdown', beginPanelDrag);
    header.addEventListener('dblclick', (event) => {
      const target = event.target;
      if (target && target.closest && target.closest('button')) return;
      resetPanelLayout();
      flashNotice('面板位置已重置');
    });
    window.addEventListener('pointermove', onPanelPointerMove);
    window.addEventListener('pointerup', endPanelDrag);
    window.addEventListener('pointercancel', endPanelDrag);
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      if (!panelRect) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        applyPanelRect(panelRect, { silent: true });
        savePanelLayout();
      }, 160);
    });
  }


  const nodes = {
    title, dot, cur, dur, mark, notice, composer, composerTime,
    noteInput, composerHint, cancel: cancelButton, notes, empty, dbg,
    chapterRail,
    aiGear, aiSheet, aiProvider, aiKey, aiModel, aiModelList,
    aiBaseURL, aiFetchModels, aiModelChips, aiModelStatus,
    aiThink, aiTest, aiTestResult, aiSave, aiClose, aiHint, aiPanelReset, aiFootRow,
    aiDupBox, aiDupText, aiCleanup,
    pptBtn, pptSheet, pptClose, pptFileBtn, pptInput, pptStatus, pptList, pptClear,
    handoutBtn, handoutSheet, handoutClose, handoutBody, handoutFoot, handoutPreviewFoot, handoutDownloadFoot,
    ccBtn, transcriptSheet, transcriptClose, transcriptBody, srtInput, ccBar,
  };

  // ---- 小工具 ------------------------------------------------------------

  function text(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  /** 从 URL 取本节主键：sub_id 是唯一业务主键，token / URL 都会变，绝不能当 key。 */
  function readIds() {
    const sources = [];
    try {
      sources.push(new URL(location.href).searchParams);
    } catch (err) {
      /* 极端情况下 URL 解析失败，退回 search */
    }
    const hash = location.hash || '';
    const hashQuery = hash.indexOf('?');
    if (hashQuery >= 0) sources.push(new URLSearchParams(hash.slice(hashQuery + 1)));
    if (!sources.length) sources.push(new URLSearchParams(location.search));

    const pick = (names) => {
      for (const source of sources) {
        for (const name of names) {
          const value = source.get(name);
          if (value && value.trim()) return value.trim();
        }
      }
      return null;
    };

    return {
      subId: pick(['sub_id', 'subid', 'subId', 'hqySubId']),
      courseId: pick(['course_id', 'courseId', 'hqyCourseId']),
    };
  }

  function courseName() {
    const raw = (document.title || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const head = raw.split(/\s*[-–—|]\s*/)[0].trim();
    return (head || raw).slice(0, 48);
  }

  // ---- 渲染 --------------------------------------------------------------

  function renderTitle() {
    const parts = [];
    const course = courseName();
    if (course) parts.push(course);
    if (state.label) parts.push(state.label);
    const value = parts.join(' · ') || (state.subId ? '课程回放 · 第 ' + state.subId + ' 节' : '课程回放');
    text(nodes.title, value);
    nodes.title.title = value;
  }

  function renderClock(current, duration) {
    text(nodes.cur, Number.isFinite(current) ? time.formatTime(current) : '--:--');
    text(nodes.dur, Number.isFinite(duration) && duration > 0 ? time.formatTime(duration) : '--:--');
    nodes.dot.dataset.state = Number.isFinite(current) ? 'live' : 'idle';
  }

  function emptyHint() {
    if (state.level === 'none') return '当前页面无法读取播放进度。仍可打点，但这条笔记不会带时间戳。';
    if (!state.subId) return '没有识别到本节 sub_id，暂时不能打点。';
    return '还没有笔记。播放到想记住的地方，按 Ctrl+B 或点「在此打点」。';
  }

  function renderNotes(list) {
    const items = Array.isArray(list) ? list : [];
    const signature = JSON.stringify(items.map((note) => {
      const status = state.aiStatus.get(note.id);
      return [
        note.id,
        note.t,
        note.text,
        note.explain ? [note.explain.text, note.explain.model, note.explain.at] : null,
        status ? [status.state, status.message || ''] : null,
      ];
    }));
    if (signature !== state.notesSignature) {
      state.notesSignature = signature;
      const fragment = document.createDocumentFragment();
      for (const note of items) {
        const item = document.createElement('li');
        item.className = 'note';
        item.dataset.id = note.id;

        const line = element('div', 'note-line');

        const stamp = element('button', 'ts', note.t == null ? '--:--' : time.formatTime(note.t));
        stamp.type = 'button';
        stamp.disabled = note.t == null;
        stamp.title = note.t == null ? '这条笔记没有时间戳' : '跳到 ' + time.formatTime(note.t);

        const body = element('span', 'txt', note.text);

        const remove = element('button', 'del', '×');
        remove.type = 'button';
        remove.title = '删除这条笔记';

        line.append(stamp, body, remove);
        item.appendChild(line);

        // 每条笔记下面一块 AI 区：按钮 / 生成中 / 失败重试 / 已生成的讲解
        const aiRow = element('div', 'note-ai');
        const status = state.aiStatus.get(note.id);
        if (note.explain) {
          const details = element('details', 'ai-explain');
          details.open = true;
          details.appendChild(element('summary', 'ai-summary',
            'AI 讲解' + (note.explain.model ? ' · ' + note.explain.model : '')));
          details.appendChild(element('p', 'ai-text', note.explain.text));
          aiRow.appendChild(details);

          const again = element('button', 'ai-link',
            status && status.state === 'loading' ? 'AI 思考中…' : '重新讲解');
          again.type = 'button';
          again.dataset.ai = '1';
          again.disabled = !!(status && status.state === 'loading');
          aiRow.appendChild(again);
        } else if (status && status.state === 'loading') {
          aiRow.appendChild(element('span', 'ai-status', 'AI 正在讲解…'));
        } else if (status && status.state === 'error') {
          aiRow.appendChild(element('span', 'ai-error', status.message || 'AI 讲解失败'));
          const retry = element('button', 'ai-link', '重试');
          retry.type = 'button';
          retry.dataset.ai = '1';
          aiRow.appendChild(retry);
        } else {
          const button = element('button', 'ai-link', 'AI 讲解');
          button.type = 'button';
          button.dataset.ai = '1';
          button.title = '让 AI 解释这条笔记（AI 看不到视频和声音）';
          aiRow.appendChild(button);
        }
        item.appendChild(aiRow);

        fragment.appendChild(item);
      }
      nodes.notes.textContent = '';
      nodes.notes.appendChild(fragment);
    }
    nodes.empty.hidden = items.length > 0;
    text(nodes.empty, emptyHint());
  }

  let debugSignature = '';

  /** 本轮最重要的排障手段：探测级别 / 原始时间值 / sub_id / 播放器对象上的方法名列表。 */
  function renderDebug(force) {
    if (!DEBUG) {
      nodes.dbg.hidden = true;
      return;
    }
    const methods = adapter.methods && adapter.methods.length ? adapter.methods.join(' ') : '（未取到）';
    const signature = [adapter.level, adapter.rawTime, adapter.unit, adapter.seekArgUnit, state.subId, methods].join('|');
    if (!force && signature === debugSignature) return;
    debugSignature = signature;
    if (!nodes.dbg.firstChild) {
      for (const className of ['dbg-row', 'dbg-row', 'dbg-row', 'dbg-methods']) {
        const row = document.createElement('div');
        row.className = className;
        nodes.dbg.appendChild(row);
      }
    }
    nodes.dbg.hidden = false;
    const rows = nodes.dbg.children;
    rows[0].textContent = '探测 ' + adapter.level + ' · from ' + (adapter.playerFrom || '—');
    rows[1].textContent = 'raw ' + (adapter.rawTime == null ? '—' : adapter.rawTime)
      + ' · unit ' + adapter.unit + ' · seek ' + adapter.seekArgUnit;
    rows[2].textContent = 'sub ' + (state.subId || 'none');
    rows[3].textContent = methods;
  }

  // ---- 提示条 ------------------------------------------------------------

  let noticeTimer = null;

  function paintNotice(message) {
    if (!message) {
      nodes.notice.hidden = true;
      text(nodes.notice, '');
      return;
    }
    text(nodes.notice, message);
    nodes.notice.hidden = false;
  }

  function refreshNotice() {
    if (noticeTimer) return; // 临时提示优先，别被常规提示抢掉
    if (!state.subId) paintNotice('没有识别到本节 sub_id，暂时不能打点。');
    else if (state.level === 'none') paintNotice('当前页面无法读取播放进度 · 打点仍可用（无时间戳）。');
    else paintNotice('');
  }

  function flashNotice(message) {
    if (noticeTimer) clearTimeout(noticeTimer);
    paintNotice(message);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      refreshNotice();
    }, 4000);
  }

  function applyLevel(level) {
    state.level = level;
    nodes.mark.disabled = !state.subId;
    if (level === 'none') text(nodes.cur, '--:--');
    text(nodes.empty, emptyHint());
    refreshNotice();
    renderDebug(true);
  }

  // ---- AI 讲解 -----------------------------------------------------------

  function requestAi(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AI 响应超时，请稍后重试')), timeoutMs || AI_REQUEST_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: type, payload: payload }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '扩展后台没有响应'));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function loadAi() {
    try {
      state.ai = await PRN.aiSettings.load();
    } catch (err) {
      state.ai = null;
    }
    if (nodes.handoutSheet && !nodes.handoutSheet.hidden) renderHandoutSheet();
  }

  function aiReady() {
    return !!(state.ai && state.ai.key && state.ai.model && state.ai.baseURL);
  }

  async function explainNote(note) {
    if (!note) return;
    if (!aiReady()) {
      if (!state.ai) await loadAi();
      if (!aiReady()) {
        openAiSheet();
        return;
      }
    }

    state.aiStatus.set(note.id, { state: 'loading' });
    renderNotes(state.notes);

    const sample = await adapter.sample();
    const timeText = note.t != null
      ? time.formatTime(note.t)
      : (Number.isFinite(sample.seconds) ? time.formatTime(sample.seconds) : '');
    const durationText = Number.isFinite(sample.duration) && sample.duration > 0
      ? time.formatTime(sample.duration)
      : '';

    // v0.9.3：统一使用「音频 → 字幕」得到的文字讲解，不再截取或发送画面。

    try {
      const response = await requestAi('prn:ai-explain', {
        subId: state.subId,
        course: courseName(),
        label: state.label,
        timeText: timeText,
        durationText: durationText,
        noteText: note.text,
      });
      if (!response || !response.ok) {
        throw new Error((response && response.message) || 'AI 请求失败');
      }
      await storage.setNoteExplain(note.id, {
        text: response.text,
        model: response.model,
        at: Date.now(),
      });
      state.aiStatus.delete(note.id);
    } catch (err) {
      state.aiStatus.set(note.id, {
        state: 'error',
        message: err && err.message ? err.message : 'AI 讲解失败',
      });
    }
    renderNotes(state.notes);
  }

  function providerDefault() {
    return AI.PROVIDERS[0];
  }

  function legacyModelAliases() {
    // DeepSeek 2026-07-24 下线旧模型名；老用户存的 deepseek-chat / deepseek-reasoner 自动迁移
    return { 'deepseek-chat': 'deepseek-flash', 'deepseek-reasoner': 'deepseek-flash' };
  }

  function activeProvider() {
    return AI.getProvider(nodes.aiProvider.value) || providerDefault();
  }

  function allKnownModels(provider) {
    const models = [];
    for (const model of (provider && provider.models) || []) {
      if (models.indexOf(model) === -1) models.push(model);
    }
    for (const model of state.aiModels) {
      if (models.indexOf(model) === -1) models.push(model);
    }
    return models;
  }

  function renderModelChips(selected) {
    nodes.aiModelChips.textContent = '';
    for (const model of allKnownModels(activeProvider())) {
      const chip = element('button', 'ai-chip', model);
      chip.type = 'button';
      chip.dataset.model = model;
      chip.title = '使用 ' + model;
      if (selected && selected === model) chip.classList.add('active');
      nodes.aiModelChips.appendChild(chip);
    }
  }

  function fillAiModelOptions(provider, selected) {
    nodes.aiModelList.textContent = '';
    const models = allKnownModels(provider);
    if (selected && models.indexOf(selected) === -1) models.unshift(selected);
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      nodes.aiModelList.appendChild(option);
    }
    const value = selected || models[0] || '';
    nodes.aiModel.value = value;
    renderModelChips(value);
  }

  function modelEntriesFromResponse(response) {
    const list = Array.isArray(response && response.models) ? response.models : [];
    const entries = [];
    for (const item of list) {
      if (typeof item === 'string' && item.trim()) {
        entries.push({ id: item.trim(), name: '' });
      } else if (item && typeof item.id === 'string' && item.id.trim()) {
        entries.push({ id: item.id.trim(), name: typeof item.name === 'string' ? item.name.trim() : '' });
      }
    }
    return entries;
  }

  function applyFetchedModels(entries, source) {
    const ids = entries.map((entry) => entry.id);
    if (!ids.length) return;
    state.aiModels = ids.slice(0, 200);
    const aliases = legacyModelAliases();
    const current = nodes.aiModel.value.trim();
    if (!current) {
      nodes.aiModel.value = ids[0];
    } else if (aliases[current] && ids.indexOf(current) === -1) {
      const replacement = ids.indexOf(aliases[current]) >= 0 ? aliases[current] : ids[0];
      nodes.aiModel.value = replacement;
      flashNotice('旧模型名已停用，已切换到 ' + replacement);
    }
    fillAiModelOptions(activeProvider(), nodes.aiModel.value);
    nodes.aiModelStatus.textContent = '已从 ' + (source || '服务商') + ' 读取 ' + ids.length
      + ' 个模型；点上面的模型可直接切换，也可以继续手填。';
    nodes.aiModelStatus.dataset.tone = '';
    text(nodes.aiTestResult, '连接正常 · 可调用模型 ' + ids.length + ' 个');
    nodes.aiTestResult.dataset.tone = 'ok';
  }

  async function fetchAiModels() {
    const provider = activeProvider();
    const key = nodes.aiKey.value.trim();
    const baseURL = nodes.aiBaseURL.value.trim() || provider.baseURL;
    if (!key) {
      text(nodes.aiModelStatus, '先填 API Key，再获取模型');
      nodes.aiModelStatus.dataset.tone = 'bad';
      nodes.aiKey.focus();
      return;
    }
    if (!baseURL) {
      text(nodes.aiModelStatus, '先填接入地址');
      nodes.aiModelStatus.dataset.tone = 'bad';
      nodes.aiBaseURL.focus();
      return;
    }
    nodes.aiFetchModels.disabled = true;
    nodes.aiModelStatus.dataset.tone = '';
    text(nodes.aiModelStatus, '正在读取模型列表…');
    try {
      const response = await requestAi('prn:ai-models', {
        providerId: provider.id,
        baseURL: baseURL,
        key: key,
      }, 30000);
      if (!response || !response.ok) {
        throw new Error((response && response.message) || '读取模型失败');
      }
      const entries = modelEntriesFromResponse(response);
      if (!entries.length) throw new Error('服务商没有返回模型列表；可以手填模型名，或点「测试连接」验证');
      applyFetchedModels(entries, response.endpoint);
    } catch (err) {
      text(nodes.aiModelStatus, (err && err.message) || '读取模型失败；可以手填模型名，或点「测试连接」验证');
      nodes.aiModelStatus.dataset.tone = 'bad';
    } finally {
      nodes.aiFetchModels.disabled = false;
    }
  }

  function fillAiSheet() {
    const settings = state.ai || {};
    const provider = AI.getProvider(settings.providerId) || providerDefault();
    nodes.aiProvider.value = provider.id;
    nodes.aiKey.value = settings.key || '';
    nodes.aiBaseURL.value = settings.baseURL || provider.baseURL || '';
    state.aiModels = Array.isArray(settings.models) ? settings.models.slice(0, 200) : [];
    const aliases = legacyModelAliases();
    let model = settings.model || '';
    if (aliases[model] && (provider.models || []).indexOf(model) === -1) {
      model = aliases[model];
    }
    nodes.aiThink.checked = !!settings.deepThink;
    fillAiModelOptions(provider, model);
    text(nodes.aiTestResult, '');
    nodes.aiTestResult.dataset.tone = '';
    nodes.aiModelStatus.dataset.tone = '';
    text(nodes.aiModelStatus, '');
    text(nodes.aiHint, '音频先在本机转成文字，AI 只处理文字。面板可拖标题栏移动、拖边角缩放。');
  }

  function openAiSheet() {
    fillAiSheet();
    renderDuplicateBox();
    nodes.aiSheet.hidden = false;
    if (!nodes.aiKey.value) nodes.aiKey.focus();
    else nodes.aiModel.focus();
  }

  function closeAiSheet() {
    nodes.aiSheet.hidden = true;
  }

  function renderDuplicateBox() {
    const list = Array.isArray(state.duplicates) ? state.duplicates : [];
    nodes.aiDupBox.hidden = !list.length;
    if (!list.length) return;
    const summary = list.map((item) => item.name + ' ' + item.version).join('、');
    text(nodes.aiDupText,
      '检测到旧版/重复扩展：' + summary + '。它们会和新版同时运行，建议移除后刷新页面再使用。');
  }

  async function checkDuplicates(auto) {
    let response;
    try {
      response = await requestAi('prn:cleanup-duplicates', { all: false, auto: !!auto }, 20000);
    } catch (err) {
      return;
    }
    if (!response || !response.ok) {
      state.cleanupSupported = false;
      state.duplicates = [];
      nodes.aiGear.classList.remove('has-badge');
      renderDuplicateBox();
      return;
    }
    state.cleanupSupported = true;
    state.duplicates = Array.isArray(response.found) ? response.found : [];
    nodes.aiGear.classList.toggle('has-badge', state.duplicates.length > 0);
    renderDuplicateBox();
    if (state.duplicates.length) {
      flashNotice('检测到旧版扩展，可能和新版同时出现；打开齿轮可一键清理，移除后刷新页面。');
    }
  }

  async function cleanupOldExtensions() {
    nodes.aiCleanup.disabled = true;
    text(nodes.aiDupText, '正在请求移除旧版扩展…');
    try {
      const response = await requestAi('prn:cleanup-duplicates', { all: true }, 20000);
      if (!response || !response.ok) {
        text(nodes.aiDupText, (response && response.message) || '当前浏览器不支持自动清理');
        return;
      }
      const found = Array.isArray(response.found) ? response.found : [];
      if (!found.length) {
        text(nodes.aiDupText, '没有发现旧版或重复扩展。');
        state.duplicates = [];
        nodes.aiGear.classList.remove('has-badge');
        renderDuplicateBox();
        return;
      }
      text(nodes.aiDupText,
        '已请求移除 ' + found.length + ' 个旧版；请在弹出的浏览器确认框里点「移除」，然后刷新页面。');
      flashNotice('请在弹出的确认框里点「移除」');
      setTimeout(() => checkDuplicates(false).catch(() => {}), 2500);
    } catch (err) {
      text(nodes.aiDupText, '清理失败：' + ((err && err.message) || '请重试'));
    } finally {
      nodes.aiCleanup.disabled = false;
    }
  }

  function validBaseURL(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (err) {
      return false;
    }
  }

  async function testAiConnection() {
    const provider = activeProvider();
    const key = nodes.aiKey.value.trim();
    const baseURL = (nodes.aiBaseURL.value.trim() || provider.baseURL || '').replace(/\/+$/, '');
    if (!key) {
      text(nodes.aiTestResult, '先填 API Key');
      nodes.aiTestResult.dataset.tone = 'bad';
      nodes.aiKey.focus();
      return;
    }
    if (!baseURL || !validBaseURL(baseURL)) {
      text(nodes.aiTestResult, '接入地址要填完整的 http(s):// 地址');
      nodes.aiTestResult.dataset.tone = 'bad';
      nodes.aiBaseURL.focus();
      return;
    }
    nodes.aiTest.disabled = true;
    text(nodes.aiTestResult, '测试中…');
    nodes.aiTestResult.dataset.tone = '';
    try {
      // 先拉一次模型列表：服务商换了模型名时，旧模型会自动迁移到当前模型；
      // 拉取失败也不影响下面用手填模型名做最小验证。
      if (!state.aiModels.length) await fetchAiModels();
      const model = nodes.aiModel.value.trim();
      if (!model) throw new Error('先选一个模型（可点「获取模型」）');
      const response = await requestAi('prn:ai-probe-model', {
        providerId: provider.id,
        baseURL: baseURL,
        key: key,
        model: model,
      }, 60000);
      if (!response || !response.ok) {
        throw new Error((response && response.message) || '连接失败');
      }
      text(nodes.aiTestResult, '连接正常 · ' + model + ' 可用');
      nodes.aiTestResult.dataset.tone = 'ok';
      text(nodes.aiModelStatus, '当前模型：' + model + '；点「获取模型」可查看服务商返回的全部模型。');
      nodes.aiModelStatus.dataset.tone = '';
    } catch (err) {
      text(nodes.aiTestResult, (err && err.message) || '连接失败');
      nodes.aiTestResult.dataset.tone = 'bad';
    } finally {
      nodes.aiTest.disabled = false;
    }
  }

  async function saveAiSettings() {
    const provider = activeProvider();
    const key = nodes.aiKey.value.trim();
    const baseURL = (nodes.aiBaseURL.value.trim() || provider.baseURL || '').replace(/\/+$/, '');
    const model = nodes.aiModel.value.trim();
    if (!key) {
      text(nodes.aiTestResult, '先填 API Key');
      nodes.aiTestResult.dataset.tone = 'bad';
      nodes.aiKey.focus();
      return;
    }
    if (!baseURL || !validBaseURL(baseURL)) {
      text(nodes.aiTestResult, '接入地址要填完整的 http(s):// 地址');
      nodes.aiTestResult.dataset.tone = 'bad';
      nodes.aiBaseURL.focus();
      return;
    }
    if (!model) {
      text(nodes.aiTestResult, '先选一个模型');
      nodes.aiTestResult.dataset.tone = 'bad';
      nodes.aiModel.focus();
      return;
    }
    const models = [];
    for (const item of (provider.models || [])) {
      if (models.indexOf(item) === -1) models.push(item);
    }
    for (const item of state.aiModels) {
      if (models.indexOf(item) === -1) models.push(item);
    }
    if (models.indexOf(model) === -1) models.push(model);
    state.ai = {
      providerId: provider.id,
      baseURL: baseURL,
      key: key,
      model: model,
      deepThink: !!nodes.aiThink.checked,
      models: models.slice(0, 200),
    };
    await PRN.aiSettings.save(state.ai);
    // 改了配置就把之前的失败状态清掉，避免旧错误一直挂在笔记下面
    state.aiStatus.clear();
    renderNotes(state.notes);
    if (!nodes.handoutSheet.hidden) renderHandoutSheet();
    closeAiSheet();
    flashNotice('AI 讲解已就绪 · ' + AI.maskKey(key) + ' · ' + model);
  }



  function pptKey() {
    return state.subId || state.courseId || '';
  }

  async function loadPpt() {
    const key = pptKey();
    if (!key) {
      state.materials = [];
      state.ppt = null;
      renderPpt();
      return;
    }
    try {
      const saved = await PRN.pptStore.load(key);
      if (pptKey() !== key) return;
      if (saved && Array.isArray(saved.materials)) {
        state.materials = saved.materials;
      } else if (saved && Array.isArray(saved.pages)) {
        // 旧结构：单份资料 → 迁移成 materials 数组
        state.materials = [{
          name: saved.name || '课程资料',
          kind: saved.kind || 'pptx',
          pages: saved.pages,
          warning: saved.warning || '',
        }];
      } else {
        state.materials = [];
      }
    } catch (err) {
      state.materials = [];
    }
    rebuildPpt();
    renderPpt();
  }

  function rebuildPpt() {
    const materials = Array.isArray(state.materials) ? state.materials : [];
    if (!materials.length) {
      state.ppt = null;
      return;
    }
    const multiple = materials.length > 1;
    const pages = [];
    materials.forEach((material, fileIndex) => {
      const unit = documentUnit(material.kind);
      for (const page of material.pages || []) {
        pages.push({
          ...page,
          index: pages.length + 1,
          page: page.index,
          file: material.name,
          fileIndex: fileIndex,
          label: (multiple ? material.name + ' · ' : '') + '第 ' + page.index + ' ' + unit,
        });
      }
    });
    state.ppt = {
      name: materials.map((material) => material.name).join('、'),
      kind: materials.length === 1 ? materials[0].kind : 'mixed',
      pages: pages,
    };
  }

  function documentUnit(kind) {
    return kind === 'docx' ? '节' : '页';
  }

  function pageLabel(kind, index) {
    const page = state.ppt && Array.isArray(state.ppt.pages)
      ? state.ppt.pages.find((item) => item.index === Number(index))
      : null;
    if (page && page.label) return page.label;
    return '第 ' + index + ' ' + documentUnit(kind || 'pptx');
  }

  function materialKindLabel(kind) {
    const labels = { pptx: 'PPT', ppt: 'PPT', pdf: 'PDF', docx: 'Word', doc: 'Word', txt: '文本', md: '文本' };
    return labels[kind] || '资料';
  }

  function renderPpt() {
    const materials = Array.isArray(state.materials) ? state.materials : [];
    nodes.pptList.textContent = '';
    if (!materials.length) {
      text(nodes.pptStatus, pptKey() ? '还没有上传资料' : '没有识别到本节 ID，资料只能本次使用');
      nodes.pptClear.hidden = true;
      nodes.pptList.appendChild(element('li', 'ppt-empty',
        '支持 PPTX / PDF / DOCX / TXT / MD；可以一次选多个文件。'));
      return;
    }
    const total = materials.reduce((sum, material) => sum + (material.pages ? material.pages.length : 0), 0);
    let status = '已上传 ' + materials.length + ' 个文件 · 共 ' + total + ' 页/节';
    const warnings = materials.map((material) => material.warning).filter(Boolean);
    if (warnings.length) status += ' · ' + String(warnings[0]).slice(0, 50);
    text(nodes.pptStatus, status);
    nodes.pptStatus.title = warnings.join('\n');
    nodes.pptClear.hidden = false;
    materials.forEach((material, index) => {
      const item = element('li', 'material-item');
      item.appendChild(element('span', 'material-name', material.name));
      const unit = documentUnit(material.kind);
      item.appendChild(element('span', 'material-meta',
        materialKindLabel(material.kind) + ' · ' + material.pages.length + ' ' + unit));
      const remove = element('button', 'material-remove', '×');
      remove.type = 'button';
      remove.title = '移除这个文件';
      remove.dataset.removeMaterial = String(index);
      item.appendChild(remove);
      nodes.pptList.appendChild(item);
    });
  }

  function openPptSheet() {
    nodes.pptSheet.hidden = false;
    renderPpt();
    loadPpt().catch(() => {});
  }

  function closePptSheet() {
    nodes.pptSheet.hidden = true;
  }

  async function importDocumentViaService(file) {
    const buffer = await file.arrayBuffer();
    const baseURL = state.transcriptService.replace(/\/+$/, '');
    const begin = await requestAi('prn:doc-begin', {
      baseURL: baseURL,
      filename: file.name,
      size: buffer.byteLength,
    }, 20000);
    if (!begin || !begin.ok) throw new Error((begin && begin.message) || '无法上传文件');
    const uploadId = begin.uploadId;
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
      const chunk = buffer.slice(offset, Math.min(buffer.byteLength, offset + chunkSize));
      const part = await requestAi('prn:doc-chunk', {
        uploadId: uploadId,
        data: bufferToBase64(chunk),
      }, 30000);
      if (!part || !part.ok) throw new Error((part && part.message) || '分片上传失败');
      const percent = Math.min(90, Math.round(((offset + chunk.byteLength) / buffer.byteLength) * 90));
      text(nodes.pptStatus, '正在上传并解析 ' + file.name + ' · ' + percent + '%…');
    }
    const end = await requestAi('prn:doc-end', { uploadId: uploadId }, 300000);
    if (!end || !end.ok) throw new Error((end && end.message) || '解析失败');
    const data = end.result;
    if (!data || !data.ok) throw new Error((data && data.error) || '本地服务解析失败');
    return { kind: data.kind, pages: data.pages || [], warning: data.warning || '' };
  }

  async function parseMaterial(file) {
    const extMatch = file.name.match(/\.[^.]+$/);
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    const allowed = ['.pptx', '.ppt', '.pdf', '.docx', '.doc', '.txt', '.md'];
    if (!allowed.includes(ext)) throw new Error('支持 PPTX / PPT / PDF / DOCX / DOC / TXT / MD');
    let imported = null;
    if (ext === '.pptx') {
      try {
        const result = await PRN.pptx.parseFile(file);
        if (result.pages.length) imported = { kind: 'pptx', pages: result.pages, warning: '' };
      } catch (err) {
        imported = null;
      }
    }
    if (!imported) imported = await importDocumentViaService(file);
    if (!imported.pages.length) throw new Error('没有解析到文字');
    return {
      name: file.name,
      kind: imported.kind,
      pages: imported.pages,
      warning: imported.warning || '',
      importedAt: Date.now(),
    };
  }

  async function savePpt() {
    const key = pptKey();
    if (!key) return;
    await PRN.pptStore.save(key, { version: 2, materials: state.materials });
  }

  async function importPptFiles(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    const errors = [];
    for (const file of list) {
      text(nodes.pptStatus, '正在解析 ' + file.name + '…');
      try {
        const material = await parseMaterial(file);
        const existing = state.materials.findIndex((item) => item.name === material.name);
        if (existing >= 0) state.materials[existing] = material;
        else state.materials.push(material);
      } catch (err) {
        errors.push(file.name + '：' + ((err && err.message) || '解析失败'));
      }
    }
    rebuildPpt();
    try {
      await savePpt();
    } catch (err) {
      errors.push('本地保存失败');
    }
    renderPpt();
    if (errors.length) {
      text(nodes.pptStatus, '部分文件失败：' + errors[0]);
    } else {
      flashNotice('已上传 ' + list.length + ' 个文件');
    }
  }

  async function importPpt(file) {
    return importPptFiles([file]);
  }

  async function removeMaterial(index) {
    state.materials.splice(index, 1);
    rebuildPpt();
    try {
      await savePpt();
    } catch (err) {
      /* ignore */
    }
    renderPpt();
  }

  async function clearPpt() {
    state.materials = [];
    state.ppt = null;
    if (pptKey()) {
      try {
        await PRN.pptStore.clear(pptKey());
      } catch (err) {
        /* ignore */
      }
    }
    renderPpt();
    flashNotice('已移除全部资料');
  }

  // ---- 本节讲义（扫片 → 识别 → 按页）--------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function hammingHex(a, b) {
    if (!a || !b) return 64;
    try {
      let value = BigInt('0x' + a) ^ BigInt('0x' + b);
      let count = 0;
      while (value) {
        count += Number(value & 1n);
        value >>= 1n;
      }
      return count;
    } catch (err) {
      return 64;
    }
  }

  function normalizeForMatch(value) {
    return String(value || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  }

  function bigramSet(text) {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  }

  function similarity(a, b) {
    const left = normalizeForMatch(a);
    const right = normalizeForMatch(b);
    if (!left || !right) return 0;
    const leftSet = bigramSet(left);
    const rightSet = bigramSet(right);
    let overlap = 0;
    for (const gram of leftSet) {
      if (rightSet.has(gram)) overlap += 1;
    }
    return (2 * overlap) / (leftSet.size + rightSet.size);
  }

  function matchPage(slide, pages) {
    if (!pages.length) return null;
    const text = (slide.title || '') + ' ' + (slide.points || []).join(' ');
    let best = null;
    let bestScore = 0;
    for (const page of pages) {
      const score = similarity(text, (page.title || '') + ' ' + (page.text || ''));
      if (score > bestScore) {
        bestScore = score;
        best = page;
      }
    }
    return bestScore >= 0.18 ? best : null;
  }

  /** 把「每帧的幻灯片识别结果」拼成按页时间段，并挂上这一段的笔记。 */
  function buildSegments(slides, duration, ppt, notes) {
    const pages = ppt && Array.isArray(ppt.pages) ? ppt.pages : [];
    const ordered = slides.slice().sort((a, b) => a.t - b.t);
    const segments = [];
    for (const slide of ordered) {
      const page = matchPage(slide, pages);
      const pageIndex = page ? page.index : null;
      const last = segments[segments.length - 1];
      if (last && pageIndex != null && last.page === pageIndex) {
        last.points = last.points.concat(slide.points || []).slice(0, 10);
        continue;
      }
      segments.push({
        page: pageIndex,
        start: Math.max(0, Math.round(slide.t)),
        heading: page ? page.title : (slide.title || '未识别'),
        slideText: page ? page.text : '',
        points: (slide.points || []).slice(0, 10),
        notes: [],
      });
    }
    for (let i = 0; i < segments.length; i += 1) {
      segments[i].end = i + 1 < segments.length ? segments[i + 1].start : Math.round(duration);
      const start = segments[i].start;
      const end = segments[i].end;
      segments[i].notes = notes
        .filter((note) => note.t != null && note.t >= start && note.t < end)
        .map((note) => note.text);
    }
    return segments;
  }

  async function loadHandout() {
    if (!state.subId) {
      state.handout = null;
      if (!nodes.handoutSheet.hidden) renderHandoutSheet();
      return;
    }
    const subId = state.subId;
    try {
      const saved = await PRN.handoutStore.load(subId);
      if (state.subId !== subId) return;
      state.handout = saved;
    } catch (err) {
      if (state.subId !== subId) return;
      state.handout = null;
    }
    renderSegments();
    if (!nodes.handoutSheet.hidden) renderHandoutSheet();
  }

  function renderScanProgress(body) {
    const scan = state.scan;
    let label = '正在采样 ' + scan.done + '/' + scan.total;
    if (scan.phase === 'recognizing') label = '正在识别画面 ' + scan.recognized + '/' + scan.frames;
    if (scan.phase === 'handout') label = '正在整理讲义…';
    const row = element('div', 'progress-row');
    row.appendChild(element('span', null, label));
    row.appendChild(element('span', 'meta', scan.percent + '%'));
    const track = element('div', 'progress-track');
    const fill = element('span');
    fill.style.width = Math.max(2, scan.percent) + '%';
    track.appendChild(fill);
    const cancel = element('button', 'link-btn', '取消');
    cancel.id = 'handout-cancel';
    cancel.type = 'button';
    body.append(row, track, cancel);
  }

  function figureNode(figure) {
    if (!figure) return null;
    const box = element('div', 'figure');
    if (figure.title) box.appendChild(element('div', 'figure-title', figure.title));
    if (figure.kind === 'flow') {
      const flow = element('div', 'figure-flow');
      (figure.steps || []).forEach((step, index) => {
        const node = element('div', 'figure-step');
        node.appendChild(element('span', 'figure-step-index', String(index + 1)));
        node.appendChild(element('strong', 'figure-step-label', step.label || ''));
        if (step.detail) node.appendChild(element('span', 'figure-step-detail', step.detail));
        flow.appendChild(node);
        if (index < figure.steps.length - 1) flow.appendChild(element('span', 'figure-arrow', '→'));
      });
      box.appendChild(flow);
    } else if (figure.kind === 'compare') {
      const compare = element('div', 'figure-compare');
      for (const side of [figure.left, figure.right]) {
        const column = element('div', 'figure-side');
        column.appendChild(element('strong', 'figure-side-title', (side && side.title) || ''));
        const list = element('ul', 'figure-side-list');
        for (const item of (side && side.items) || []) list.appendChild(element('li', null, item));
        column.appendChild(list);
        compare.appendChild(column);
      }
      box.appendChild(compare);
    } else if (figure.kind === 'table') {
      const table = document.createElement('table');
      table.className = 'figure-table';
      if (figure.headers && figure.headers.length) {
        const head = document.createElement('thead');
        const row = document.createElement('tr');
        for (const header of figure.headers) {
          const cell = document.createElement('th');
          cell.textContent = header;
          row.appendChild(cell);
        }
        head.appendChild(row);
        table.appendChild(head);
      }
      const body = document.createElement('tbody');
      for (const row of figure.rows || []) {
        const tr = document.createElement('tr');
        for (const value of row) {
          const cell = document.createElement('td');
          cell.textContent = value;
          tr.appendChild(cell);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
      box.appendChild(table);
    } else {
      return null;
    }
    return box;
  }

  function renderHandoutDone(body, stored) {
    const handout = stored.handout;
    body.appendChild(element('h3', 'handout-title-small', handout.title || '本节讲义'));
    if (handout.subtitle) body.appendChild(element('p', 'meta', handout.subtitle));
    if (handout.notice) body.appendChild(element('p', 'ai-error', handout.notice));
    if (handout.summary) body.appendChild(element('p', 'meta', handout.summary));
    if (handout.objectives && handout.objectives.length) {
      body.appendChild(element('div', 'handout-block-label', '本讲目标'));
      const objectives = element('ul', 'objectives-list');
      for (const objective of handout.objectives) objectives.appendChild(element('li', 'objective', objective));
      body.appendChild(objectives);
    }
    const list = element('ul', 'handout-sections');
    for (const section of handout.sections || []) {
      const item = element('li', 'handout-seg');
      const timeNode = element('button', 'seg-time',
        time.formatTime(section.start) + '–' + time.formatTime(section.end));
      timeNode.type = 'button';
      timeNode.dataset.seek = String(section.start);
      timeNode.title = '跳到 ' + time.formatTime(section.start);
      item.appendChild(timeNode);
      item.appendChild(element('div', 'seg-heading',
        (section.page ? pageLabel(state.ppt && state.ppt.kind, section.page) + ' · ' : '') + (section.heading || '')));
      if (section.intuition) item.appendChild(element('p', 'seg-intuition', '一句话理解：' + section.intuition));
      if (Array.isArray(section.body) && section.body.length) {
        const textBody = element('div', 'seg-body');
        for (const paragraph of section.body) textBody.appendChild(element('p', 'seg-paragraph', paragraph));
        item.appendChild(textBody);
      } else if (section.body) {
        item.appendChild(element('p', 'seg-body', section.body));
      }
      const figure = figureNode(section.figure);
      if (figure) item.appendChild(figure);
      if (section.example && (section.example.title || (section.example.steps || []).length)) {
        const example = element('div', 'example-box');
        example.appendChild(element('div', 'example-title', '例子：' + (section.example.title || '')));
        const steps = element('ol', 'example-steps');
        for (const step of section.example.steps || []) steps.appendChild(element('li', null, step));
        example.appendChild(steps);
        item.appendChild(example);
      }
      if (section.pitfalls && section.pitfalls.length) {
        item.appendChild(element('div', 'section-label', '易错点'));
        const pitfalls = element('ul', 'pitfalls-list');
        for (const pitfall of section.pitfalls) pitfalls.appendChild(element('li', null, pitfall));
        item.appendChild(pitfalls);
      }
      if (section.takeaway) item.appendChild(element('div', 'takeaway', '记住：' + section.takeaway));
      if (Array.isArray(section.gaps) && section.gaps.length) {
        item.appendChild(element('div', 'chapter-gap-label', '资料 / 讲解差异'));
        const gapList = element('ul', 'chapter-gaps');
        for (const gap of section.gaps) gapList.appendChild(element('li', 'chapter-gap', gap));
        item.appendChild(gapList);
      }
      list.appendChild(item);
    }
    body.appendChild(list);
    const pages = state.ppt && Array.isArray(state.ppt.pages) ? state.ppt.pages : [];
    if (pages.length && handout.sections.length) {
      const covered = new Set(handout.sections.map((section) => section.page).filter(Boolean));
      const missing = pages.filter((page) => !covered.has(page.index)).map((page) => page.index);
      if (missing.length) {
        body.appendChild(element('p', 'ai-hint',
          '资料第 ' + missing.slice(0, 8).join('、') + ' 页没有对应到讲义分节；可能老师没讲到，'
          + '或在各节的「资料 / 讲解差异」里。'));
      }
    }
    if (handout.terms && handout.terms.length) {
      body.appendChild(element('div', 'handout-block-label', '术语'));
      const terms = element('ul', 'terms-list');
      for (const term of handout.terms) {
        const item = element('li', 'term');
        item.appendChild(element('span', 'term-name', term.term + (term.en ? ' · ' + term.en : '')));
        if (term.plain) item.appendChild(element('p', 'term-plain', term.plain));
        if (term.why) item.appendChild(element('p', 'term-why', '为什么重要：' + term.why));
        if (term.example) item.appendChild(element('p', 'term-example', '例：' + term.example));
        terms.appendChild(item);
      }
      body.appendChild(terms);
    }
    if (handout.review && handout.review.length) {
      body.appendChild(element('div', 'handout-block-label', '自测'));
      const review = element('ol', 'review-list');
      for (const item of handout.review) {
        const node = element('li', 'review-item');
        node.appendChild(element('div', 'review-q', item.q));
        if (item.hint) node.appendChild(element('div', 'review-hint', '提示：' + item.hint));
        review.appendChild(node);
      }
      body.appendChild(review);
    }
    if (handout.gaps && handout.gaps.length) {
      body.appendChild(element('div', 'handout-block-label', '没覆盖到的'));
      const gaps = element('ul', 'untouched-list');
      for (const gap of handout.gaps) gaps.appendChild(element('li', 'untouched-item', gap));
      body.appendChild(gaps);
    }
    const actions = element('div', 'handout-actions');
    const copy = element('button', 'ghost ai-test', '复制 Markdown');
    copy.id = 'handout-copy';
    copy.type = 'button';
    const rescan = element('button', 'link-btn', '重新生成');
    rescan.id = 'handout-rescan';
    rescan.type = 'button';
    actions.append(copy, rescan);
    body.appendChild(actions);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function figureHtml(figure) {
    if (!figure) return '';
    let inner = '';
    if (figure.kind === 'flow') {
      inner = '<div class="fig-flow">' + (figure.steps || []).map((step, index) =>
        '<div class="fig-step"><span class="fig-index">' + (index + 1) + '</span>'
        + '<strong>' + escapeHtml(step.label) + '</strong>'
        + (step.detail ? '<span class="fig-detail">' + escapeHtml(step.detail) + '</span>' : '')
        + '</div>' + (index < figure.steps.length - 1 ? '<span class="fig-arrow">→</span>' : '')
      ).join('') + '</div>';
    } else if (figure.kind === 'compare') {
      inner = '<div class="fig-compare">'
        + [figure.left, figure.right].map((side) =>
          '<div class="fig-side"><h4>' + escapeHtml(side && side.title) + '</h4><ul>'
          + ((side && side.items) || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join('')
          + '</ul></div>').join('')
        + '</div>';
    } else if (figure.kind === 'table') {
      inner = '<table class="fig-table">'
        + (figure.headers && figure.headers.length
          ? '<thead><tr>' + figure.headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('') + '</tr></thead>'
          : '')
        + '<tbody>' + (figure.rows || []).map((row) =>
          '<tr>' + row.map((value) => '<td>' + escapeHtml(value) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
    } else {
      return '';
    }
    return '<figure class="fig">' + (figure.title ? '<figcaption>' + escapeHtml(figure.title) + '</figcaption>' : '') + inner + '</figure>';
  }

  function buildHandoutDocument(stored) {
    const h = stored.handout || {};
    const sections = (h.sections || []).map((section, index) => {
      const bodyParagraphs = Array.isArray(section.body) ? section.body : (section.body ? [section.body] : []);
      const body = bodyParagraphs.map((paragraph) => '<p>' + escapeHtml(paragraph) + '</p>').join('');
      const example = section.example && (section.example.steps || []).length
        ? '<div class="example"><div class="box-title">例子：' + escapeHtml(section.example.title) + '</div><ol>'
          + section.example.steps.map((step) => '<li>' + escapeHtml(step) + '</li>').join('') + '</ol></div>'
        : '';
      const pitfalls = (section.pitfalls || []).length
        ? '<div class="pitfalls"><div class="box-title">易错点</div><ul>'
          + section.pitfalls.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul></div>'
        : '';
      const gaps = (section.gaps || []).length
        ? '<div class="gaps"><div class="box-title">资料 / 讲解差异</div><ul>'
          + section.gaps.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul></div>'
        : '';
      return '<section class="section">'
        + '<div class="section-head"><span class="section-no">' + String(index + 1).padStart(2, '0') + '</span>'
        + '<div><h2>' + escapeHtml(section.heading) + '</h2>'
        + '<div class="section-meta">' + time.formatTime(section.start) + '–' + time.formatTime(section.end)
        + (section.page ? ' · ' + escapeHtml(pageLabel(state.ppt && state.ppt.kind, section.page)) : '')
        + '</div></div></div>'
        + (section.intuition ? '<div class="intuition"><span>一句话理解</span>' + escapeHtml(section.intuition) + '</div>' : '')
        + '<div class="section-body">' + body + '</div>'
        + figureHtml(section.figure)
        + example
        + pitfalls
        + (section.takeaway ? '<div class="takeaway">记住：' + escapeHtml(section.takeaway) + '</div>' : '')
        + gaps
        + '</section>';
    }).join('');
    const terms = (h.terms || []).length
      ? '<section class="section terms"><h2>术语表</h2><div class="term-grid">'
        + h.terms.map((term) => '<div class="term-card"><div class="term-head">' + escapeHtml(term.term)
          + (term.en ? '<span>' + escapeHtml(term.en) + '</span>' : '') + '</div>'
          + (term.plain ? '<p>' + escapeHtml(term.plain) + '</p>' : '')
          + (term.why ? '<p class="why">为什么重要：' + escapeHtml(term.why) + '</p>' : '')
          + (term.example ? '<p class="example-line">例：' + escapeHtml(term.example) + '</p>' : '')
          + '</div>').join('') + '</div></section>'
      : '';
    const review = (h.review || []).length
      ? '<section class="section review"><h2>自测</h2><ol>'
        + h.review.map((item) => '<li><div>' + escapeHtml(item.q) + '</div>'
          + (item.hint ? '<div class="hint">提示：' + escapeHtml(item.hint) + '</div>' : '') + '</li>').join('')
        + '</ol></section>'
      : '';
    const objectives = (h.objectives || []).length
      ? '<div class="objectives"><div class="box-title">本讲目标</div><ul>'
        + h.objectives.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul></div>'
      : '';
    const gaps = (h.gaps || []).length
      ? '<section class="section"><h2>还没覆盖到的</h2><ul class="global-gaps">'
        + h.gaps.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul></section>'
      : '';
    const generated = new Date(stored.generatedAt || Date.now()).toLocaleDateString('zh-CN');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(h.title || '课程讲义')}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#e9edf2;color:#1f2933;font-family:"Times New Roman","SimSun","Songti SC",serif;line-height:1.75}
  .page{max-width:920px;margin:28px auto;background:#fff;padding:54px 62px 64px;box-shadow:0 10px 30px rgba(0,0,0,.12)}
  .cover{border-bottom:3px solid #C0564A;padding-bottom:22px;margin-bottom:26px}
  .cover .eyebrow{color:#C0564A;font-size:12px;letter-spacing:2px;font-weight:700}
  .cover h1{font-size:30px;line-height:1.35;margin:8px 0 10px}
  .cover .sub{color:#5c6b7a;font-size:15px;margin:0 0 8px}
  .cover .meta{color:#8a97a6;font-size:12px}
  .audience{display:inline-block;background:#FBEDE9;color:#A54236;border-radius:999px;padding:2px 10px;font-size:12px;margin-top:10px}
  .notice{background:#FDF3F1;border:1px solid #F1D5CF;color:#A54236;border-radius:8px;padding:8px 12px;font-size:12px;margin:0 0 18px}
  .objectives{background:#F4F8FB;border:1px solid #DCE8F1;border-radius:10px;padding:16px 20px;margin:0 0 26px}
  .box-title{font-weight:700;color:#2E5A78;margin-bottom:6px;font-size:13px}
  .objectives ul{margin:0;padding-left:20px}
  .section{break-inside:avoid;page-break-inside:avoid;margin:0 0 30px;padding-bottom:22px;border-bottom:1px dashed #DDE3EA}
  .section:last-child{border-bottom:0}
  .section-head{display:flex;gap:14px;align-items:flex-start;margin-bottom:10px}
  .section-no{flex:0 0 auto;font-size:22px;font-weight:800;color:#C0564A;line-height:1.2;font-variant-numeric:tabular-nums}
  .section h2{font-size:20px;margin:0 0 2px;line-height:1.4}
  .section-meta{color:#8a97a6;font-size:12px}
  .intuition{background:#FFF8E8;border-left:4px solid #E5A83B;padding:10px 14px;border-radius:0 8px 8px 0;margin:10px 0 14px;font-size:15px}
  .intuition span{color:#A56B10;font-weight:700;margin-right:8px;font-size:12px}
  .section-body p{margin:0 0 10px;text-align:justify}
  .fig{margin:18px 0;border:1px solid #DCE3EB;border-radius:12px;padding:14px 16px;background:#FBFDFE}
  .fig figcaption{font-weight:700;color:#334E68;margin-bottom:10px;font-size:13px}
  .fig-flow{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .fig-step{flex:1 1 150px;display:flex;flex-direction:column;gap:2px;background:#fff;border:1px solid #DCE3EB;border-radius:8px;padding:9px 11px}
  .fig-index{font-size:10px;color:#C0564A;font-weight:700}
  .fig-step strong{font-size:13px}
  .fig-detail{font-size:12px;color:#5c6b7a}
  .fig-arrow{color:#AAB6C2;font-weight:700}
  .fig-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .fig-side{background:#fff;border:1px solid #DCE3EB;border-radius:8px;padding:10px 12px}
  .fig-side h4{margin:0 0 6px;font-size:13px;color:#2E5A78}
  .fig-side ul{margin:0;padding-left:18px;font-size:13px}
  .fig-table{width:100%;border-collapse:collapse;font-size:13px}
  .fig-table th,.fig-table td{border:1px solid #DCE3EB;padding:6px 8px;text-align:left}
  .fig-table th{background:#F1F6FA;color:#2E5A78}
  .example{background:#F2F8F4;border:1px solid #CFE5D6;border-radius:10px;padding:12px 16px;margin:16px 0}
  .example .box-title{color:#2D6A45}
  .example ol{margin:0;padding-left:20px}
  .pitfalls{background:#FDF3F1;border:1px solid #F1D5CF;border-radius:10px;padding:12px 16px;margin:12px 0}
  .pitfalls .box-title{color:#A54236}
  .pitfalls ul{margin:0;padding-left:20px}
  .takeaway{font-weight:700;color:#2E5A78;background:#F1F6FA;border-radius:8px;padding:9px 12px;margin:12px 0 0;font-size:14px}
  .gaps{font-size:12px;color:#7a8794;margin-top:10px}
  .gaps ul{margin:4px 0 0;padding-left:18px}
  .term-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .term-card{border:1px solid #DCE3EB;border-radius:10px;padding:12px 14px;background:#FBFDFE;break-inside:avoid;page-break-inside:avoid}
  .term-head{font-weight:700;color:#1f2933;margin-bottom:4px}
  .term-head span{font-weight:400;color:#8a97a6;font-size:11px;margin-left:6px}
  .term-card p{margin:4px 0;font-size:13px}
  .term-card .why{color:#5c6b7a}
  .term-card .example-line{color:#2D6A45}
  .review ol{padding-left:20px;margin:0}
  .review li{margin:0 0 10px;font-size:14px}
  .review .hint{color:#8a97a6;font-size:12px;margin-top:2px}
  .global-gaps{color:#7a8794;font-size:13px;padding-left:20px}
  .footer{margin-top:34px;padding-top:14px;border-top:1px solid #E4E9EF;color:#9AA6B2;font-size:11px;text-align:center}
  @media print{
    body{background:#fff}
    .page{max-width:none;margin:0;padding:0;box-shadow:none}
    .section,.term-card{break-inside:avoid;page-break-inside:avoid}
  }
  @page{size:A4;margin:14mm 14mm 16mm}
</style></head><body><main class="page">
  <header class="cover">
    <div class="eyebrow">PRINCIPLES · 课堂实录讲义</div>
    <h1>${escapeHtml(h.title || '课程讲义')}</h1>
    <p class="sub">${escapeHtml(h.subtitle || courseName() + ' · ' + state.label)}</p>
    <div class="meta">根据课堂录音转写 + 课程资料生成 · ${generated}</div>
    <span class="audience">${escapeHtml(h.audience || '零基础')}</span>
  </header>
  ${h.notice ? '<p class="notice">' + escapeHtml(h.notice) + '</p>' : ''}
  ${objectives}
  ${sections}
  ${terms}
  ${review}
  ${gaps}
  <div class="footer">由「课堂实录回放笔记」生成 · 内容以老师课堂讲解为准</div>
</main></body></html>`;
  }

  function figurePrintHtml(figure) {
    if (!figure) return '';
    let table = '';
    if (figure.kind === 'flow') {
      table = '<table><tr><th>步骤</th><th>说明</th></tr>'
        + (figure.steps || []).map((step, index) =>
          '<tr><td>' + (index + 1) + '. ' + escapeHtml(step.label) + '</td><td>'
          + escapeHtml(step.detail || '') + '</td></tr>').join('')
        + '</table>';
    } else if (figure.kind === 'compare') {
      table = '<table><tr><th>' + escapeHtml((figure.left && figure.left.title) || '')
        + '</th><th>' + escapeHtml((figure.right && figure.right.title) || '') + '</th></tr><tr><td><ul>'
        + (((figure.left && figure.left.items) || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join(''))
        + '</ul></td><td><ul>'
        + (((figure.right && figure.right.items) || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join(''))
        + '</ul></td></tr></table>';
    } else if (figure.kind === 'table') {
      table = '<table>'
        + ((figure.headers || []).length
          ? '<tr>' + figure.headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('') + '</tr>'
          : '')
        + (figure.rows || []).map((row) =>
          '<tr>' + row.map((value) => '<td>' + escapeHtml(value) + '</td>').join('') + '</tr>').join('')
        + '</table>';
    } else {
      return '';
    }
    return (figure.title ? '<p class="meta"><b>图示：' + escapeHtml(figure.title) + '</b></p>' : '') + table;
  }

  /** 给本地服务生成 PDF 用的简化 HTML：只用块级元素/列表/表格，Story 引擎能稳定排版。 */
  function buildHandoutPrintDocument(stored) {
    const h = stored.handout || {};
    const parts = [];
    parts.push('<h1>' + escapeHtml(h.title || '课程讲义') + '</h1>');
    if (h.subtitle) parts.push('<p class="meta">' + escapeHtml(h.subtitle) + '</p>');
    parts.push('<p class="cover-meta">根据课堂录音转写 + 课程资料生成 · '
      + escapeHtml(new Date(stored.generatedAt || Date.now()).toLocaleDateString('zh-CN')) + '</p>');
    if (h.notice) parts.push('<div class="notice">' + escapeHtml(h.notice) + '</div>');
    if (h.summary) parts.push('<p>' + escapeHtml(h.summary) + '</p>');
    if ((h.objectives || []).length) {
      parts.push('<h3>本讲目标</h3><ul>'
        + h.objectives.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>');
    }
    (h.sections || []).forEach((section, index) => {
      parts.push('<h2>' + String(index + 1).padStart(2, '0') + ' · ' + escapeHtml(section.heading) + '</h2>');
      parts.push('<p class="meta">' + time.formatTime(section.start) + '–' + time.formatTime(section.end)
        + (section.page ? ' · ' + escapeHtml(pageLabel(state.ppt && state.ppt.kind, section.page)) : '') + '</p>');
      if (section.intuition) {
        parts.push('<div class="intuition"><b>一句话理解：</b>' + escapeHtml(section.intuition) + '</div>');
      }
      const body = Array.isArray(section.body) ? section.body : (section.body ? [section.body] : []);
      for (const paragraph of body) parts.push('<p>' + escapeHtml(paragraph) + '</p>');
      parts.push(figurePrintHtml(section.figure));
      if (section.example && (section.example.steps || []).length) {
        parts.push('<div class="box"><b>例子：' + escapeHtml(section.example.title) + '</b><ol>'
          + section.example.steps.map((step) => '<li>' + escapeHtml(step) + '</li>').join('') + '</ol></div>');
      }
      if ((section.pitfalls || []).length) {
        parts.push('<div class="pitfall"><b>易错点</b><ul>'
          + section.pitfalls.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul></div>');
      }
      if (section.takeaway) parts.push('<div class="takeaway">记住：' + escapeHtml(section.takeaway) + '</div>');
      if ((section.gaps || []).length) {
        parts.push('<p class="meta">资料 / 讲解差异：' + escapeHtml(section.gaps.join('；')) + '</p>');
      }
    });
    if ((h.terms || []).length) {
      parts.push('<h3>术语表</h3>');
      for (const term of h.terms) {
        parts.push('<div class="term"><b>' + escapeHtml(term.term)
          + (term.en ? ' / ' + escapeHtml(term.en) : '') + '</b>'
          + (term.plain ? '<p>' + escapeHtml(term.plain) + '</p>' : '')
          + (term.why ? '<p class="meta">为什么重要：' + escapeHtml(term.why) + '</p>' : '')
          + (term.example ? '<p class="meta">例：' + escapeHtml(term.example) + '</p>' : '')
          + '</div>');
      }
    }
    if ((h.review || []).length) {
      parts.push('<h3>自测</h3><ol>'
        + h.review.map((item) => '<li>' + escapeHtml(item.q)
          + (item.hint ? '（提示：' + escapeHtml(item.hint) + '）' : '') + '</li>').join('') + '</ol>');
    }
    if ((h.gaps || []).length) {
      parts.push('<h3>还没覆盖到的</h3><ul>'
        + h.gaps.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>');
    }
    parts.push('<p class="meta">由「课堂实录回放笔记」生成 · 内容以老师课堂讲解为准</p>');
    return parts.join('\n');
  }

  async function downloadHandoutPdf() {
    if (!state.handout || !state.handout.handout) throw new Error('还没有讲义');
    const response = await requestAi('prn:local-pdf', {
      baseURL: state.transcriptService,
      html: buildHandoutPrintDocument(state.handout),
    }, 180000);
    if (!response || !response.ok || !response.pdfBase64) {
      throw new Error((response && response.message) || 'PDF 生成失败');
    }
    const binary = atob(response.pdfBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const safe = ('讲义-' + [courseName(), state.label, state.handout.handout.title || ''].filter(Boolean).join('-'))
      .replace(/[\\/:*?"<>|]/g, '_').slice(0, 90);
    const link = document.createElement('a');
    link.href = url;
    link.download = safe + '.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    flashNotice('PDF 已下载 · ' + (response.pages || '?') + ' 页');
  }

  function openHandoutPreview() {
    if (!state.handout || !state.handout.handout) return;
    const existing = document.getElementById('prn-handout-preview');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'prn-handout-preview';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111827;display:flex;flex-direction:column;';
    const bar = document.createElement('div');
    bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 14px;background:#1f2937;color:#e5e7eb;font:13px Arial,"SimHei","Microsoft YaHei",sans-serif;';
    const title = document.createElement('span');
    title.textContent = '讲义预览 · 可直接下载 PDF';
    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const download = document.createElement('button');
    download.type = 'button';
    download.id = 'prn-preview-download';
    download.textContent = '下载 PDF';
    download.style.cssText = 'border:0;border-radius:6px;padding:6px 14px;background:#C0564A;color:#fff;cursor:pointer;font:13px Arial,"SimHei","Microsoft YaHei",sans-serif;';
    const print = document.createElement('button');
    print.type = 'button';
    print.id = 'prn-preview-print';
    print.textContent = '打印';
    print.style.cssText = 'border:1px solid #4b5563;border-radius:6px;padding:6px 12px;background:transparent;color:#e5e7eb;cursor:pointer;font:13px Arial,"SimHei","Microsoft YaHei",sans-serif;';
    const close = document.createElement('button');
    close.type = 'button';
    close.id = 'prn-preview-close';
    close.textContent = '关闭';
    close.style.cssText = 'border:1px solid #4b5563;border-radius:6px;padding:6px 12px;background:transparent;color:#e5e7eb;cursor:pointer;font:13px Arial,"SimHei","Microsoft YaHei",sans-serif;';
    bar.append(title, download, print, close);
    const frame = document.createElement('iframe');
    frame.title = '讲义预览';
    frame.style.cssText = 'flex:1;width:100%;border:0;background:#e9edf2;';
    frame.srcdoc = buildHandoutDocument(state.handout);
    overlay.append(bar, frame);
    document.body.appendChild(overlay);
    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (event) => { if (event.key === 'Escape') cleanup(); };
    close.addEventListener('click', cleanup);
    document.addEventListener('keydown', onKey);
    download.addEventListener('click', () => {
      download.disabled = true;
      download.textContent = '生成中…';
      downloadHandoutPdf()
        .then(() => {
          title.textContent = 'PDF 已下载，可在浏览器下载列表查看';
        })
        .catch((err) => {
          title.textContent = '下载失败：' + ((err && err.message) || '请检查本地服务');
        })
        .finally(() => {
          download.disabled = false;
          download.textContent = '下载 PDF';
        });
    });
    print.addEventListener('click', () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        title.textContent = '在打印对话框里选择「另存为 PDF」';
      } catch (err) {
        title.textContent = '浏览器阻止了打印，请用 Ctrl+P';
      }
    });
  }

  function renderHandoutSheet() {
    const body = nodes.handoutBody;
    const hasHandout = !!(state.handout && state.handout.handout);
    nodes.handoutFoot.hidden = !hasHandout || !!(state.scan && state.scan.running);
    body.textContent = '';
    if (state.scan && state.scan.running) {
      renderScanProgress(body);
      return;
    }
    if (state.lessonBusy) {
      body.appendChild(element('p', 'ai-hint',
        state.lessonProgress || '正在根据字幕和资料生成讲义…'));
      return;
    }
    if (state.handout && state.handout.handout) {
      renderHandoutDone(body, state.handout);
      return;
    }

    const hasCues = state.cues.length > 0;
    const pageCount = state.ppt && Array.isArray(state.ppt.pages) ? state.ppt.pages.length : 0;
    if (!hasCues) {
      body.appendChild(element('p', 'ai-hint',
        '还没有字幕。先导入 SRT/VTT，或把这一节的视频音频转写成字幕，再回来生成讲义。'));
      const open = element('button', 'btn ai-save', '去获取字幕');
      open.id = 'handout-open-transcript';
      open.type = 'button';
      body.appendChild(open);
    } else {
      body.appendChild(element('p', 'ai-hint',
        '已就绪：字幕 ' + state.cues.length + ' 条'
        + (pageCount ? '，资料 ' + pageCount + ' ' + documentUnit(state.ppt.kind) : '（没有导入资料，只按字幕生成）')
        + '。点一下就把两者合成一份带时间点的讲义。'));
      if (state.handoutError) body.appendChild(element('p', 'ai-error', state.handoutError));
      const generate = element('button', 'btn ai-save', '生成讲义');
      generate.id = 'handout-generate';
      generate.type = 'button';
      body.appendChild(generate);
    }

  }

  function pagesForLesson(units, pages, limit) {
    const max = limit || 80;
    if (!pages.length || pages.length <= max) return pages;
    // 多份资料超过上限时，先用转写内容做一次本地相关性筛选，再交给 AI
    const scored = pages.map((page) => {
      const text = (page.title || '') + ' ' + (page.text || '');
      let best = 0;
      for (const unit of units) {
        const score = similarity(text, unit.text);
        if (score > best) best = score;
      }
      return { page: page, score: best };
    });
    const anyMatch = scored.some((item) => item.score > 0.02);
    if (!anyMatch) {
      const step = Math.max(1, Math.ceil(pages.length / max));
      return pages.filter((page, index) => index % step === 0).slice(0, max);
    }
    return scored
      .sort((a, b) => b.score - a.score || a.page.index - b.page.index)
      .slice(0, max)
      .map((item) => item.page)
      .sort((a, b) => a.index - b.index);
  }

  function lessonBodyLength(section) {
    const body = Array.isArray(section && section.body) ? section.body : [section && section.body];
    return body.join('').length;
  }

  function sectionUnitsFor(units, section) {
    const selected = units.filter((unit) =>
      unit.end > Number(section.start) - 30 && unit.start < Number(section.end) + 30);
    if (selected.length) return selected.slice(0, 40);
    return units
      .slice()
      .sort((a, b) => Math.abs(a.start - section.start) - Math.abs(b.start - section.start))
      .slice(0, 2);
  }

  function sectionPagesFor(pages, section) {
    const target = pages.find((page) => page.index === Number(section.page));
    const context = pages.filter((page) => page !== target).slice(0, 6);
    return (target ? [target] : []).concat(context);
  }

  async function generateLesson() {
    if (!state.cues.length) {
      state.handoutError = '还没有字幕，先导入或转写';
      renderHandoutSheet();
      return;
    }
    const sample = await adapter.sample();
    const duration = Number.isFinite(sample.duration) && sample.duration > 0
      ? sample.duration
      : (state.cues[state.cues.length - 1].end || 0);
    if (!duration) {
      state.handoutError = '读不到视频时长，无法生成带时间点的讲义';
      renderHandoutSheet();
      return;
    }
    const units = PRN.srt.windowsFromCues(state.cues, duration, 60);
    if (!units.length) {
      state.handoutError = '字幕内容为空，无法生成讲义';
      renderHandoutSheet();
      return;
    }

    state.lessonBusy = true;
    state.lessonProgress = '正在规划章节…';
    state.handoutError = '';
    renderHandoutSheet();
    const course = courseName();
    const allPages = pagesForLesson(units, state.ppt && Array.isArray(state.ppt.pages) ? state.ppt.pages : [], 80);
    try {
      // 1) 先只要章节骨架
      const outlineResponse = await requestAi('prn:ai-lesson', {
        course: course,
        label: state.label,
        durationText: time.formatTime(duration),
        units: units,
        pages: allPages,
      }, 180000);
      if (!outlineResponse || !outlineResponse.ok) {
        throw new Error((outlineResponse && outlineResponse.message) || '讲义章节生成失败');
      }
      const lesson = outlineResponse.lesson;
      if (!lesson || !Array.isArray(lesson.sections) || !lesson.sections.length) {
        throw new Error('AI 没有生成讲义章节');
      }
      lesson.sections = normalizeChapterBounds(lesson.sections, duration);
      if (!lesson.sections.length) throw new Error('AI 没有生成可用的讲义章节');

      // 2) 逐节重写：每节只拿这一节的转写 + 相关资料页，强制写厚
      let failedSections = 0;
      for (let index = 0; index < lesson.sections.length; index += 1) {
        const section = lesson.sections[index];
        state.lessonProgress = '正在写第 ' + (index + 1) + ' / ' + lesson.sections.length
          + ' 节：' + (section.heading || '');
        renderHandoutSheet();
        try {
          const sectionResponse = await requestAi('prn:ai-lesson-section', {
            course: course,
            label: state.label,
            section: section,
            units: sectionUnitsFor(units, section),
            pages: sectionPagesFor(allPages, section),
          }, 180000);
          if (sectionResponse && sectionResponse.ok && sectionResponse.section) {
            let detail = sectionResponse.section;
            // 太短就再要一次，避免模型又写成一句话
            if (lessonBodyLength(detail) < 250) {
              const retry = await requestAi('prn:ai-lesson-section', {
                course: course,
                label: state.label,
                section: section,
                units: sectionUnitsFor(units, section),
                pages: sectionPagesFor(allPages, section),
              }, 180000).catch(() => null);
              if (retry && retry.ok && retry.section && lessonBodyLength(retry.section) > lessonBodyLength(detail)) {
                detail = retry.section;
              }
            }
            section.intuition = detail.intuition || section.intuition;
            section.body = detail.body && detail.body.length ? detail.body : section.body;
            section.figure = detail.figure || section.figure;
            section.example = detail.example || section.example;
            section.pitfalls = detail.pitfalls && detail.pitfalls.length ? detail.pitfalls : section.pitfalls;
            section.takeaway = detail.takeaway || section.takeaway;
            section.gaps = detail.gaps && detail.gaps.length ? detail.gaps : section.gaps;
          }
        } catch (err) {
          failedSections += 1;
          // 单节失败保留骨架，继续写下一节
        }
      }

      // 3) 单独补目标、术语、自测
      state.lessonProgress = '正在整理术语和自测…';
      renderHandoutSheet();
      let metaDone = false;
      try {
        const metaResponse = await requestAi('prn:ai-lesson-meta', {
          course: course,
          label: state.label,
          sections: lesson.sections,
        }, 120000);
        if (metaResponse && metaResponse.ok && metaResponse.meta) {
          const meta = metaResponse.meta;
          if ((meta.objectives || []).length) lesson.objectives = meta.objectives;
          if (meta.summary) lesson.summary = meta.summary;
          if ((meta.terms || []).length) lesson.terms = meta.terms;
          if ((meta.review || []).length) lesson.review = meta.review;
          if ((meta.gaps || []).length) lesson.gaps = meta.gaps;
          metaDone = true;
        }
      } catch (err) {
        // 术语/自测失败不影响正文
      }
      if (!lesson.objectives || !lesson.objectives.length) {
        lesson.objectives = lesson.sections.slice(0, 4).map((section) => '理解：' + (section.heading || '本节内容'));
      }
      if (failedSections || !metaDone) {
        const warnings = [];
        if (failedSections) warnings.push(failedSections + ' 节扩写失败');
        if (!metaDone) warnings.push('术语/自测未生成');
        lesson.notice = warnings.join('；') + '。可以在讲义里点「重新生成」再试一次。';
      }

      state.handout = {
        generatedAt: Date.now(),
        model: outlineResponse.model,
        segments: [],
        handout: lesson,
      };
      if (state.subId) await PRN.handoutStore.save(state.subId, state.handout);
      renderSegments();
      flashNotice('详细讲义已生成 · ' + lesson.sections.length + ' 节');
    } catch (err) {
      state.handoutError = (err && err.message) || '讲义生成失败';
    } finally {
      state.lessonBusy = false;
      state.lessonProgress = '';
      renderHandoutSheet();
    }
  }

  function openHandoutSheet() {
    nodes.handoutSheet.hidden = false;
    renderHandoutSheet();
    loadHandout().then(renderHandoutSheet).catch(() => {});
  }

  function closeHandoutSheet() {
    nodes.handoutSheet.hidden = true;
  }

  async function copyHandoutMarkdown() {
    if (!state.handout || !state.handout.handout) return;
    const markdown = AI.handoutToMarkdown(state.handout.handout);
    try {
      await navigator.clipboard.writeText(markdown);
      flashNotice('已复制讲义 Markdown');
    } catch (err) {
      flashNotice('复制失败，请手动选择');
    }
  }

  async function startHandoutScan() {
    if (!aiReady()) {
      openAiSheet();
      return;
    }
    const provider = AI.getProvider(state.ai.providerId);
    if (!AI.supportsVision(provider)) {
      state.handoutError = '扫片讲义需要视觉模型（智谱 GLM / 豆包 / 通义 / Kimi）；'
        + 'DeepSeek 这类纯文本模型可以做字幕章节和文字讲义，但不能看画面。';
      renderHandoutSheet();
      flashNotice('当前服务商没有视觉模型，不能扫片');
      return;
    }
    if (!state.ai.includeFrame) {
      flashNotice('先在 AI 设置里打开「允许把当前画面发给 AI」');
      openAiSheet();
      return;
    }
    if (!state.subId) return;

    const sample = await adapter.sample();
    const duration = Number.isFinite(sample.duration) && sample.duration > 0 ? sample.duration : NaN;
    if (!Number.isFinite(duration)) {
      state.handoutError = '读不到总时长，无法扫片';
      renderHandoutSheet();
      return;
    }

    const original = Number.isFinite(sample.seconds) ? sample.seconds : 0;
    const interval = 60;
    const total = Math.min(120, Math.max(1, Math.ceil(duration / interval)));
    state.handoutError = '';
    state.scan = {
      running: true, cancel: false, phase: 'sampling', done: 0, total,
      frames: 0, recognized: 0, percent: 0,
    };
    renderHandoutSheet();

    const frames = [];
    try {
      for (let i = 0; i < total; i += 1) {
        if (state.scan.cancel) break;
        const t = Math.min(Math.max(0, duration - 1), i * interval);
        await adapter.seek(t);
        await adapter.pause();
        await sleep(800);
        const shot = await PRN.capture.capture(adapter.getVideo());
        if (shot.ok && (!frames.length || hammingHex(frames[frames.length - 1].hash, shot.hash) > 2)) {
          frames.push({ t: t, dataUrl: shot.dataUrl, hash: shot.hash });
        }
        state.scan.done = i + 1;
        state.scan.frames = frames.length;
        state.scan.percent = Math.round(((i + 1) / total) * 55);
        renderHandoutSheet();
      }

      try {
        await adapter.seek(original);
        await adapter.pause();
      } catch (err) {
        /* 恢复失败不影响结果 */
      }
      if (state.scan.cancel) {
        state.scan = null;
        renderHandoutSheet();
        return;
      }
      if (!frames.length) throw new Error('没有截到可用画面');

      state.scan.phase = 'recognizing';
      state.scan.percent = 60;
      renderHandoutSheet();
      const slides = [];
      for (let i = 0; i < frames.length; i += 4) {
        if (state.scan.cancel) break;
        const batch = frames.slice(i, i + 4).map((frame) => ({ t: frame.t, dataUrl: frame.dataUrl }));
        const response = await requestAi('prn:ai-slides', { frames: batch }, 150000);
        if (!response || !response.ok) throw new Error((response && response.message) || '画面识别失败');
        slides.push(...(response.slides || []));
        state.scan.recognized = Math.min(frames.length, i + 4);
        state.scan.percent = 60 + Math.round((state.scan.recognized / frames.length) * 30);
        renderHandoutSheet();
      }
      if (state.scan.cancel) {
        state.scan = null;
        renderHandoutSheet();
        return;
      }
      if (!slides.length) throw new Error('AI 没有识别出页面');

      if (!state.ppt) await loadPpt();
      const segments = buildSegments(slides, duration, state.ppt, state.notes);
      state.scan.phase = 'handout';
      state.scan.percent = 94;
      renderHandoutSheet();
      const response = await requestAi('prn:ai-handout', {
        course: courseName(),
        label: state.label,
        durationText: time.formatTime(duration),
        segments: segments,
      }, 150000);
      if (!response || !response.ok) throw new Error((response && response.message) || '讲义生成失败');

      state.handout = {
        generatedAt: Date.now(),
        model: response.model,
        segments: segments,
        handout: response.handout,
      };
      await PRN.handoutStore.save(state.subId, state.handout);
      state.scan = null;
      renderHandoutSheet();
      flashNotice('本节讲义已生成 · ' + segments.length + ' 段');
    } catch (err) {
      state.scan = null;
      state.handoutError = err && err.message ? err.message : '扫片失败';
      renderHandoutSheet();
    }
  }

  // ---- 字幕与章节 --------------------------------------------------------

  function updateCc(seconds) {
    const bar = nodes.ccBar;
    if (!bar) return;
    const cues = state.cues;
    if (!state.ccEnabled || !cues.length || !Number.isFinite(seconds)) {
      bar.style.display = 'none';
      state.currentCueIndex = -1;
      return;
    }
    let low = 0;
    let high = cues.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];
      if (seconds < cue.start) high = mid - 1;
      else if (seconds >= cue.end) low = mid + 1;
      else {
        found = mid;
        break;
      }
    }
    if (found < 0) {
      bar.style.display = 'none';
      state.currentCueIndex = -1;
      return;
    }
    bar.style.display = 'block';
    if (bar.textContent !== cues[found].text) bar.textContent = cues[found].text;
    if (found !== state.currentCueIndex) {
      state.currentCueIndex = found;
      highlightCue(found);
    }
  }

  function highlightCue(index) {
    if (nodes.transcriptSheet.hidden) return;
    for (const node of nodes.transcriptBody.querySelectorAll('.transcript-cue.active')) {
      node.classList.remove('active');
    }
    const active = nodes.transcriptBody.querySelector('.transcript-cue[data-index="' + index + '"]');
    if (active) active.classList.add('active');
  }

  async function loadTranscript() {
    if (!state.subId) {
      state.cues = [];
      state.chapters = [];
      state.transcriptSource = '';
      renderTranscriptSheet();
      return;
    }
    const subId = state.subId;
    try {
      const saved = await PRN.transcriptStore.load(subId);
      if (state.subId !== subId) return;
      state.cues = saved && Array.isArray(saved.cues) ? saved.cues : [];
      state.chapters = saved && Array.isArray(saved.chapters) ? saved.chapters : [];
      state.transcriptSource = (saved && saved.source) || '';
    } catch (err) {
      if (state.subId !== subId) return;
      state.cues = [];
      state.chapters = [];
      state.transcriptSource = '';
    }
    await maybeSimplifyTranscript(subId);
    if (state.subId !== subId) return;
    renderSegments();
    renderTranscriptSheet();
    updateCc(state.current);
  }

  async function saveTranscript() {
    if (!state.subId) return;
    try {
      await PRN.transcriptStore.save(state.subId, {
        cues: state.cues,
        chapters: state.chapters,
        source: state.transcriptSource,
        updatedAt: Date.now(),
      });
    } catch (err) {
      /* 存储失败不阻断 */
    }
  }

  async function importSrtFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const cues = PRN.srt.parseCues(text);
      if (!cues.length) throw new Error('没有解析到字幕，检查文件是不是 SRT/VTT');
      state.cues = cues;
      state.chapters = [];
      state.transcriptSource = file.name;
      state.transcriptError = '';
      await maybeSimplifyTranscript(state.subId);
      await saveTranscript();
      flashNotice('已导入 ' + cues.length + ' 条字幕');
      let seconds = state.current;
      try {
        const sample = await adapter.sample();
        if (Number.isFinite(sample.seconds)) seconds = sample.seconds;
      } catch (err) {
        /* 用上一次时间 */
      }
      updateCc(seconds);
    } catch (err) {
      state.transcriptError = err && err.message ? err.message : '字幕解析失败';
    }
    renderTranscriptSheet();
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + step));
    }
    return btoa(binary);
  }

  async function applyTranscriptResult(data, source) {
    const cues = PRN.srt.parseCues(data.srt);
    if (!cues.length) throw new Error('转写结果没有可用字幕');
    state.cues = cues;
    state.chapters = [];
    state.transcriptSource = source + (data.backend ? ' · ' + data.backend : '');
    state.transcriptError = data.warning || '';
    await maybeSimplifyTranscript(state.subId);
    await saveTranscript();
    flashNotice('转写完成 · ' + cues.length + ' 条字幕');
    let seconds = state.current;
    try {
      const sample = await adapter.sample();
      if (Number.isFinite(sample.seconds)) seconds = sample.seconds;
    } catch (err) {
      /* 用上一次时间 */
    }
    updateCc(seconds);
  }

  async function refreshLocalMedia() {
    state.localMediaError = '';
    try {
      const base = currentServiceURL();
      const response = await requestAi('prn:local-media', { baseURL: base }, 25000);
      if (!response || !response.ok) throw new Error((response && response.message) || '读取服务目录失败');
      state.localMedia = (response.result && response.result.files) || [];
      state.localMediaDir = (response.result && response.result.dir) || '';
      if (!state.localMedia.length) state.localMediaError = '服务目录里没有支持的音视频文件';
    } catch (err) {
      state.localMedia = [];
      state.localMediaDir = '';
      state.localMediaError = (err && err.message) || '读取服务目录失败';
    }
    renderTranscriptSheet();
  }

  async function transcribeLocalName(name) {
    if (!name) return;
    state.transcriptBusy = true;
    state.transcriptError = '';
    state.transcriptProgress = 0;
    state.transcriptElapsed = 0;
    state.transcriptAbort = new AbortController();
    renderTranscriptSheet();
    try {
      const start = await requestAi('prn:local-transcribe-path', {
        baseURL: currentServiceURL(),
        name: name,
        language: state.transcriptLanguage,
      }, 30000);
      if (!start || !start.ok) throw new Error((start && start.message) || '无法启动转写');
      const jobId = start.result && start.result.jobId;
      if (!jobId) throw new Error('服务没有返回任务 id');

      // 后台任务 + 短轮询：大文件转写几十分钟也不会把 MV3 worker 一直挂在一个请求上
      for (;;) {
        if (state.transcriptAbort.signal.aborted) {
          state.transcriptError = '已取消等待；服务端可能还在继续转写';
          return;
        }
        await sleep(2000);
        const status = await requestAi('prn:local-job', {
          baseURL: currentServiceURL(),
          jobId: jobId,
        }, 25000);
        if (!status || !status.ok) throw new Error((status && status.message) || '查询任务失败');
        const job = status.result;
        state.transcriptElapsed = Math.round(Number(job.elapsed) || 0);
        state.transcriptProgress = job.state === 'running' ? 50 : 95;
        renderTranscriptSheet();
        if (job.state === 'error') throw new Error(job.error || '转写失败');
        if (job.state === 'done') {
          const data = job.result;
          if (!data || !data.ok) throw new Error((data && data.error) || '转写结果为空');
          await applyTranscriptResult(data, data.filename || name);
          return;
        }
      }
    } catch (err) {
      state.transcriptError = (err && err.message) || '转写失败';
    } finally {
      state.transcriptBusy = false;
      state.transcriptAbort = null;
      state.transcriptProgress = 0;
      state.transcriptElapsed = 0;
      renderTranscriptSheet();
    }
  }

  async function transcribeSourceUrl() {
    const source = state.videoSource;
    if (!source || !source.url) {
      state.transcriptError = '还没有截获本节视频地址；先刷新一次播放页，或改用「转写本机视频」';
      renderTranscriptSheet();
      return;
    }
    state.transcriptBusy = true;
    state.transcriptError = '';
    state.transcriptProgress = 0;
    state.transcriptElapsed = 0;
    state.transcriptAbort = new AbortController();
    renderTranscriptSheet();
    try {
      const start = await requestAi('prn:local-transcribe-url', {
        baseURL: currentServiceURL(),
        url: source.url,
        referer: source.referer || window.location.href,
        user_agent: navigator.userAgent || '',
        name: source.fileName,
        language: state.transcriptLanguage,
      }, 30000);
      if (!start || !start.ok) throw new Error((start && start.message) || '无法启动一键转写');
      const jobId = start.result && start.result.jobId;
      if (!jobId) throw new Error('服务没有返回任务 id');
      for (;;) {
        if (state.transcriptAbort.signal.aborted) {
          state.transcriptError = '已取消等待；服务端可能还在继续转写';
          return;
        }
        await sleep(2000);
        const status = await requestAi('prn:local-job', {
          baseURL: currentServiceURL(),
          jobId: jobId,
        }, 25000);
        if (!status || !status.ok) throw new Error((status && status.message) || '查询任务失败');
        const job = status.result;
        state.transcriptElapsed = Math.round(Number(job.elapsed) || 0);
        state.transcriptProgress = job.state === 'running' ? 50 : 95;
        state.transcriptStage = job.stage || '';
        renderTranscriptSheet();
        if (job.state === 'error') throw new Error(job.error || '转写失败');
        if (job.state === 'done') {
          const data = job.result;
          if (!data || !data.ok) throw new Error((data && data.error) || '转写结果为空');
          await applyTranscriptResult(data, data.filename || source.fileName);
          return;
        }
      }
    } catch (err) {
      state.transcriptError = (err && err.message) || '一键转写失败；可以改用「转写本机视频」';
    } finally {
      state.transcriptBusy = false;
      state.transcriptAbort = null;
      state.transcriptProgress = 0;
      state.transcriptElapsed = 0;
      state.transcriptStage = '';
      renderTranscriptSheet();
    }
  }

  async function checkTranscriptService() {
    const base = state.transcriptService.replace(/\/+$/, '');
    try {
      const response = await requestAi('prn:local-health', { baseURL: base }, 25000);
      if (!response || !response.ok) throw new Error((response && response.message) || '服务没有返回健康状态');
      const data = response.health || {};
      const backend = data.stub ? 'stub（示例字幕）' : (data.backend || 'none');
      const model = data.model === 'auto' ? (data.auto_model || 'auto') : (data.model || '?');
      const device = data.device && data.device !== 'auto'
        ? data.device
        : (data.cuda ? 'cuda' : 'cpu');
      state.transcriptServiceStatus = backend === 'none'
        ? '服务在，但没有 Whisper 后端；安装 faster-whisper 或先用 --stub'
        : '服务正常 · ' + backend + ' · 模型 ' + model + ' · ' + device;
    } catch (err) {
      state.transcriptServiceStatus = '连接失败：' + ((err && err.message) || '请先启动本地服务');
    }
    renderTranscriptSheet();
  }

  function cueIsMeaningful(text) {
    const clean = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
    if (clean.length < 3) return false;
    if (/^(音乐|掌声|笑声|欢呼|咳嗽|噪音|静音|无声|字幕|谢谢观看|感谢观看|字幕由|本字幕)/.test(clean)) {
      return false;
    }
    return true;
  }

  const TRADITIONAL_HINTS = /[這個們麼謝講學習時對於為說會來後進還這裡樣點現發開關應該讓給與從無數據網頁資訊軟體總結構層級間問題實練習認識緒調節異優勢競爭環]/;

  function hasTraditional(value) {
    return TRADITIONAL_HINTS.test(String(value || ''));
  }

  function transcriptTexts() {
    const cues = state.cues.map((cue) => cue.text);
    const chapterBits = [];
    for (const chapter of state.chapters) {
      chapterBits.push(chapter.title || '', chapter.summary || '');
    }
    return cues.concat(chapterBits);
  }

  async function maybeSimplifyTranscript(subId) {
    const texts = transcriptTexts();
    if (!texts.length || !texts.some(hasTraditional)) return;
    try {
      const response = await requestAi('prn:local-simplify', {
        baseURL: currentServiceURL(),
        texts: texts,
      }, 60000);
      if (!response || !response.ok) return;
      const result = response.result || {};
      if (result.zhconv === false) return;
      const converted = Array.isArray(result.texts) ? result.texts : [];
      if (converted.length !== texts.length) return;
      if (state.subId !== subId) return;
      let cursor = 0;
      state.cues = state.cues.map((cue) => ({ ...cue, text: converted[cursor++] || cue.text }));
      state.chapters = state.chapters.map((chapter) => ({
        ...chapter,
        title: converted[cursor++] || chapter.title,
        summary: converted[cursor++] || chapter.summary,
      }));
      await saveTranscript();
    } catch (err) {
      /* 本地服务不可用时保留原文，不阻塞面板 */
    }
  }

  function speechBounds() {
    const cues = state.cues.filter((cue) => cueIsMeaningful(cue.text));
    if (!cues.length) {
      return { start: 0, end: state.cues.length ? state.cues[state.cues.length - 1].end : 0 };
    }
    return {
      start: Math.max(0, Number(cues[0].start) || 0),
      end: Math.max(0, Number(cues[cues.length - 1].end) || 0),
    };
  }

  function shortSegmentTitle(value) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 16) : '本段';
  }

  function shortSegmentSummary(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 36);
  }

  function pptOutline() {
    const pages = state.ppt && Array.isArray(state.ppt.pages) ? state.ppt.pages : [];
    const items = pages
      .map((page) => ({
        page: page.index,
        title: String(page.title || page.label || '').replace(/^#+\s*/, '').trim(),
        file: page.file || '',
      }))
      .filter((item) => item.title);
    const major = items.filter((item) =>
      /^([一二三四五六七八九十百]+[、.．]|第[一二三四五六七八九十百\d]+[章节部分])/.test(item.title));
    const chosen = major.length >= 2 ? major : items.slice(0, 24);
    return chosen.slice(0, 24);
  }

  function targetSegmentCount(total) {
    const seconds = Number(total) || 0;
    if (seconds >= 5400) return 4; // 1.5 小时以上：4 个主要部分
    if (seconds >= 2700) return 3;
    return 2;
  }

  function compactSegments(segments, target) {
    const list = Array.isArray(segments) ? segments.filter((item) => item && item.end > item.start) : [];
    if (list.length <= target) return list;
    const total = list[list.length - 1].end || 1;
    const result = [];
    const step = list.length / target;
    for (let index = 0; index < target; index += 1) {
      const startIndex = Math.round(index * step);
      const nextIndex = Math.round((index + 1) * step);
      const start = index === 0 ? list[0].start : list[startIndex].start;
      const end = index === target - 1 ? total : list[nextIndex].start;
      if (end <= start) continue;
      result.push({
        start: index === 0 ? list[0].start : list[startIndex].start,
        end: end,
        title: shortSegmentTitle(list[startIndex].title || ('第 ' + (index + 1) + ' 部分')),
        summary: shortSegmentSummary(list[startIndex].summary || ''),
        page: list[startIndex].page || null,
      });
    }
    return result;
  }

  function currentSegments() {
    let list = [];
    let fromChapters = false;
    if (Array.isArray(state.chapters) && state.chapters.length) {
      fromChapters = true;
      list = state.chapters.map((chapter) => ({
        start: chapter.start,
        end: chapter.end,
        title: shortSegmentTitle(chapter.title),
        summary: shortSegmentSummary(chapter.summary),
        page: chapter.page || null,
      }));
    } else {
      const lesson = state.handout && state.handout.handout;
      if (lesson && Array.isArray(lesson.sections) && lesson.sections.length) {
        list = lesson.sections.map((section) => ({
          start: section.start,
          end: section.end,
          title: shortSegmentTitle(section.heading),
          summary: shortSegmentSummary(section.summary || section.intuition
            || (Array.isArray(section.body) ? section.body[0] : '')),
          page: section.page || null,
        }));
      }
    }
    if (!list.length) return [];
    const bounds = speechBounds();
    if (bounds.start > 0 && list[0].start < bounds.start) list[0].start = bounds.start;
    const total = list[list.length - 1].end || 0;
    if (fromChapters) {
      // 新 prompt 已经按资料大标题输出 2–6 段；只有旧数据/异常过多时才压缩
      return list.length > 8 ? compactSegments(list, 5) : list;
    }
    return compactSegments(list, targetSegmentCount(total));
  }

  function seekSegment(start) {
    adapter.seek(start).then(() => adapter.resume()).catch(() => {});
  }

  function renderSegments() {
    state.segments = currentSegments();
    const pageMounted = renderPageChapterCard();
    const rail = nodes.chapterRail;
    rail.textContent = '';
    if (pageMounted || !state.segments.length) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    const total = state.segments[state.segments.length - 1].end || 1;
    const track = element('div', 'cr-track');
    const fill = element('div', 'cr-fill');
    track.appendChild(fill);
    for (const segment of state.segments) {
      const dot = element('button', 'cr-dot');
      dot.type = 'button';
      dot.dataset.start = String(segment.start);
      dot.style.left = ((Math.max(0, segment.start) / total) * 100).toFixed(2) + '%';
      const tip = element('span', 'cr-tip', segment.title || '');
      dot.appendChild(tip);
      dot.addEventListener('click', (event) => {
        event.stopPropagation();
        seekSegment(segment.start);
      });
      track.appendChild(dot);
    }
    track.addEventListener('click', (event) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      seekSegment(total * ratio);
    });
    rail.appendChild(track);
    updateSegmentsUI(state.lastSeconds || 0);
  }

  function updateSegmentsUI(seconds) {
    const segments = state.segments;
    if (!segments.length) return;
    const total = segments[segments.length - 1].end || 1;
    const now = Math.max(0, Math.min(Number(seconds) || 0, total));
    const track = nodes.chapterRail.querySelector('.cr-track');
    if (!track) return;
    const fill = track.querySelector('.cr-fill');
    if (fill) fill.style.width = (now / total * 100).toFixed(1) + '%';
    const dots = track.querySelectorAll('.cr-dot');
    segments.forEach((segment, index) => {
      const dot = dots[index];
      if (!dot) return;
      dot.classList.toggle('active', now >= segment.start && now < segment.end);
    });
  }

  function pageDownloadTarget() {
    const pku = document.getElementById('injectDownloadButton');
    if (pku) return pku;
    const scope = document.querySelector('.course-info__wrapper') || document;
    return Array.from(scope.querySelectorAll('button, a, [role="button"]')).find((element) => {
      if (element.closest('#prn-chapter-card')) return false;
      const text = (element.textContent || '').trim();
      return /下载视频/.test(text) && !/客户端/.test(text);
    }) || null;
  }

  function requestVideoSource() {
    try {
      window.postMessage({ type: 'prn-video-download-info-request' }, '*');
    } catch (error) {
      /* ignore */
    }
  }

  function applyVideoSource(source) {
    if (!source || !source.url) return;
    state.videoSource = {
      url: String(source.url),
      isHls: !!source.isHls,
      fileName: String(source.fileName || '课堂录像'),
      referer: String(source.referer || window.location.href),
    };
    if (!nodes.transcriptSheet.hidden) renderTranscriptSheet();
  }

  function updateDownloadControls() {
    const card = document.getElementById('prn-chapter-card');
    if (!card) return;
    const status = card.querySelector('.prn-ch-status');
    if (status) status.textContent = state.downloadStatus || '';
    const pause = card.querySelector('.prn-ch-pause');
    const cancel = card.querySelector('.prn-ch-cancel');
    const download = card.querySelector('.prn-ch-download');
    if (pause) {
      pause.hidden = !state.downloadBusy;
      pause.textContent = state.downloadPaused ? '继续' : '暂停';
      pause.disabled = !state.downloadBusy;
    }
    if (cancel) {
      cancel.hidden = !state.downloadBusy;
      cancel.disabled = state.downloadCancelling;
    }
    if (download) {
      download.disabled = state.downloadBusy;
      download.textContent = state.downloadBusy ? '下载中…' : '下载视频';
    }
  }

  function setDownloadStatus(text) {
    state.downloadStatus = String(text || '');
    const card = document.getElementById('prn-chapter-card');
    if (!card && state.downloadStatus) flashNotice(state.downloadStatus);
    updateDownloadControls();
  }

  function postDownloadCommand(action) {
    try {
      window.postMessage({ type: 'prn-video-download-' + action }, '*');
    } catch (error) {
      /* ignore */
    }
  }

  function toggleDownloadPause() {
    if (!state.downloadBusy || state.downloadCancelling) return;
    if (state.downloadPaused) {
      setDownloadStatus('正在继续下载…');
      postDownloadCommand('resume');
    } else {
      setDownloadStatus('正在暂停…');
      postDownloadCommand('pause');
    }
  }

  function cancelVideoDownload() {
    if (!state.downloadBusy) return;
    state.downloadCancelling = true;
    setDownloadStatus('正在取消并删除未完成文件…');
    postDownloadCommand('cancel');
  }

  function fallbackPageDownload() {
    const target = pageDownloadTarget();
    if (target) {
      state.downloadAck = true;
      setDownloadStatus('已触发页面下载，请查看浏览器下载列表');
      target.click();
      return true;
    }
    setDownloadStatus('未截获视频地址；请刷新页面后重试，或确认 PKU-Art 下载器已启用');
    return false;
  }

  function requestVideoDownload() {
    if (state.downloadBusy) return;
    state.downloadAck = false;
    state.downloadPaused = false;
    state.downloadCancelling = false;
    setDownloadStatus('正在准备下载…');
    try {
      window.postMessage({ type: 'prn-video-download-request' }, '*');
    } catch (error) {
      /* ignore */
    }
    setTimeout(() => {
      if (!state.downloadAck && !state.downloadBusy) fallbackPageDownload();
    }, 900);
  }

  function onDownloadMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'prn-download-probe') return;
    if (data.type === 'prn-download-ready') {
      state.downloadAck = true;
      if (data.url) applyVideoSource(data);
      return;
    }
    if (data.type === 'prn-video-download-info') {
      applyVideoSource(data.videoSource);
      return;
    }
    if (data.type === 'prn-video-download-started') {
      state.downloadAck = true;
      state.downloadBusy = true;
      state.downloadPaused = false;
      state.downloadCancelling = false;
      setDownloadStatus('开始下载：' + (data.fileName || ''));
      return;
    }
    if (data.type === 'prn-video-download-progress') {
      state.downloadAck = true;
      state.downloadBusy = true;
      if (!state.downloadPaused) {
        const percent = Number.isFinite(Number(data.percent)) ? ' ' + data.percent + '%' : '';
        setDownloadStatus((data.stage || '正在下载…') + percent);
      }
      return;
    }
    if (data.type === 'prn-video-download-paused') {
      state.downloadBusy = true;
      state.downloadPaused = true;
      setDownloadStatus('已暂停；点「继续」恢复，点「取消」会删除未完成文件');
      return;
    }
    if (data.type === 'prn-video-download-resumed') {
      state.downloadBusy = true;
      state.downloadPaused = false;
      setDownloadStatus('继续下载…');
      return;
    }
    if (data.type === 'prn-video-download-cancelling') {
      state.downloadCancelling = true;
      setDownloadStatus('正在取消并删除未完成文件…');
      return;
    }
    if (data.type === 'prn-video-download-cancelled') {
      state.downloadAck = true;
      state.downloadBusy = false;
      state.downloadPaused = false;
      state.downloadCancelling = false;
      setDownloadStatus('已取消，未完成文件已删除');
      flashNotice('已取消下载并清理未完成文件');
      return;
    }
    if (data.type === 'prn-video-download-done') {
      state.downloadAck = true;
      state.downloadBusy = false;
      state.downloadPaused = false;
      state.downloadCancelling = false;
      setDownloadStatus('下载完成：' + (data.fileName || ''));
      flashNotice('视频下载完成');
      return;
    }
    if (data.type === 'prn-video-download-error') {
      state.downloadAck = true;
      state.downloadBusy = false;
      state.downloadPaused = false;
      state.downloadCancelling = false;
      setDownloadStatus('下载失败：' + (data.message || '未知错误'));
      flashNotice('视频下载失败');
      return;
    }
    if (data.type === 'prn-video-download-unavailable') {
      state.downloadAck = true;
      state.downloadBusy = false;
      fallbackPageDownload();
    }
  }

  function hideClientDownloadButtons() {
    const scope = document;
    for (const element of scope.querySelectorAll('button, a, [role="button"]')) {
      if (element.closest('#prn-chapter-card')) continue;
      const text = (element.textContent || '').trim();
      if (/客户端/.test(text) && text.length <= 20) {
        element.style.display = 'none';
      }
    }
  }

  function updatePageCardWidth() {
    const card = document.getElementById('prn-chapter-card');
    if (!card) return;
    const wrapper = document.querySelector('.course-info__wrapper');
    const main = wrapper ? (wrapper.querySelector('.course-info__main') || document.querySelector('.course-info__main')) : null;
    const width = Math.round((main || wrapper || card.parentElement || document.body).getBoundingClientRect().width);
    if (width > 0) {
      card.style.setProperty('--prn-ch-width', Math.max(280, width) + 'px');
    }
  }

  function updatePageSegmentsUI(seconds) {
    const card = document.getElementById('prn-chapter-card');
    if (!card || !state.segments.length) return;
    const segments = state.segments;
    const total = segments[segments.length - 1].end || 1;
    const now = Math.max(0, Math.min(Number(seconds) || 0, total));
    const fill = card.querySelector('.prn-ch-fill');
    if (fill) fill.style.width = (now / total * 100).toFixed(1) + '%';
    const dots = card.querySelectorAll('.prn-ch-dot');
    segments.forEach((segment, index) => {
      const dot = dots[index];
      if (!dot) return;
      dot.classList.toggle('active', now >= segment.start && now < segment.end);
    });
  }

  let pageCardResizeBound = false;

  function renderPageChapterCard() {
    const existing = document.getElementById('prn-chapter-card');
    const wrapper = document.querySelector('.course-info__wrapper');
    if (!wrapper) {
      if (existing) existing.remove();
      document.body.classList.remove('prn-page-chapters', 'prn-hide-pku-download');
      return false;
    }
    const main = wrapper.querySelector('.course-info__main') || document.querySelector('.course-info__main');
    let card = existing;
    if (!card) {
      card = document.createElement('div');
      card.id = 'prn-chapter-card';
      card.className = 'prn-ch-card';
    }
    if (main && main.parentElement) main.insertAdjacentElement('afterend', card);
    else if (card.parentElement !== wrapper) wrapper.appendChild(card);

    card.textContent = '';
    const total = state.segments.length ? (state.segments[state.segments.length - 1].end || 1) : 1;
    const track = document.createElement('div');
    track.className = 'prn-ch-track';
    const fill = document.createElement('div');
    fill.className = 'prn-ch-fill';
    track.appendChild(fill);
    for (const segment of state.segments) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'prn-ch-dot';
      dot.dataset.start = String(segment.start);
      dot.style.left = ((Math.max(0, segment.start) / total) * 100).toFixed(2) + '%';
      const tip = document.createElement('span');
      tip.className = 'prn-ch-tip';
      tip.textContent = segment.title || '';
      dot.appendChild(tip);
      dot.addEventListener('click', (event) => {
        event.stopPropagation();
        seekSegment(segment.start);
      });
      track.appendChild(dot);
    }
    track.addEventListener('click', (event) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      seekSegment(total * ratio);
    });

    const foot = document.createElement('div');
    foot.className = 'prn-ch-foot';
    const status = document.createElement('span');
    status.className = 'prn-ch-status';
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.className = 'prn-ch-pause';
    pause.textContent = '暂停';
    pause.hidden = true;
    pause.addEventListener('click', () => toggleDownloadPause());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'prn-ch-cancel';
    cancel.textContent = '取消';
    cancel.hidden = true;
    cancel.addEventListener('click', () => cancelVideoDownload());
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'prn-ch-download';
    download.textContent = '下载视频';
    download.addEventListener('click', () => {
      requestVideoDownload();
    });
    status.textContent = state.downloadStatus || '';
    foot.append(status, pause, cancel, download);
    if (state.segments.length) card.appendChild(track);
    card.appendChild(foot);
    updateDownloadControls();
    hideClientDownloadButtons();
    if (document.getElementById('injectDownloadButton')) {
      document.body.classList.add('prn-hide-pku-download');
    } else {
      document.body.classList.remove('prn-hide-pku-download');
    }
    updatePageCardWidth();
    if (!pageCardResizeBound) {
      pageCardResizeBound = true;
      window.addEventListener('resize', updatePageCardWidth);
    }
    document.body.classList.add('prn-page-chapters');
    updatePageSegmentsUI(state.lastSeconds || 0);
    setTimeout(() => {
      if (!document.getElementById('prn-chapter-card')) return;
      hideClientDownloadButtons();
      if (document.getElementById('injectDownloadButton')) {
        document.body.classList.add('prn-hide-pku-download');
      }
    }, 1800);
    return true;
  }

  function normalizeChapterBounds(chapters, duration, startAt) {
    const initialStart = Math.max(0, Math.min(Number(startAt) || 0, duration - 1));
    const list = chapters
      .map((chapter) => ({
        ...chapter,
        start: Math.max(0, Math.min(Number(chapter.start) || 0, duration - 1)),
        end: Math.max(0, Math.min(Number(chapter.end) || 0, duration)),
      }))
      .filter((chapter) => chapter.end > chapter.start)
      .sort((a, b) => a.start - b.start);
    if (!list.length) return list;
    let cursor = initialStart;
    for (const chapter of list) {
      // 章节首尾相接，保证整节课都被覆盖；边界取模型给的 end
      chapter.start = cursor;
      chapter.end = Math.min(duration, Math.max(cursor + 30, chapter.end));
      cursor = chapter.end;
    }
    list[0].start = initialStart;
    list[list.length - 1].end = duration;
    return list;
  }

  async function generateChapters() {
    if (!state.cues.length) return;
    const sample = await adapter.sample();
    const duration = Number.isFinite(sample.duration) && sample.duration > 0
      ? sample.duration
      : (state.cues[state.cues.length - 1].end || 0);
    if (!duration) {
      state.transcriptError = '读不到视频时长，无法按时间分章';
      renderTranscriptSheet();
      return;
    }
    const bounds = speechBounds();
    const units = PRN.srt.windowsFromCues(state.cues, duration, 60)
      .filter((unit) => cueIsMeaningful(unit.text));
    const fallbackWindows = PRN.srt.windowsFromCues(state.cues, duration, 1200)
      .filter((window) => cueIsMeaningful(window.text));
    if (!units.length) {
      state.transcriptError = '转写内容为空，无法按知识点分章';
      renderTranscriptSheet();
      return;
    }

    state.transcriptBusy = true;
    state.transcriptError = '';
    renderTranscriptSheet();
    let chapters = null;
    let aiError = '';
    if (aiReady()) {
      try {
        const response = await requestAi('prn:ai-chapters', {
          course: courseName(),
          label: state.label,
          durationText: time.formatTime(duration),
          units: units,
          outline: pptOutline(),
          pages: state.ppt && Array.isArray(state.ppt.pages) ? state.ppt.pages : [],
        }, 180000);
        if (response && response.ok && response.chapters && response.chapters.length) {
          chapters = response.chapters;
        } else {
          aiError = (response && response.message) || 'AI 没有返回章节';
        }
      } catch (err) {
        aiError = (err && err.message) || 'AI 请求失败';
      }
    } else {
      aiError = '还没有配置 AI 服务商 / Key';
    }

    if (!chapters) {
      chapters = fallbackWindows.map((window) => ({
        start: window.start,
        end: window.end,
        title: window.text.slice(0, 14),
        summary: window.text.slice(0, 90),
        page: null,
        gaps: [],
      }));
      state.transcriptError = 'AI 不可用（' + aiError + '），章节先用转写原文生成；在齿轮里配置好模型后可重新生成。';
    }

    chapters = normalizeChapterBounds(chapters, duration, bounds.start);
    if (chapters.length > 8) chapters = compactSegments(chapters, 5);
    const pages = state.ppt && Array.isArray(state.ppt.pages) ? state.ppt.pages : [];
    for (const chapter of chapters) {
      if (!chapter.page && pages.length) {
        const page = matchPage({ title: chapter.title, points: [chapter.summary] }, pages);
        chapter.page = page ? page.index : null;
      }
    }
    state.chapters = chapters;
    state.transcriptBusy = false;
    await saveTranscript();
    renderSegments();
    renderTranscriptSheet();
    flashNotice('已生成 ' + chapters.length + ' 个章节');
  }

  async function simplifyCues() {
    if (!state.cues.length) return;
    state.transcriptBusy = true;
    state.transcriptError = '';
    renderTranscriptSheet();
    try {
      const response = await requestAi('prn:local-simplify', {
        baseURL: currentServiceURL(),
        texts: state.cues.map((cue) => cue.text),
      }, 60000);
      if (!response || !response.ok) throw new Error((response && response.message) || '转换失败');
      const result = response.result || {};
      if (result.zhconv === false) {
        throw new Error('本地服务没有安装 zhconv，先在 whisper_service 里 pip install zhconv');
      }
      const texts = Array.isArray(result.texts) ? result.texts : [];
      state.cues = state.cues.map((cue, index) => ({ ...cue, text: texts[index] || cue.text }));
      await saveTranscript();
      flashNotice('字幕已转为简体');
    } catch (err) {
      state.transcriptError = (err && err.message) || '转简体失败';
    } finally {
      state.transcriptBusy = false;
      renderTranscriptSheet();
      updateCc(state.current);
    }
  }

  function renderChapterTrack(body) {
    const duration = state.duration || (state.chapters.length ? state.chapters[state.chapters.length - 1].end : 0);
    if (!duration) return;
    const track = element('div', 'chapter-track');
    track.id = 'chapter-track';
    for (const chapter of state.chapters) {
      const block = element('button', 'chapter-block');
      block.type = 'button';
      block.dataset.seek = String(chapter.start);
      block.title = time.formatTime(chapter.start) + ' · ' + (chapter.title || '');
      const width = Math.max(1, ((chapter.end - chapter.start) / duration) * 100);
      block.style.flex = '0 0 ' + width.toFixed(3) + '%';
      if (chapter.page) block.dataset.page = String(chapter.page);
      track.appendChild(block);
    }
    body.appendChild(track);
  }

  function renderTranscriptSheet() {
    const body = nodes.transcriptBody;
    body.textContent = '';
    const hasCues = state.cues.length > 0;

    if (hasCues) {
      const meta = element('div', 'transcript-meta');
      meta.appendChild(element('span', null,
        state.cues.length + ' 条字幕' + (state.transcriptSource ? ' · ' + state.transcriptSource : '')));
      const ccToggle = element('button', 'link-btn', state.ccEnabled ? '关闭字幕' : '打开字幕');
      ccToggle.id = 'transcript-cc';
      ccToggle.type = 'button';
      meta.appendChild(ccToggle);
      body.appendChild(meta);
    }

    if (state.transcriptBusy) {
      const stage = state.transcriptStage ? state.transcriptStage + ' · ' : '';
      const label = state.transcriptElapsed > 0
        ? stage + '已等 ' + state.transcriptElapsed + ' 秒（后台任务，可以离开这个浮层）'
        : (state.transcriptStage || (state.transcriptProgress > 0
          ? '正在上传 ' + state.transcriptProgress + '%…'
          : '正在转写…本地 Whisper 可能需要几分钟，页面可以继续放着。'));
      body.appendChild(element('p', 'ai-hint', label));
      const cancel = element('button', 'link-btn', '取消');
      cancel.id = 'transcript-cancel';
      cancel.type = 'button';
      body.appendChild(cancel);
    }
    if (state.transcriptError) body.appendChild(element('p', 'ai-error', state.transcriptError));

    const actions = element('div', 'transcript-actions');
    const importSrt = element('button', 'ghost ai-test', '导入字幕');
    importSrt.id = 'transcript-import';
    importSrt.type = 'button';
    importSrt.disabled = state.transcriptBusy;
    const sourceTranscribe = element('button', 'btn ai-save', '一键转写本节');
    sourceTranscribe.id = 'transcript-source';
    sourceTranscribe.type = 'button';
    sourceTranscribe.disabled = state.transcriptBusy || !state.videoSource;
    sourceTranscribe.title = state.videoSource
      ? '只从页面截获的视频地址取音频，不用先下载整段视频'
      : '还没有截获视频地址；先刷新播放页';
    const local = element('button', 'ghost ai-test', '转写本机视频');
    local.id = 'transcript-local';
    local.type = 'button';
    local.disabled = state.transcriptBusy;
    actions.append(sourceTranscribe, importSrt, local);
    body.appendChild(actions);
    if (!state.videoSource) {
      body.appendChild(element('p', 'ai-hint', '「一键转写本节」需要先刷新一次播放页，让下载器截获视频地址。'));
    }

    if (state.localMediaError) body.appendChild(element('p', 'ai-error', state.localMediaError));
    if (state.localMedia.length) {
      const select = document.createElement('select');
      select.id = 'transcript-local-select';
      select.className = 'transcript-service';
      for (const file of state.localMedia) {
        const option = document.createElement('option');
        option.value = file.name;
        option.textContent = file.name + ' · ' + (file.size / 1024 / 1024).toFixed(0) + 'MB';
        select.appendChild(option);
      }
      const run = element('button', 'btn ai-save', '转写选中的视频');
      run.id = 'transcript-local-transcribe';
      run.type = 'button';
      run.disabled = state.transcriptBusy;
      body.append(select, run);
    }

    if (hasCues) {
      const lesson = element('button', 'btn ai-save', '生成讲义（字幕 + 资料）');
      lesson.id = 'transcript-lesson';
      lesson.type = 'button';
      body.appendChild(lesson);
      const segments = element('button', 'ghost ai-test', '智能分段（按 PPT 结构）');
      segments.id = 'transcript-chapters';
      segments.type = 'button';
      segments.disabled = state.transcriptBusy;
      body.appendChild(segments);
      body.appendChild(element('p', 'ai-hint',
        '按上传资料的大标题切分：有几个大标题就几个打点；忽略开场静音，第一个点落在老师开始讲第一段的位置。'));
    } else {
      body.appendChild(element('p', 'ai-hint',
        '还没有字幕。导入现成的 SRT/VTT，或把这一节的视频/音频转写；拿到字幕后就能生成讲义。'));
    }

    if (hasCues) {
      const transcriptDetails = document.createElement('details');
      transcriptDetails.className = 'advanced';
      const summary = document.createElement('summary');
      summary.textContent = '查看字幕全文';
      transcriptDetails.appendChild(summary);
      const list = element('ol', 'transcript-list');
      const max = Math.min(state.cues.length, 800);
      for (let index = 0; index < max; index += 1) {
        const cue = state.cues[index];
        const item = element('li', 'transcript-cue');
        item.dataset.index = String(index);
        item.dataset.seek = String(cue.start);
        const timeNode = element('button', 'cue-time', time.formatTime(cue.start));
        timeNode.type = 'button';
        item.append(timeNode, element('span', 'cue-text', cue.text));
        if (index === state.currentCueIndex) item.classList.add('active');
        list.appendChild(item);
      }
      transcriptDetails.appendChild(list);
      if (state.cues.length > max) {
        transcriptDetails.appendChild(element('p', 'ai-hint',
          '只显示前 ' + max + ' 条（共 ' + state.cues.length + ' 条）。'));
      }
      body.appendChild(transcriptDetails);
    }

    const advanced = document.createElement('details');
    advanced.className = 'advanced';
    const advSummary = document.createElement('summary');
    advSummary.textContent = '高级：本地服务 / 本机文件';
    advanced.appendChild(advSummary);

    const serviceRow = element('div', 'transcript-row');
    const serviceInput = document.createElement('input');
    serviceInput.type = 'text';
    serviceInput.id = 'transcript-service';
    serviceInput.className = 'transcript-service';
    serviceInput.value = state.transcriptService;
    serviceInput.placeholder = 'http://127.0.0.1:8765';
    const check = element('button', 'ghost ai-test', '检查服务');
    check.id = 'transcript-check';
    check.type = 'button';
    serviceRow.append(serviceInput, check);
    advanced.appendChild(serviceRow);
    if (state.transcriptServiceStatus) {
      advanced.appendChild(element('p', 'ai-hint', state.transcriptServiceStatus));
    }

    const mediaBtn = element('button', 'ghost ai-test', '列出页面媒体地址');
    mediaBtn.id = 'transcript-media-list';
    mediaBtn.type = 'button';
    advanced.appendChild(mediaBtn);
    if (state.mediaUrls.length) {
      const mediaList = element('ul', 'media-list');
      for (const url of state.mediaUrls) {
        const item = element('li', 'media-item');
        const code = element('code', 'media-url', url.length > 96 ? url.slice(0, 96) + '…' : url);
        code.title = url;
        const copy = element('button', 'link-btn', '复制');
        copy.type = 'button';
        copy.dataset.copy = url;
        item.append(code, copy);
        mediaList.appendChild(item);
      }
      advanced.appendChild(mediaList);
    }
    body.appendChild(advanced);
  }

  function openTranscriptSheet() {
    nodes.transcriptSheet.hidden = false;
    requestVideoSource();
    renderTranscriptSheet();
    loadTranscript().then(renderTranscriptSheet).catch(() => {});
  }

  function closeTranscriptSheet() {
    nodes.transcriptSheet.hidden = true;
  }

  // ---- 数据 --------------------------------------------------------------

  function mergeRecord(record) {
    if (!record) return;
    if (record.label) state.label = record.label;
    if (!state.courseId && record.hqyCourseId) state.courseId = record.hqyCourseId;
  }

  async function refresh() {
    let root;
    try {
      root = await storage.read();
    } catch (err) {
      console.warn('[PRN:panel] 读取本地存储失败');
      return;
    }
    mergeRecord(state.subId ? root.records[state.subId] : null);
    state.notes = storage.notesOf(root, state.subId);
    renderTitle();
    renderNotes(state.notes);
    renderDebug(true);
  }

  function onStorageChange(root) {
    if (!root) return;
    mergeRecord(state.subId ? root.records[state.subId] : null);
    state.notes = storage.notesOf(root, state.subId);
    renderTitle();
    renderNotes(state.notes);
    renderDebug(false);
  }

  // ---- 播放进度回写 ------------------------------------------------------

  let lastSaveAt = 0;
  let lastSavedTime = null;

  function currentTarget() {
    return { subId: state.subId, courseId: state.courseId, label: state.label };
  }

  async function persistPlayhead(target, current, duration, force) {
    if (state.scan && state.scan.running) return; // 扫片会来回 seek，别把进度写乱
    if (!target || !target.subId || !Number.isFinite(current)) return;
    const now = Date.now();
    if (!force) {
      if (now - lastSaveAt < SAVE_INTERVAL_MS) return;
      if (lastSavedTime != null && Math.abs(current - lastSavedTime) < 1) return;
    }
    lastSaveAt = now;
    lastSavedTime = current;
    try {
      await storage.writePlayhead(target.subId, {
        lastTime: Math.round(current * 10) / 10,
        duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : null,
        hqyCourseId: target.courseId,
        label: target.label,
      });
    } catch (err) {
      console.warn('[PRN:panel] 写入播放进度失败');
    }
  }

  /** 页面隐藏 / 卸载时补一次；先抓住当前 subId，避免异步期间切了节写到错的地方。 */
  function flushPlayhead() {
    const target = currentTarget();
    if (!target.subId) return;
    adapter.sample().then((sample) => {
      if (Number.isFinite(sample.seconds)) {
        return persistPlayhead(target, sample.seconds, sample.duration, true);
      }
      return null;
    }).catch(() => {});
  }

  // ---- 轮询 --------------------------------------------------------------

  let ticking = false;
  let lastReprobeAt = 0;

  async function tick() {
    if (ticking || !host.isConnected) return;
    ticking = true;
    try {
      const sample = await adapter.sample();
      renderClock(sample.seconds, sample.duration);
      state.lastSeconds = sample.seconds;
      updateCc(sample.seconds);
      updateSegmentsUI(sample.seconds);
      updatePageSegmentsUI(sample.seconds);
      renderDebug(false);
      persistPlayhead(currentTarget(), sample.seconds, sample.duration, false).catch(() => {});

      if (adapter.level !== state.level) applyLevel(adapter.level);

      if (adapter.level === 'none') {
        const now = Date.now();
        if (now - lastReprobeAt > REPROBE_INTERVAL_MS) {
          lastReprobeAt = now;
          const level = await adapter.probe();
          if (level !== state.level) applyLevel(level);
        }
      }
    } catch (err) {
      /* 一次读取失败不应该让面板停摆 */
    } finally {
      ticking = false;
    }
  }

  let timer = null;
  function startTicking() {
    if (timer) return;
    tick().catch(() => {});
    timer = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
  }

  // ---- 打点 --------------------------------------------------------------

  async function openComposer() {
    if (!state.subId) {
      flashNotice('没有识别到本节 sub_id，暂时不能打点。');
      return;
    }
    if (!nodes.composer.hidden) {
      nodes.noteInput.focus();
      return;
    }
    await adapter.pause(); // 打点时先暂停，位置才稳定
    const sample = await adapter.sample();
    state.composerTime = Number.isFinite(sample.seconds) ? sample.seconds : null;
    text(nodes.composerTime, state.composerTime == null
      ? '当前位置读不到 · 只记文字'
      : '在 ' + time.formatTime(state.composerTime) + ' 打点');
    nodes.composer.hidden = false;
    text(nodes.composerHint, 'Enter 保存 · Esc 取消');
    nodes.noteInput.value = '';
    nodes.noteInput.focus();
  }

  function closeComposer() {
    nodes.composer.hidden = true;
    nodes.noteInput.value = '';
  }

  async function submitComposer() {
    const value = nodes.noteInput.value.trim();
    if (!value) {
      text(nodes.composerHint, '写点什么再保存');
      nodes.noteInput.focus();
      return;
    }
    if (!state.subId) return;
    try {
      await storage.addNote({ subId: state.subId, t: state.composerTime, text: value });
    } catch (err) {
      text(nodes.composerHint, '保存失败，稍后再试');
      return;
    }
    closeComposer();
    lastSaveAt = 0; // 允许立刻回写一次当前位置
    await refresh();
  }

  // ---- 事件 --------------------------------------------------------------

  nodes.mark.addEventListener('click', () => {
    openComposer().catch(() => {});
  });
  nodes.cancel.addEventListener('click', closeComposer);
  nodes.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submitComposer().catch(() => {});
  });

  nodes.notes.addEventListener('click', async (event) => {
    const item = event.target.closest ? event.target.closest('.note') : null;
    if (!item) return;
    const note = state.notes.find((entry) => entry.id === item.dataset.id);
    if (!note) return;

    if (event.target.closest('[data-ai]')) {
      await explainNote(note);
      return;
    }
    if (event.target.closest('.del')) {
      await storage.deleteNote(note.id);
      await refresh();
      return;
    }
    if (event.target.closest('.ts') && note.t != null) {
      const result = await adapter.seek(note.t);
      if (!result.ok) flashNotice('跳转失败（播放器没有响应 seek）');
      await adapter.resume(); // 文档要求：跳到该位置并继续播放
      renderDebug(true);
    }
  });

  nodes.aiGear.addEventListener('click', () => {
    openAiSheet();
  });
  nodes.aiClose.addEventListener('click', closeAiSheet);
  nodes.aiSheet.addEventListener('click', (event) => {
    if (event.target === nodes.aiSheet) closeAiSheet();
  });
  nodes.aiProvider.addEventListener('change', () => {
    const provider = activeProvider();
    state.aiModels = [];
    nodes.aiBaseURL.value = provider.baseURL || '';
    fillAiModelOptions(provider, '');
    text(nodes.aiTestResult, '');
    nodes.aiTestResult.dataset.tone = '';
    text(nodes.aiModelStatus, '');
    nodes.aiModelStatus.dataset.tone = '';
  });
  nodes.aiFetchModels.addEventListener('click', () => {
    fetchAiModels().catch(() => {});
  });
  nodes.aiModelChips.addEventListener('click', (event) => {
    const chip = event.target.closest ? event.target.closest('[data-model]') : null;
    if (!chip) return;
    nodes.aiModel.value = chip.dataset.model;
    renderModelChips(chip.dataset.model);
    text(nodes.aiModelStatus, '已选择 ' + chip.dataset.model + '；点「测试连接」验证，或直接保存。');
    nodes.aiModelStatus.dataset.tone = '';
  });
  nodes.aiCleanup.addEventListener('click', () => {
    cleanupOldExtensions().catch(() => {});
  });
  nodes.aiPanelReset.addEventListener('click', () => {
    resetPanelLayout();
    flashNotice('面板位置和大小已重置');
  });
  nodes.aiTest.addEventListener('click', () => {
    testAiConnection().catch(() => {});
  });
  nodes.aiSave.addEventListener('click', () => {
    saveAiSettings().catch(() => {});
  });


  nodes.pptBtn.addEventListener('click', openPptSheet);
  nodes.pptClose.addEventListener('click', closePptSheet);
  nodes.pptSheet.addEventListener('click', (event) => {
    if (event.target === nodes.pptSheet) closePptSheet();
  });
  nodes.pptFileBtn.addEventListener('click', () => nodes.pptInput.click());
  nodes.pptCard = pptCard;
  ['dragenter', 'dragover'].forEach((type) => {
    pptCard.addEventListener(type, (event) => {
      event.preventDefault();
      pptCard.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    pptCard.addEventListener(type, (event) => {
      event.preventDefault();
      pptCard.classList.remove('dragging');
    });
  });
  pptCard.addEventListener('drop', (event) => {
    const files = event.dataTransfer && event.dataTransfer.files
      ? Array.from(event.dataTransfer.files) : [];
    importPptFiles(files).catch(() => {});
  });
  nodes.pptInput.addEventListener('change', () => {
    const files = nodes.pptInput.files ? Array.from(nodes.pptInput.files) : [];
    nodes.pptInput.value = '';
    importPptFiles(files).catch(() => {});
  });
  nodes.pptList.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-material]');
    if (!remove) return;
    const index = Number(remove.dataset.removeMaterial);
    if (Number.isFinite(index)) removeMaterial(index).catch(() => {});
  });
  nodes.pptClear.addEventListener('click', () => {
    clearPpt().catch(() => {});
  });

  nodes.handoutBtn.addEventListener('click', openHandoutSheet);
  nodes.handoutClose.addEventListener('click', closeHandoutSheet);
  nodes.handoutPreviewFoot.addEventListener('click', () => openHandoutPreview());
  nodes.handoutDownloadFoot.addEventListener('click', () => {
    downloadHandoutPdf().catch((err) => {
      state.handoutError = (err && err.message) || 'PDF 下载失败';
      renderHandoutSheet();
    });
  });
  nodes.handoutSheet.addEventListener('click', (event) => {
    if (event.target === nodes.handoutSheet) closeHandoutSheet();
  });
  nodes.handoutBody.addEventListener('click', (event) => {
    if (event.target.closest('#handout-start')) {
      startHandoutScan().catch(() => {});
      return;
    }
    if (event.target.closest('#handout-generate')) {
      generateLesson().catch(() => {});
      return;
    }
    if (event.target.closest('#handout-open-transcript')) {
      closeHandoutSheet();
      openTranscriptSheet();
      return;
    }
    if (event.target.closest('#handout-cancel')) {
      if (state.scan) state.scan.cancel = true;
      return;
    }
    if (event.target.closest('#handout-copy')) {
      copyHandoutMarkdown().catch(() => {});
      return;
    }
    if (event.target.closest('#handout-rescan')) {
      if (state.cues.length) {
        generateLesson().catch(() => {});
      } else {
        state.handout = null;
        state.handoutError = '';
        renderHandoutSheet();
      }
      return;
    }
    const seek = event.target.closest('[data-seek]');
    if (seek) {
      const seconds = Number(seek.dataset.seek);
      if (Number.isFinite(seconds)) {
        adapter.seek(seconds).then(() => adapter.resume()).catch(() => {});
      }
    }
  });

  function currentServiceURL() {
    const input = nodes.transcriptBody.querySelector('#transcript-service');
    if (input && input.value.trim()) state.transcriptService = input.value.trim();
    PRN.transcriptStore.saveConfig({ serviceURL: state.transcriptService, language: state.transcriptLanguage })
      .catch(() => {});
    return state.transcriptService;
  }

  nodes.ccBtn.addEventListener('click', openTranscriptSheet);
  nodes.transcriptClose.addEventListener('click', closeTranscriptSheet);
  nodes.transcriptSheet.addEventListener('click', (event) => {
    if (event.target === nodes.transcriptSheet) closeTranscriptSheet();
  });
  nodes.srtInput.addEventListener('change', () => {
    const file = nodes.srtInput.files && nodes.srtInput.files[0];
    nodes.srtInput.value = '';
    importSrtFile(file).catch(() => {});
  });
  nodes.transcriptBody.addEventListener('click', (event) => {
    if (event.target.closest('#transcript-check')) {
      currentServiceURL();
      checkTranscriptService().catch(() => {});
      return;
    }
    if (event.target.closest('#transcript-source')) {
      transcribeSourceUrl().catch(() => {});
      return;
    }
    if (event.target.closest('#transcript-import')) {
      nodes.srtInput.click();
      return;
    }
    if (event.target.closest('#transcript-local')) {
      currentServiceURL();
      refreshLocalMedia().catch(() => {});
      return;
    }
    if (event.target.closest('#transcript-cancel')) {
      if (state.transcriptAbort) state.transcriptAbort.abort();
      return;
    }
    if (event.target.closest('#transcript-lesson')) {
      closeTranscriptSheet();
      openHandoutSheet();
      generateLesson().catch(() => {});
      return;
    }
    if (event.target.closest('#transcript-chapters')) {
      generateChapters().catch(() => {});
      return;
    }
    const copyUrl = event.target.closest('[data-copy]');
    if (copyUrl) {
      navigator.clipboard.writeText(copyUrl.dataset.copy)
        .then(() => flashNotice('媒体地址已复制'))
        .catch(() => flashNotice('复制失败'));
      return;
    }
    if (event.target.closest('#transcript-media-list')) {
      adapter.media().then((urls) => {
        state.mediaUrls = Array.isArray(urls) ? urls : [];
        state.mediaUrlsScanned = true;
        renderTranscriptSheet();
      }).catch(() => {
        state.mediaUrls = [];
        state.mediaUrlsScanned = true;
        renderTranscriptSheet();
      });
      return;
    }
    if (event.target.closest('#transcript-local-transcribe')) {
      const select = nodes.transcriptBody.querySelector('#transcript-local-select');
      transcribeLocalName(select ? select.value : '').catch(() => {});
      return;
    }
    if (event.target.closest('#transcript-cc')) {
      state.ccEnabled = !state.ccEnabled;
      renderTranscriptSheet();
      updateCc(state.current);
      return;
    }
    if (event.target.closest('#transcript-simplify')) {
      // 旧版的「转简体」按钮已移除；服务端默认输出简体
      return;
    }
    if (event.target.closest('#transcript-ai-settings')) {
      closeTranscriptSheet();
      openAiSheet();
      return;
    }
    const seek = event.target.closest('[data-seek]');
    if (seek) {
      const seconds = Number(seek.dataset.seek);
      if (Number.isFinite(seconds)) {
        adapter.seek(seconds).then(() => adapter.resume()).catch(() => {});
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!nodes.transcriptSheet.hidden) {
        event.preventDefault();
        closeTranscriptSheet();
        return;
      }
      if (!nodes.handoutSheet.hidden) {
        event.preventDefault();
        closeHandoutSheet();
        return;
      }
      if (!nodes.pptSheet.hidden) {
        event.preventDefault();
        closePptSheet();
        return;
      }
      if (!nodes.aiSheet.hidden) {
        event.preventDefault();
        closeAiSheet();
        return;
      }
      if (!nodes.composer.hidden) {
        event.preventDefault();
        closeComposer();
      }
      return;
    }
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (String(event.key).toLowerCase() !== 'b') return;
    event.preventDefault();
    if (nodes.composer.hidden) openComposer().catch(() => {});
    else nodes.noteInput.focus();
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushPlayhead();
  });
  window.addEventListener('pagehide', flushPlayhead);

  // ---- 页面生命周期 ------------------------------------------------------

  async function onLocationChange() {
    const next = readIds();
    if (next.subId === state.subId && next.courseId === state.courseId) return;

    flushPlayhead(); // 先抓旧节的播放位置，再切
    state.subId = next.subId;
    state.courseId = next.courseId;
    state.label = '';
    state.notesSignature = '';
    state.notes = [];
    state.cues = [];
    state.chapters = [];
    state.transcriptSource = '';
    state.transcriptError = '';
    state.transcriptBusy = false;
    state.transcriptElapsed = 0;
    state.handout = null;
    state.segments = [];
    state.materials = [];
    state.ppt = null;
    rebuildPpt();
    renderPpt();
    renderTranscriptSheet();
    if (!nodes.handoutSheet.hidden) renderHandoutSheet();
    updateCc(0);
    state.downloadStatus = '';
    state.downloadBusy = false;
    state.downloadAck = false;
    state.downloadPaused = false;
    state.downloadCancelling = false;
    state.videoSource = null;
    window.postMessage({ type: 'prn-video-download-reset', href: window.location.href }, '*');
    setTimeout(requestVideoSource, 700);
    nodes.mark.disabled = !state.subId;

    const level = await adapter.probe();
    applyLevel(level);
    renderTitle();
    renderNotes([]);
    renderSegments();
    await refresh();
    loadPpt();
    loadHandout();
    loadTranscript();
    setTimeout(() => {
      hideClientDownloadButtons();
      renderSegments();
    }, 700);
  }

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    onLocationChange().catch(() => {});
  }, 1000);

  window.addEventListener('popstate', () => {
    onLocationChange().catch(() => {});
  });
  window.addEventListener('hashchange', () => {
    onLocationChange().catch(() => {});
  });

  // ---- 启动 --------------------------------------------------------------

  function boot() {
    installPageLayout();
    const ids = readIds();
    state.subId = ids.subId;
    state.courseId = ids.courseId;

    applyPanelRect(defaultPanelRect(), { silent: true });
    const parent = document.body || document.documentElement;
    parent.appendChild(host);
    installPanelChrome();
    loadPanelLayout();
    window.addEventListener('message', onDownloadMessage);
    setTimeout(requestVideoSource, 800);

    nodes.mark.disabled = !state.subId;
    renderTitle();
    renderNotes([]);
    renderDebug(true);
    refreshNotice();
    refresh();

    storage.subscribe(onStorageChange);
    loadAi();
    checkDuplicates(true);
    loadPpt();
    loadHandout();
    loadTranscript();
    setTimeout(() => renderSegments(), 1200);
    setTimeout(() => hideClientDownloadButtons(), 900);
    setTimeout(() => hideClientDownloadButtons(), 2800);
    PRN.transcriptStore.loadConfig().then((config) => {
      if (config) {
        state.transcriptService = config.serviceURL || state.transcriptService;
        state.transcriptLanguage = config.language || state.transcriptLanguage;
      }
    }).catch(() => {});

    adapter.waitReady(READY_TIMEOUT_MS).then((level) => {
      applyLevel(level);
      startTicking();
      refresh();
    }).catch(() => {
      applyLevel('none');
      startTicking();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
