/*
 * PPTX 解析（零依赖，纯浏览器 API）。
 *
 * .pptx 本质是一个 ZIP，里面是 XML。这里做三件事：
 *   1. 读 ZIP 中央目录，找到 ppt/slides/slideN.xml；
 *   2. 用原生 DecompressionStream('deflate-raw') 解压（Chrome 103+）；
 *   3. 从 <a:t> 里抽文字，按 presentation.xml 的顺序排好页。
 *
 * 不支持：PDF、加密的 pptx、扫描版/纯图片页（那些页没有文字，需要视觉模型）。
 * 这个模块不碰 chrome API，也只返回纯数据，方便单测与复用。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});
  const MAX_SLIDES = 300;
  const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

  function readU16(view, offset) {
    return view.getUint16(offset, true);
  }

  function readU32(view, offset) {
    return view.getUint32(offset, true);
  }

  function findEndOfCentralDirectory(view, length) {
    const minOffset = Math.max(0, length - 22 - 65535);
    for (let offset = length - 22; offset >= minOffset; offset -= 1) {
      if (readU32(view, offset) === 0x06054b50) return offset;
    }
    return -1;
  }

  function parseCentralDirectory(buffer) {
    const view = new DataView(buffer);
    const length = buffer.byteLength;
    const eocd = findEndOfCentralDirectory(view, length);
    if (eocd < 0) throw new Error('不是合法的 .pptx（找不到 ZIP 目录）');

    const total = readU16(view, eocd + 10);
    const centralOffset = readU32(view, eocd + 16);
    const entries = [];
    let offset = centralOffset;

    for (let i = 0; i < total; i += 1) {
      if (readU32(view, offset) !== 0x02014b50) break;
      const method = readU16(view, offset + 10);
      const compressedSize = readU32(view, offset + 20);
      const nameLength = readU16(view, offset + 28);
      const extraLength = readU16(view, offset + 30);
      const commentLength = readU16(view, offset + 32);
      const localOffset = readU32(view, offset + 42);
      const name = new TextDecoder('utf-8').decode(new Uint8Array(buffer, offset + 46, nameLength));
      entries.push({ name, method, compressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function readEntry(buffer, entry) {
    const view = new DataView(buffer);
    const local = entry.localOffset;
    if (readU32(view, local) !== 0x04034b50) throw new Error('ZIP 条目损坏：' + entry.name);
    const nameLength = readU16(view, local + 26);
    const extraLength = readU16(view, local + 28);
    const start = local + 30 + nameLength + extraLength;
    const compressed = buffer.slice(start, start + entry.compressedSize);
    if (entry.method === 0) return new Uint8Array(compressed);
    if (entry.method !== 8) throw new Error('不支持的 ZIP 压缩方式：' + entry.method);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const arrayBuffer = await new Response(stream).arrayBuffer();
    if (arrayBuffer.byteLength > MAX_ENTRY_BYTES) throw new Error('PPT 内容过大');
    return new Uint8Array(arrayBuffer);
  }

  function decodeEntities(value) {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCodePoint(parseInt(code, 16)));
  }

  function extractRuns(xml) {
    const runs = [];
    const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
    let match = re.exec(xml);
    while (match) {
      const text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
      if (text) runs.push(text);
      match = re.exec(xml);
    }
    return runs;
  }

  /** 按 presentation.xml 的 sldIdLst + rels 还原真实页序；失败时退回文件名数字序。 */
  async function orderSlides(entries, readXml) {
    const slideEntries = entries
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
      .sort((a, b) => Number(a.name.match(/slide(\d+)\.xml/)[1]) - Number(b.name.match(/slide(\d+)\.xml/)[1]));

    const index = new Map(slideEntries.map((entry) => [entry.name.replace(/^ppt\//, ''), entry]));
    const presentation = entries.find((entry) => entry.name === 'ppt/presentation.xml');
    const rels = entries.find((entry) => entry.name === 'ppt/_rels/presentation.xml.rels');
    if (!presentation || !rels) return slideEntries;

    try {
      const relsXml = await readXml(rels);
      const relMap = new Map();
      for (const match of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
        relMap.set(match[1], match[2]);
      }
      const presXml = await readXml(presentation);
      const ordered = [];
      for (const match of presXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
        const target = relMap.get(match[1]);
        if (!target) continue;
        const key = target.replace(/^\.\.\//, '').replace(/^\/?ppt\//, '');
        const entry = index.get(key);
        if (entry && ordered.indexOf(entry) === -1) ordered.push(entry);
      }
      if (ordered.length) return ordered;
    } catch (err) {
      /* 退回文件名序 */
    }
    return slideEntries;
  }

  async function parseArrayBuffer(arrayBuffer) {
    const entries = parseCentralDirectory(arrayBuffer);
    const xmlCache = new Map();

    async function readXml(entry) {
      if (xmlCache.has(entry.name)) return xmlCache.get(entry.name);
      const bytes = await readEntry(arrayBuffer, entry);
      const xml = new TextDecoder('utf-8').decode(bytes);
      xmlCache.set(entry.name, xml);
      return xml;
    }

    let slides = await orderSlides(entries, readXml);
    slides = slides.slice(0, MAX_SLIDES);
    if (!slides.length) {
      slides = entries
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
        .sort((a, b) => Number(a.name.match(/slide(\d+)\.xml/)[1]) - Number(b.name.match(/slide(\d+)\.xml/)[1]))
        .slice(0, MAX_SLIDES);
    }

    const pages = [];
    for (let i = 0; i < slides.length; i += 1) {
      const xml = await readXml(slides[i]);
      const runs = extractRuns(xml);
      pages.push({
        index: i + 1,
        title: runs[0] || '第 ' + (i + 1) + ' 页',
        lines: runs.slice(1),
        text: runs.join('\n'),
      });
    }
    return { pages: pages };
  }

  async function parseFile(file) {
    const buffer = await file.arrayBuffer();
    return parseArrayBuffer(buffer);
  }

  PRN.pptx = { parseFile: parseFile, parseArrayBuffer: parseArrayBuffer };
})();
