/*
 * SRT / VTT 解析。只做数据转换，不碰 DOM，方便单测。
 *
 * 支持：
 *   - SRT（1\n00:00:01,000 --> 00:00:03,000\ntext）
 *   - WebVTT（WEBVTT + 00:00:01.000 --> 00:00:03.000\ntext）
 *   - 无序号、无空行分隔的宽松格式（按时间行切）
 *   - 多行字幕、HTML 标签（<i> 等）会被去掉
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});

  function parseTimestamp(value) {
    const text = String(value || '').trim().replace(',', '.');
    const match = text.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2}(?:\.\d{1,3})?)$/);
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes > 59 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function cleanText(lines) {
    const text = lines
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .replace(/\r/g, '')
      .trim();
    return text;
  }

  function parseCues(input) {
    const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const cues = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i += 1;
        continue;
      }
      if (/^WEBVTT/i.test(line) || /^NOTE\b/i.test(line) || /^STYLE\b/i.test(line)) {
        // VTT 头/注释：跳到下一个空行
        while (i < lines.length && lines[i].trim()) i += 1;
        continue;
      }

      // 可选序号行
      if (/^\d+$/.test(line) && i + 1 < lines.length && lines[i + 1].includes('-->')) {
        i += 1;
      }

      const timeLine = lines[i];
      if (!timeLine.includes('-->')) {
        i += 1;
        continue;
      }

      const parts = timeLine.split('-->');
      const start = parseTimestamp(parts[0]);
      const endRaw = (parts[1] || '').trim().split(/\s+/)[0];
      const end = parseTimestamp(endRaw);
      i += 1;

      const textLines = [];
      while (i < lines.length && lines[i].trim()) {
        textLines.push(lines[i]);
        i += 1;
      }
      const content = cleanText(textLines);
      if (start == null || end == null || end <= start || !content) continue;
      cues.push({ start: start, end: end, text: content });
    }

    // 按时间排序，去掉完全重复的 cue
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    const unique = [];
    for (const cue of cues) {
      const last = unique[unique.length - 1];
      if (last && last.start === cue.start && last.text === cue.text) {
        last.end = Math.max(last.end, cue.end);
        continue;
      }
      unique.push(cue);
    }
    return unique;
  }

  function formatTimestamp(seconds, comma) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    const millis = Math.round((value - Math.floor(value)) * 1000);
    const pad = (number, size) => String(number).padStart(size, '0');
    return pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(secs, 2)
      + (comma ? ',' : '.') + pad(millis, 3);
  }

  function toSrt(cues) {
    return cues.map((cue, index) => [
      String(index + 1),
      formatTimestamp(cue.start, true) + ' --> ' + formatTimestamp(cue.end, true),
      cue.text,
      '',
    ].join('\n')).join('\n');
  }

  function textBetween(cues, start, end) {
    return cues
      .filter((cue) => cue.end > start && cue.start < end)
      .map((cue) => cue.text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
  }

  /** 把字幕按固定窗口聚合成章节素材（不做 AI，纯数据）。 */
  function windowsFromCues(cues, duration, windowSeconds) {
    const size = Math.max(30, Number(windowSeconds) || 180);
    const total = Math.max(0, Number(duration) || 0);
    const endTime = total > 0 ? total : (cues.length ? cues[cues.length - 1].end : 0);
    const windows = [];
    for (let start = 0; start < endTime; start += size) {
      const end = Math.min(endTime, start + size);
      const text = textBetween(cues, start, end);
      if (text) windows.push({ start: Math.round(start), end: Math.round(end), text: text });
    }
    return windows;
  }

  PRN.srt = {
    parseCues: parseCues,
    parseTimestamp: parseTimestamp,
    toSrt: toSrt,
    textBetween: textBetween,
    windowsFromCues: windowsFromCues,
  };
})();
