/*
 * 列表页：解析服务端渲染的表格，在右侧加一列「学习状态」。
 *
 * 关键取舍
 *  - 不依赖任何 class 名（Blackboard 主题一改就变），只看「表格 + a[href*="playVideo"] + 前三列文本」。
 *  - 每一行的 token 就地解 payload，拿到 hqySubId 作为主键；token 本身不保存、不打印。
 *  - 顺带把「节次名」写进该节的本地记录，播放页面板才有标题可显示（只写本地存储，不发请求）。
 *  - 结构不符时不注入，只 console.warn 一条，绝不打扰页面。
 */
(function () {
  'use strict';

  const PRN = globalThis.PRN;
  if (!PRN || !PRN.storage || !PRN.token || !PRN.time) return;

  const { storage, token, time } = PRN;
  const TAG = '[PRN:list]';

  const HEADER_STYLE = 'padding:6px 8px;white-space:nowrap;font-family:Arial,"SimHei","Microsoft YaHei",sans-serif;font-size:12px;font-weight:700;color:#94070A;text-align:left;';
  const CELL_STYLE = 'padding:6px 8px;white-space:nowrap;font-family:Arial,"SimHei","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums;font-size:12px;text-align:left;color:#6B625C;';

  const warned = new Set();
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(TAG, message);
  }

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  const cellMap = new Map(); // subId -> Set<HTMLTableCellElement>
  const meta = new Map(); // subId -> { label, hqyCourseId }，稍后合并进本地记录
  let installed = false;
  let subscribed = false;

  /** 表格里「观看」链接最多的那张就是录像表；找不到就别动页面。 */
  function findTable() {
    let best = null;
    let bestCount = 0;
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const count = table.querySelectorAll('a[href*="playVideo"]').length;
      if (count > bestCount) {
        best = table;
        bestCount = count;
      }
    }
    return bestCount > 0 ? best : null;
  }

  /** 一行 -> { label, ids }。ids 为 null 表示这一行解不出来（显示「—」）。 */
  function parseRow(row) {
    const link = row.querySelector('a[href*="playVideo"]');
    if (!link) return null;
    const cells = Array.from(row.cells || []);
    if (cells.length < 3) return null;

    const label = cleanText(cells[0].textContent);
    const recordTime = cleanText(cells[1].textContent);
    const rawToken = token.readToken(link.getAttribute('href') || '');
    const payload = rawToken ? token.decodePayload(rawToken) : null;
    return {
      label: label || recordTime,
      recordTime,
      ids: token.idsFromPayload(payload),
    };
  }

  function needsCell(row) {
    if (row.querySelector('a[href*="playVideo"]')) return true;
    const cells = Array.from(row.cells || []);
    if (!cells.length) return false;
    // 跨列占满的提示行不需要补格子，否则会多出一列错位
    if (cells.length === 1 && cells[0].getAttribute('colspan')) return false;
    return true;
  }

  function inject() {
    if (installed && !document.querySelector('[data-prn="status"]')) {
      installed = false;
      cellMap.clear();
    }
    if (installed) return true;
    const table = findTable();
    if (!table) return false;
    if (table.querySelector('[data-prn="status"]')) {
      installed = true;
      return true;
    }

    const rows = Array.from(table.rows || []);
    if (!rows.length) {
      warnOnce('no-row', '表格里没有行，跳过注入');
      return false;
    }

    const headRow = rows[0].querySelector('a[href*="playVideo"]') ? null : rows[0];
    const bodyRows = headRow ? rows.slice(1) : rows;
    if (!bodyRows.length) {
      warnOnce('no-body', '没有数据行，跳过注入');
      return false;
    }

    if (headRow) {
      const first = headRow.cells[0];
      // tagName 在 HTML 文档里是 "TH"，统一小写再比，避免把表头做成 td
      const tagName = first && first.tagName.toLowerCase() === 'th' ? 'th' : 'td';
      const th = document.createElement(tagName);
      th.textContent = '学习状态';
      th.dataset.prn = 'status';
      th.style.cssText = HEADER_STYLE;
      headRow.appendChild(th);
    } else {
      warnOnce('no-head', '没找到表头行，状态列直接追加在数据行末尾');
    }

    for (const row of bodyRows) {
      if (!needsCell(row)) continue;
      const cell = document.createElement('td');
      cell.dataset.prn = 'status';
      cell.style.cssText = CELL_STYLE;

      const info = parseRow(row);
      if (!info) {
        cell.textContent = '';
      } else if (!info.ids) {
        cell.textContent = '—';
        cell.style.color = '#9B8F88';
        cell.title = '这一行的播放令牌解析失败';
        warnOnce('decode-' + info.recordTime, '有一行 token 解码失败，该行显示「—」');
      } else {
        const subId = info.ids.subId;
        if (!cellMap.has(subId)) cellMap.set(subId, new Set());
        cellMap.get(subId).add(cell);
        cell.textContent = '未看';
        cell.style.color = '#9B8F88';
        cell.dataset.seen = '0';
        if (info.label || info.ids.hqyCourseId) {
          meta.set(subId, { label: info.label, hqyCourseId: info.ids.hqyCourseId });
        }
      }
      row.appendChild(cell);
    }

    installed = true;
    return true;
  }

  function render(root) {
    const records = (root && root.records) || {};
    for (const [subId, cells] of cellMap) {
      const record = records[subId];
      const seen = !!(record && Number.isFinite(record.lastTime) && record.lastTime > 0);
      const label = seen ? '看到 ' + time.formatTime(record.lastTime) : '未看';
      for (const cell of cells) {
        if (cell.textContent !== label) cell.textContent = label;
        cell.style.color = seen ? '#94070A' : '#9B8F88';
        cell.dataset.seen = seen ? '1' : '0';
        cell.title = (record && record.label ? record.label + ' · ' : '') + label;
      }
    }
  }

  /**
   * 把节次名合并进记录。播放器拿不到节次名，只能由列表页提供。
   * 先读一次，只有确实缺字段时才写，避免每次进列表页都产生一次无意义写入。
   */
  async function hydrateLabels() {
    if (!meta.size) return;
    const entries = Array.from(meta.entries());
    meta.clear();

    let root;
    try {
      root = await storage.read();
    } catch (err) {
      return;
    }

    const pending = entries.filter(([subId, info]) => {
      const record = root.records[subId];
      if (!record) return true;
      return (!!info.label && record.label !== info.label)
        || (!!info.hqyCourseId && record.hqyCourseId !== info.hqyCourseId);
    });
    if (!pending.length) return;

    try {
      await storage.mutate((draft) => {
        for (const [subId, info] of pending) {
          const record = draft.records[subId] || (draft.records[subId] = {
            subId,
            hqyCourseId: null,
            label: '',
            duration: 0,
            lastTime: 0,
            updatedAt: 0,
          });
          if (info.label) record.label = info.label;
          if (info.hqyCourseId) record.hqyCourseId = info.hqyCourseId;
        }
      });
    } catch (err) {
      warnOnce('hydrate', '写入节次名失败：' + (err && err.message));
    }
  }

  async function setup() {
    if (!inject()) return;
    if (!subscribed) {
      subscribed = true;
      storage.subscribe((root) => render(root));
    }
    try {
      render(await storage.read());
      await hydrateLabels();
    } catch (err) {
      warnOnce('setup', '读取本地记录失败');
    }
  }

  setup();
  // 表格可能是晚一点渲染出来的（或主题做了二次渲染），再兜一次；setup 自身幂等。
  setTimeout(setup, 1500);
  let mutateTimer = null;
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (mutateTimer) return;
      mutateTimer = setTimeout(() => {
        mutateTimer = null;
        setup();
      }, 350);
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener('pageshow', () => setup());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setup();
  });
})();
