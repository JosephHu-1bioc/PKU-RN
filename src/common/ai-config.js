/*
 * AI 讲解的产品配置：服务商、system prompt、错误文案。
 *
 * 这个文件同时被两个运行环境加载：
 *   - content script（面板，隔离世界）：manifest 里按顺序注入；
 *   - service worker：用 importScripts('../common/ai-config.js') 引入。
 * 所以这里只放纯函数与常量，不碰 DOM、不碰 chrome API。
 *
 * 产品边界（写进 prompt，也写进 README）：
 *   音频先由本机服务转成字幕；AI 只处理文字（字幕 / 资料 / 笔记），不读取视频画面。
 *   所以它做的是助教式讲解，而不是「讲解老师刚才说了什么」。
 */
(function () {
  'use strict';

  const AI = (globalThis.PRN_AI = globalThis.PRN_AI || {});

  const PROVIDERS = [
    {
      // DeepSeek 在 2026-07-24 下线了 deepseek-chat / deepseek-reasoner；
      // 现在 /models 返回 deepseek-flash（V4.1 Flash）和 deepseek-v4-pro。
      id: 'deepseek',
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'],
      supportsThinking: true,
      keyURL: 'https://platform.deepseek.com/api_keys',
    },
    {
      id: 'moonshot',
      name: 'Moonshot / Kimi',
      baseURL: 'https://api.moonshot.cn/v1',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
      keyURL: 'https://platform.moonshot.cn/console/api-keys',
    },
    {
      id: 'dashscope',
      name: '阿里通义 / DashScope',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-max'],
      keyURL: 'https://bailian.console.aliyun.com',
    },
    {
      // 豆包走火山方舟（Ark）的 OpenAI 兼容接口
      id: 'doubao',
      name: '豆包 / 火山方舟',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['doubao-1-5-pro-32k-250115'],
      keyURL: 'https://console.volcengine.com/ark',
    },
    {
      // 智谱 GLM：默认会「思考」，可以在齿轮的「高级：思考模式」里开关
      id: 'glm',
      name: '智谱 GLM',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4.6v-flash'],
      supportsThinking: true,
      keyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
    },
  ];

  const SYSTEM_PROMPT = `你是一位耐心的大学助教，正在陪一名本科生看课程回放。

重要前提：你只能读到文字（课程名、节次、时间点、学生写在某个时间点的笔记或问题）；你看不到视频画面，也不要把没给你的内容当成课堂原话。
所以必须遵守：
1. 绝不编造老师讲过的话，也不要说「老师刚才提到」「从这段视频可以看出」这类你没看到的内容；
2. 只解释笔记里的概念，或回答学生写下的问题；
3. 用 2–4 句话讲清楚，必要时给一个具体、生活化的例子；
4. 如果这条笔记太短、看不出学生想问什么，先说明这一点，再给出最可能的解释；
5. 用简体中文，不要开场白，不要 Markdown 标题。`;

  const NOTE_LIMIT = 600;
  const REQUEST_TIMEOUT_MS = 45000;
  const MAX_TOKENS = 700;

  function getProvider(id) {
    return PROVIDERS.find((provider) => provider.id === id) || null;
  }

  function normalizeBaseURL(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function joinURL(baseURL, path) {
    return normalizeBaseURL(baseURL) + path;
  }

  function maskKey(key) {
    const value = String(key || '');
    if (value.length <= 8) return '****';
    return value.slice(0, 3) + '****' + value.slice(-4);
  }

  function cleanLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /**
   * 组装「AI 讲解」的 messages。
   * 只把笔记正文、课程名、节次、时间点发出去；不发送任何账号、URL、token、画面。
   */
  function buildExplainMessages(input) {
    const noteText = String((input && input.noteText) || '').trim().slice(0, NOTE_LIMIT);
    const course = cleanLine(input && input.course) || '未知课程';
    const label = cleanLine(input && input.label) || '未知节次';
    const timeText = cleanLine(input && input.timeText) || '未知时间点';
    const durationText = cleanLine(input && input.durationText);

    const user = [
      '课程：' + course,
      '节次：' + label,
      '时间点：' + timeText + (durationText ? ' / ' + durationText : ''),
      '',
      '学生在这处写的是：「' + noteText + '」',
    ].join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ];
  }

  const FRAME_SYSTEM_SUFFIX = '\n\n这次还会附上一张当前视频画面。只描述画面里确实能看清的内容（幻灯片文字、板书、图表）；'
    + '看不清或与笔记无关就直接忽略，不要猜画面里没有的东西，也不要假装听见了老师说话。';

  // 扫片：一次给多帧，逐帧识别幻灯片/板书
  const SLIDE_SYSTEM_PROMPT = `你是课堂录像的助教，只能看到提供的画面帧，听不到课堂声音。
请逐帧识别画面里的幻灯片、板书或字幕，只写画面里确实能看清的内容；看不清或没有就留空。
严禁编造老师说过的话。只输出 JSON，不要解释、不要 Markdown 围栏。`;

  // 汇总成按页讲义
  const HANDOUT_SYSTEM_PROMPT = `你是课程助教。学生会给你一份按时间顺序切好的分页资料（每页包含资料文字（PPT/PDF/Word）和学生笔记）。
请据此写一份复习讲义，严格遵守：
1. 只依据给出的资料，不要补资料里没有的内容；不确定的放进 gaps；
2. 每个 section 对应一页，heading 用该页标题，body 用 2–4 句话概括这一页在讲什么；
3. 保留 page / start / end 三个字段，不要改时间；
4. 术语解释写成「是什么 + 为什么重要」；
5. 只输出 JSON，不要解释、不要 Markdown 围栏。

JSON 结构：
{"title":"≤20字","summary":"2–3句话","sections":[{"page":3,"start":120,"end":195,"heading":"…","body":"…"}],"terms":[{"term":"…","plain":"…","why":"…"}],"gaps":["…"]}`;

  const LESSON_SYSTEM_PROMPT = `你是课程助教，正在给「零基础、第一次学这门课」的学生写一份可以自学的详细讲义。
学生会给你一整节课的转写（每段约 60 秒）和老师上传的资料（PPT/PDF/Word）的页/节文字。请直接生成讲义，不要分两步。

要求：
1. 按话题真正转换的地方分成 6–7 个主题章节（2 小时课程 6–7 段，不要过密），不要按固定时间机械切分；
2. 以转写为主：老师讲的定义、例子、数字、结论都要保留；资料只补结构、术语和页面依据；
3. 面向零基础：先给直觉/生活类比，再给正式定义，再拆步骤/例子，最后总结；不要只写提纲；
4. 资料可能来自多个文件（pages[].file / label / index）；按转写内容判断相关页，不要假定文件顺序等于讲课顺序；section.page 填 pages[].index；
5. 每节 start/end 取给定单元的边界，覆盖整节课，不要重叠；
6. 每节尽量配一个「图示」，从下面的结构化类型里选一个，帮助学生建立结构感：
   - flow：步骤/因果链，steps:[{label,detail}]，2–6 步
   - compare：对比两方，left/right 各有 title 和 items
   - table：表格，headers + rows
   图示要简单准确，不要编造数据；没有合适图示时 figure 置 null。
7. 每节要有一个具体例子（example.steps 拆成 2–5 步），以及 1–3 个初学者易错点（pitfalls）；
8. 如果资料有但转写没讲、或讲解补充了资料没有的内容，写进该节 gaps（最多 3 条）；
9. 术语 5–10 个，每个给：英文、白话解释、为什么重要、一个例子；
10. 最后给 3–5 句全文总结、5–8 道自测题（复习用，带提示，不要求答案很长）和一个全局 gaps；
11. 只输出 JSON 对象，不要解释、不要 Markdown 围栏；内容要详细，不要为了简短省略关键解释。

JSON 结构：
{"title":"≤24字","subtitle":"课程 / 节次 / 零基础详细版","audience":"零基础","objectives":["..."],
 "summary":"3–5句话",
 "sections":[{"start":0,"end":360,"page":3,"heading":"…","intuition":"一句话直觉",
   "body":["详细段落1","详细段落2","详细段落3"],
   "figure":{"kind":"flow","title":"…","steps":[{"label":"…","detail":"…"}]},
   "example":{"title":"…","steps":["…","…"]},
   "pitfalls":["…"],"takeaway":"…","gaps":["…"]}],
 "terms":[{"term":"中文","en":"English","plain":"白话","why":"为什么重要","example":"例子"}],
 "review":[{"q":"…","hint":"…"}],"gaps":["…"]}`;

  const CHAPTER_SYSTEM_PROMPT = `你是课程助教。学生会给你一整节课的转写（每段约 60 秒）和老师上传的资料（PPT/PDF/Word）的页/节文字、以及资料的大标题候选 outline。
请优先按照老师资料的「大标题 / 大章节」来分段：资料里有几个大标题，就分几段（通常 2–6 段），不要强行凑 4 段，也不要按时间均分。
规则：
1. 忽略开场静音、试音、寒暄、音乐、掌声、谢谢、字幕声明等无效内容；第一个 start 必须是老师真正开始讲第一个知识点的那句转写的开始时间，不要从 0 开始（除非 0 秒就在讲）；
2. 每个 start 取该段第一句有内容的转写 start；end 取下一个 start，最后一段 end 到视频结束；
3. title 直接用资料大标题的短名（不超过 12 个字），例如「性格（人格）」「情绪与情商」；
4. summary 不超过 30 个字，只做一句话补充，不要写长段落；
5. 在话题真正转换的地方切；不要为了数量把同一大标题拆成多段；
6. 如果 outline 为空或不可靠，才按转写内容自己归纳 2–6 段；
7. 如果资料有但转写没讲、或讲解补充了资料没有的内容，写进该段 gaps（最多 2 条）；
8. page 填最相关的资料页码，没有就填 null；只输出 JSON 对象，不要解释、不要 Markdown 围栏。

JSON 结构：
{"chapters":[{"start":300,"end":1800,"title":"性格（人格）","summary":"先讲性格的定义","page":3,"gaps":["资料第3页的图没有讲到"]}]}`;

  /** 扫片识别：一批帧（每批 ≤6 张）→ 逐帧标题/要点。 */
  function buildSlideMessages(frames) {
    const content = [{
      type: 'text',
      text: '下面是同一段课堂录像按时间顺序截取的 ' + frames.length + ' 帧。请逐帧识别画面里的幻灯片/板书。',
    }];
    frames.forEach((frame, index) => {
      content.push({ type: 'text', text: '第 ' + (index + 1) + ' 帧（t=' + Math.round(Number(frame.t) || 0) + ' 秒）：' });
      content.push({ type: 'image_url', image_url: { url: String(frame.dataUrl || '') } });
    });
    content.push({
      type: 'text',
      text: '只输出 JSON 数组，元素为 {"t": 秒数, "title": "标题或空字符串", "points": ["要点"]}；'
        + '看不清就留空，不要编造。不要输出解释。',
    });
    return [
      { role: 'system', content: SLIDE_SYSTEM_PROMPT },
      { role: 'user', content: content },
    ];
  }

  /** 把分页资料汇总成讲义。 */
  function buildHandoutMessages(input) {
    const segments = Array.isArray(input && input.segments) ? input.segments : [];
    const payload = segments.map((segment) => ({
      page: segment.page == null ? null : segment.page,
      start: Math.round(Number(segment.start) || 0),
      end: Math.round(Number(segment.end) || 0),
      heading: segment.heading || '',
      slideText: segment.slideText || '',
      points: Array.isArray(segment.points) ? segment.points : [],
      notes: Array.isArray(segment.notes) ? segment.notes : [],
    }));
    const user = [
      '课程：' + (input.course || '未知课程'),
      '节次：' + (input.label || '未知节次'),
      '时长：' + (input.durationText || '未知'),
      '',
      '分页资料（JSON）：',
      JSON.stringify(payload),
    ].join('\n');
    return [
      { role: 'system', content: HANDOUT_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ];
  }

  /** 从文本里截出第一个平衡的 JSON 数组/对象；能跳过字符串里的括号。 */
  function balancedSlice(text, openChar, closeChar) {
    const start = text.indexOf(openChar);
    if (start < 0) return '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === openChar) depth += 1;
      else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  /** 模型被 max_tokens 截断时，保住最后一个完整对象并补上 ]。 */
  function repairTruncatedArray(text) {
    const start = text.indexOf('[');
    if (start < 0) return '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let lastComplete = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      } else if (ch === '}' && depth === 1) {
        lastComplete = i;
      }
    }
    if (lastComplete > start) return text.slice(start, lastComplete + 1) + ']';
    return '';
  }

  function stripTrailingCommas(text) {
    return text.replace(/,\s*([}\]])/g, '$1');
  }

  /** 多级容错解析：原样 → 去围栏 → 平衡数组/对象 → 截断修复 → 尾逗号。 */
  function parseJSONLoose(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回内容');
    const trimmed = text.trim();
    const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const candidates = [trimmed, fenced];
    for (const source of [trimmed, fenced]) {
      if (!source) continue;
      const start = source.search(/[\[{]/);
      const firstIsObject = start >= 0 && source[start] === '{';
      // 先按「第一个出现的结构」解析，避免把 {"chapters":[...]} 里的数组当成根
      const primary = firstIsObject ? balancedSlice(source, '{', '}') : balancedSlice(source, '[', ']');
      const secondary = firstIsObject ? balancedSlice(source, '[', ']') : balancedSlice(source, '{', '}');
      if (primary) candidates.push(primary);
      const repaired = repairTruncatedArray(source);
      if (repaired) candidates.push(repaired);
      if (secondary) candidates.push(secondary);
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      for (const value of [candidate, stripTrailingCommas(candidate)]) {
        try {
          return JSON.parse(value);
        } catch (err) {
          /* 下一种 */
        }
      }
    }
    throw new Error('模型返回的不是合法 JSON');
  }

  function toText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function toList(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeSlides(value) {
    const list = Array.isArray(value) ? value : toList(value && value.slides);
    return list
      .map((item) => ({
        t: Number(item && item.t),
        title: toText(item && item.title),
        points: toList(item && item.points).map(toText).filter(Boolean).slice(0, 8),
      }))
      .filter((item) => Number.isFinite(item.t) && (item.title || item.points.length));
  }

  function normalizeHandout(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      title: toText(source.title) || '本节讲义',
      summary: toText(source.summary),
      sections: toList(source.sections)
        .map((section) => ({
          page: Number.isFinite(Number(section && section.page)) ? Number(section.page) : null,
          start: Number(section && section.start) || 0,
          end: Number(section && section.end) || 0,
          heading: toText(section && section.heading),
          body: toText(section && section.body),
        }))
        .filter((section) => section.heading || section.body)
        .slice(0, 40),
      terms: toList(source.terms)
        .map((term) => ({ term: toText(term && term.term), plain: toText(term && term.plain), why: toText(term && term.why) }))
        .filter((term) => term.term)
        .slice(0, 12),
      gaps: toList(source.gaps).map(toText).filter(Boolean).slice(0, 12),
    };
  }

  /** 把按时长切好的转写窗口汇总成「第几分钟在讲啥」的章节。 */
  function buildChapterMessages(input) {
    const units = Array.isArray(input && input.units)
      ? input.units
      : (Array.isArray(input && input.windows) ? input.windows : []);
    const pages = Array.isArray(input && input.pages) ? input.pages.slice(0, 80) : [];
    const outline = Array.isArray(input && input.outline) ? input.outline.slice(0, 24) : [];
    const payload = {
      course: input.course || '未知课程',
      label: input.label || '未知节次',
      durationText: input.durationText || '未知',
      outline: outline.map((item) => ({
        page: item.page || null,
        title: String(item.title || '').slice(0, 60),
        file: item.file || '',
      })),
      units: units.map((unit) => ({
        start: Math.round(Number(unit.start) || 0),
        end: Math.round(Number(unit.end) || 0),
        text: String(unit.text || '').slice(0, 400),
      })),
      pages: pages.map((page) => ({
        index: page.index,
        file: page.file || '',
        label: page.label || '',
        page: page.page || page.index,
        title: String(page.title || '').slice(0, 80),
        text: String(page.text || '').slice(0, 400),
      })),
    };
    const user = [
      '课程：' + payload.course,
      '节次：' + payload.label,
      '时长：' + payload.durationText,
      '',
      '这些是课堂录音按 60 秒切好的转写片段、上传资料的页/节文字，以及资料的大标题候选（JSON）。请忽略无声音/寒暄/无效内容，优先按资料大标题分段（有几个大标题就几段，通常 2–6 段），不要强行凑 4 段；每段 title 不超过 12 字，summary 不超过 30 字，第一个 start 必须是老师开始讲第一段内容的时间：',
      JSON.stringify(payload),
    ].join('\n');
    return [
      { role: 'system', content: CHAPTER_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ];
  }

  function normalizeChapters(value) {
    const list = Array.isArray(value) ? value : toList(value && value.chapters);
    return list
      .map((item) => ({
        start: Math.max(0, Math.round(Number(item && item.start) || 0)),
        end: Math.max(0, Math.round(Number(item && item.end) || 0)),
        title: toText(item && item.title),
        summary: toText(item && item.summary),
        page: Number.isFinite(Number(item && item.page)) ? Math.max(1, Number(item.page)) : null,
        gaps: toList(item && item.gaps).map(toText).filter(Boolean).slice(0, 4),
      }))
      .filter((item) => item.end > item.start && (item.title || item.summary))
      .sort((a, b) => a.start - b.start)
      .slice(0, 80);
  }

  function buildLessonMessages(input) {
    const units = Array.isArray(input && input.units)
      ? input.units
      : (Array.isArray(input && input.windows) ? input.windows : []);
    const pages = Array.isArray(input && input.pages) ? input.pages.slice(0, 80) : [];
    const payload = {
      course: input.course || '未知课程',
      label: input.label || '未知节次',
      durationText: input.durationText || '未知',
      units: units.map((unit) => ({
        start: Math.round(Number(unit.start) || 0),
        end: Math.round(Number(unit.end) || 0),
        text: String(unit.text || '').slice(0, 400),
      })),
      pages: pages.map((page) => ({
        index: page.index,
        file: page.file || '',
        label: page.label || '',
        page: page.page || page.index,
        title: String(page.title || '').slice(0, 80),
        text: String(page.text || '').slice(0, 400),
      })),
    };
    return [
      { role: 'system', content: LESSON_SYSTEM_PROMPT },
      {
        role: 'user',
        content: '请根据以下转写和资料，生成一份课程讲义（JSON）：\n' + JSON.stringify(payload),
      },
    ];
  }

  /** 单节扩写：只给这一节的转写和资料页，强制写透。 */
  function buildLessonSectionMessages(input) {
    const section = (input && input.section) || {};
    const units = Array.isArray(input && input.units) ? input.units.slice(0, 40) : [];
    const pages = Array.isArray(input && input.pages) ? input.pages.slice(0, 24) : [];
    const payload = {
      course: (input && input.course) || '未知课程',
      label: (input && input.label) || '',
      section: {
        heading: section.heading || '',
        start: section.start || 0,
        end: section.end || 0,
        page: section.page || null,
        outline: section.summary || '',
      },
      transcript: units.map((unit) => ({
        start: Math.round(Number(unit.start) || 0),
        end: Math.round(Number(unit.end) || 0),
        text: String(unit.text || '').slice(0, 500),
      })),
      pages: pages.map((page) => ({
        index: page.index,
        file: page.file || '',
        label: page.label || '',
        title: String(page.title || '').slice(0, 80),
        text: String(page.text || '').slice(0, 350),
      })),
    };
    return [
      {
        role: 'system',
        content: `你是课程助教，正在为零基础学生写讲义中的「一节」。只写这一节，不要写其他节。
必须做到：
1. body 写 4–6 段，每段 100–180 个汉字，不能少于 4 段；顺序是：生活直觉/类比 → 正式定义 → 拆解步骤或机制 → 老师举的例子/数字 → 小结。不能只写提纲，不能一句话带过。
2. 以 transcript（这一节的课堂转写）为主，保留老师讲的定义、例子、数字、对比和结论；pages 只用来补术语、页码和结构。转写里没有的内容不要编。
3. intuition 用一句人话解释这一节到底在讲什么。
4. 尽量给一个 figure，从 flow（步骤/因果链）、compare（左右对比）、table（表格）里选；简单准确，不编数据。
5. example 要给具体情境并拆成 2–5 步；pitfalls 给 1–3 个初学者易错点；takeaway 一句话。
6. 只输出一个 JSON 对象，不要解释、不要 Markdown 围栏：
{"heading":"…","intuition":"…","body":["段1","段2","段3"],"figure":{"kind":"flow","title":"…","steps":[{"label":"…","detail":"…"}]},"example":{"title":"…","steps":["…","…"]},"pitfalls":["…"],"takeaway":"…","gaps":["…"]}`,
      },
      {
        role: 'user',
        content: '请把这一节写透（JSON）：\n' + JSON.stringify(payload),
      },
    ];
  }

  /** 术语/自测/目标：基于已经写完的章节，单独生成。 */
  function buildLessonMetaMessages(input) {
    const sections = Array.isArray(input && input.sections) ? input.sections.slice(0, 12) : [];
    const payload = {
      course: (input && input.course) || '未知课程',
      label: (input && input.label) || '',
      sections: sections.map((section) => ({
        heading: section.heading || '',
        summary: String(section.summary || '').slice(0, 200),
        body: (Array.isArray(section.body) ? section.body.join(' ') : String(section.body || '')).slice(0, 300),
        page: section.page || null,
      })),
    };
    return [
      {
        role: 'system',
        content: `你是课程助教。根据整份讲义的章节，补全学习辅助内容，面向零基础：
1. objectives：3–5 条本讲目标；
2. summary：3–5 句全文总结；
3. terms：5–10 个术语，每个含 term、en、plain（白话）、why（为什么重要）、example（例子）；
4. review：5–8 道自测题，每道含 q、hint（提示，不要求长答案）；
5. gaps：这份讲义还没覆盖到的点（最多 8 条）。
只输出 JSON 对象，不要解释、不要 Markdown 围栏：
{"objectives":["…"],"summary":"…","terms":[{"term":"…","en":"…","plain":"…","why":"…","example":"…"}],"review":[{"q":"…","hint":"…"}],"gaps":["…"]}`,
      },
      {
        role: 'user',
        content: '章节如下，请补全术语、自测和目标（JSON）：\n' + JSON.stringify(payload),
      },
    ];
  }

  /** 模型第一次没按 sections 返回时的简化重试：只要数组，字段最少。 */
  function buildLessonFallbackMessages(input) {
    const units = Array.isArray(input && input.units) ? input.units.slice(0, 180) : [];
    const pages = Array.isArray(input && input.pages) ? input.pages.slice(0, 80) : [];
    const payload = {
      course: input.course || '未知课程',
      label: input.label || '未知节次',
      units: units.map((unit) => ({
        start: Math.round(Number(unit.start) || 0),
        end: Math.round(Number(unit.end) || 0),
        text: String(unit.text || '').slice(0, 300),
      })),
      pages: pages.map((page) => ({
        index: page.index,
        file: page.file || '',
        label: page.label || '',
        page: page.page || page.index,
        title: String(page.title || '').slice(0, 60),
        text: String(page.text || '').slice(0, 250),
      })),
    };
    return [
      {
        role: 'system',
        content: '你是课程助教。只输出 JSON 数组，每个元素 {"start":秒,"end":秒,"page":页码或null,"heading":"…","body":"…"}。'
          + '分成 5–8 节，按话题切分，body 3–5 句，以转写为主；不要解释、不要围栏。',
      },
      {
        role: 'user',
        content: '课程：' + payload.course + '\n节次：' + payload.label
          + '\n以下 JSON 是转写单元和资料页，请直接输出 sections 数组：\n' + JSON.stringify(payload),
      },
    ];
  }

  function normalizeLesson(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawSections = Array.isArray(value)
      ? value
      : (toList(source.sections).length ? toList(source.sections) : toList(source.chapters));
    const pickText = (...values) => {
      for (const candidate of values) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      }
      return '';
    };
    const pickNumber = (...values) => {
      for (const candidate of values) {
        const number = Number(candidate);
        if (Number.isFinite(number)) return number;
      }
      return 0;
    };
    const textList = (input, limit) => {
      const list = Array.isArray(input) ? input : (typeof input === 'string' ? input.split(/\n+/) : []);
      return list.map(toText).filter(Boolean).slice(0, limit || 18);
    };
    const normalizeFigure = (figure) => {
      if (!figure || typeof figure !== 'object') return null;
      const kind = toText(figure.kind || figure.type);
      if (kind === 'flow') {
        const steps = toList(figure.steps).map((step) => ({
          label: pickText(step && step.label, step && step.title, step),
          detail: pickText(step && step.detail, step && step.text, step && step.body),
        })).filter((step) => step.label).slice(0, 8);
        return steps.length ? { kind: 'flow', title: toText(figure.title), steps: steps } : null;
      }
      if (kind === 'compare') {
        const side = (input) => ({
          title: pickText(input && input.title, input && input.label),
          items: textList(input && (input.items || input.points || input.text), 8),
        });
        const left = side(figure.left);
        const right = side(figure.right);
        return (left.items.length || right.items.length) ? { kind: 'compare', title: toText(figure.title), left: left, right: right } : null;
      }
      if (kind === 'table') {
        const headers = textList(figure.headers, 6);
        const rows = toList(figure.rows).map((row) => textList(row, 6)).filter((row) => row.length).slice(0, 12);
        return (headers.length || rows.length) ? { kind: 'table', title: toText(figure.title), headers: headers, rows: rows } : null;
      }
      return null;
    };
    const normalizeExample = (example) => {
      if (!example) return null;
      if (typeof example === 'string') return { title: '例子', steps: textList(example, 6) };
      return {
        title: toText(example.title) || '例子',
        steps: textList(example.steps || example.body || example.content, 8),
      };
    };
    return {
      title: toText(source.title) || '本节讲义',
      subtitle: toText(source.subtitle),
      audience: toText(source.audience) || '零基础',
      summary: toText(source.summary) || toText(source.overview),
      objectives: textList(source.objectives || source.goals, 8),
      sections: rawSections
        .map((section) => {
          const pageValue = section && (section.page ?? section.pageIndex ?? section.slide);
          return {
            page: pageValue != null && Number.isFinite(Number(pageValue)) ? Number(pageValue) : null,
            start: Math.max(0, pickNumber(section && section.start, section && section.startTime)),
            end: Math.max(0, pickNumber(section && section.end, section && section.endTime)),
            heading: pickText(section && section.heading, section && section.title, section && section.name),
            intuition: pickText(section && section.intuition, section && section.oneLine, section && section.idea),
            body: textList(section && (section.body || section.content || section.text), 12),
            figure: normalizeFigure(section && section.figure),
            example: normalizeExample(section && section.example),
            pitfalls: textList(section && section.pitfalls, 5),
            takeaway: pickText(section && section.takeaway, section && section.keyPoint),
            gaps: textList(section && (section.gaps || section.differences || section.notes), 3),
          };
        })
        .filter((section) => section.heading || section.body.length)
        .slice(0, 40),
      terms: toList(source.terms || source.glossary)
        .map((term) => ({
          term: toText(term && term.term),
          en: toText(term && (term.en || term.english)),
          plain: toText(term && term.plain),
          why: toText(term && term.why),
          example: toText(term && (term.example || term['e.g'])),
        }))
        .filter((term) => term.term)
        .slice(0, 16),
      review: toList(source.review || source.questions)
        .map((item) => ({ q: toText(item && (item.q || item.question || item)), hint: toText(item && item.hint) }))
        .filter((item) => item.q)
        .slice(0, 12),
      gaps: textList(source.gaps || source.missing, 12),
    };
  }

  function formatClock(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    const m = Math.floor(value / 60);
    const s = value % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function handoutToMarkdown(handout) {
    if (!handout) return '';
    const lines = ['# ' + (handout.title || '本节讲义'), ''];
    if (handout.subtitle) lines.push('*' + handout.subtitle + '*', '');
    if (handout.summary) lines.push('> ' + handout.summary, '');
    if ((handout.objectives || []).length) {
      lines.push('## 本讲目标', '');
      for (const item of handout.objectives) lines.push('- ' + item);
      lines.push('');
    }
    for (const section of handout.sections || []) {
      const range = formatClock(section.start) + '–' + formatClock(section.end);
      const page = section.page ? '第 ' + section.page + ' 页 · ' : '';
      lines.push('## ' + page + range + ' · ' + (section.heading || ''));
      if (section.intuition) lines.push('', '**一句话理解**：' + section.intuition);
      const body = Array.isArray(section.body) ? section.body : [section.body];
      for (const paragraph of body) if (paragraph) lines.push('', paragraph);
      if (section.figure) {
        lines.push('', '**图示：' + (section.figure.title || '') + '**');
        if (section.figure.kind === 'flow') {
          for (const step of section.figure.steps || []) lines.push('- ' + step.label + (step.detail ? '：' + step.detail : ''));
        } else if (section.figure.kind === 'compare') {
          for (const side of [section.figure.left, section.figure.right]) {
            lines.push('- ' + (side.title || '') + '：' + (side.items || []).join('、'));
          }
        } else if (section.figure.kind === 'table') {
          if ((section.figure.headers || []).length) lines.push('| ' + section.figure.headers.join(' | ') + ' |');
          for (const row of section.figure.rows || []) lines.push('| ' + row.join(' | ') + ' |');
        }
      }
      if (section.example && (section.example.steps || []).length) {
        lines.push('', '**例子：' + (section.example.title || '') + '**');
        section.example.steps.forEach((step, index) => lines.push((index + 1) + '. ' + step));
      }
      if ((section.pitfalls || []).length) {
        lines.push('', '**易错点**');
        for (const pitfall of section.pitfalls) lines.push('- ' + pitfall);
      }
      if (section.takeaway) lines.push('', '**记住**：' + section.takeaway);
      if ((section.gaps || []).length) {
        lines.push('', '**资料 / 讲解差异**');
        for (const gap of section.gaps) lines.push('- ' + gap);
      }
      lines.push('');
    }
    if ((handout.terms || []).length) {
      lines.push('## 术语', '');
      for (const term of handout.terms) {
        lines.push('**' + term.term + (term.en ? ' / ' + term.en : '') + '**：' + (term.plain || ''));
        if (term.why) lines.push('（为什么重要：' + term.why + '）');
        if (term.example) lines.push('例：' + term.example);
        lines.push('');
      }
    }
    if ((handout.review || []).length) {
      lines.push('## 自测', '');
      for (const item of handout.review) {
        lines.push('- ' + item.q);
        if (item.hint) lines.push('  - 提示：' + item.hint);
      }
      lines.push('');
    }
    if ((handout.gaps || []).length) {
      lines.push('## 没覆盖到的', '');
      for (const gap of handout.gaps) lines.push('- ' + gap);
    }
    return lines.join('\n').trim() + '\n';
  }

  /** 带画面的讲解：messages 用 OpenAI 兼容的多模态 content 数组。 */
  function buildFrameExplainMessages(input) {
    const base = buildExplainMessages(input);
    const frameDataUrl = String((input && input.frameDataUrl) || '');
    return [
      { role: 'system', content: base[0].content + FRAME_SYSTEM_SUFFIX },
      {
        role: 'user',
        content: [
          { type: 'text', text: base[1].content + '\n\n（附：当前视频画面）' },
          { type: 'image_url', image_url: { url: frameDataUrl } },
        ],
      },
    ];
  }

  /** 该服务商预设里有没有可用的视觉模型（v0.9.3 起界面不再使用，保留给旧代码判断）。 */
  function supportsVision(provider) {
    return !!(provider && Array.isArray(provider.visionModels) && provider.visionModels.length > 0);
  }

  /** 该服务商是否支持 thinking 参数。 */
  function supportsThinking(provider) {
    return !!(provider && provider.supportsThinking);
  }

  /** HTTP 状态 -> 用户能看懂的提示。绝不拼接 Key。 */
  function httpError(status) {
    if (status === 401 || status === 403) {
      return { code: 'unauthorized', message: 'API Key 无效或已过期，打开 AI 设置检查' };
    }
    if (status === 402) {
      return { code: 'payment', message: '账户余额不足，请到你选择的服务商平台充值' };
    }
    if (status === 429) {
      return { code: 'rate', message: '请求太频繁，请等 10 秒再试' };
    }
    if (status === 404) {
      return { code: 'not-found', message: '接口地址不对（HTTP 404），检查接入地址' };
    }
    if (status === 400) {
      return { code: 'bad-request', message: '请求被拒绝（HTTP 400）：模型名或参数可能不对' };
    }
    if (status >= 500) {
      return { code: 'server', message: '服务商暂时不可用（HTTP ' + status + '）' };
    }
    return { code: 'http', message: '请求失败（HTTP ' + status + '）' };
  }

  AI.PROVIDERS = PROVIDERS;
  AI.SYSTEM_PROMPT = SYSTEM_PROMPT;
  AI.NOTE_LIMIT = NOTE_LIMIT;
  AI.REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
  AI.MAX_TOKENS = MAX_TOKENS;
  AI.getProvider = getProvider;
  AI.normalizeBaseURL = normalizeBaseURL;
  AI.joinURL = joinURL;
  AI.maskKey = maskKey;
  AI.buildExplainMessages = buildExplainMessages;
  AI.buildFrameExplainMessages = buildFrameExplainMessages;
  AI.buildSlideMessages = buildSlideMessages;
  AI.buildHandoutMessages = buildHandoutMessages;
  AI.buildChapterMessages = buildChapterMessages;
  AI.buildLessonMessages = buildLessonMessages;
  AI.buildLessonSectionMessages = buildLessonSectionMessages;
  AI.buildLessonMetaMessages = buildLessonMetaMessages;
  AI.buildLessonFallbackMessages = buildLessonFallbackMessages;
  AI.normalizeLesson = normalizeLesson;
  AI.normalizeChapters = normalizeChapters;
  AI.parseJSONLoose = parseJSONLoose;
  AI.normalizeSlides = normalizeSlides;
  AI.normalizeHandout = normalizeHandout;
  AI.handoutToMarkdown = handoutToMarkdown;
  AI.formatClock = formatClock;
  AI.supportsVision = supportsVision;
  AI.supportsThinking = supportsThinking;
  AI.httpError = httpError;
  AI.MAX_IMAGE_BYTES = 800 * 1024;
})();
