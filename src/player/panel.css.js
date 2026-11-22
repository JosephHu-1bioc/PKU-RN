/*
 * 面板样式。以字符串形式注入 Shadow DOM。
 *
 * 为什么不是独立的 .css 文件：content script 不能 import CSS，也没有构建步骤，
 * 想加载外部 CSS 文件要么走 web_accessible_resources + fetch（多一次请求），
 * 要么在页面里插 <link>（会被播放器全局样式影响）。字符串注入零请求、零构建。
 *
 * 设计令牌按开发说明定义；只用 --accent 一个强调色，圆角 ≤ 12px，阴影只有 --shadow-md。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});

  PRN.panelCss = `
:host {
  all: initial;
  --bg: #F7F4F2;
  --surface: #FFFFFF;
  --border: #E3DAD6;
  --text: #211D1C;
  --text-2: #5F5652;
  --text-3: #958A84;
  --accent: #94070A;
  --accent-hover: #760508;
  --accent-dim: rgba(148, 7, 10, .08);
  --success: #2E7D5B;
  --bad: #C0392B;
  --r-sm: 6px;
  --r-md: 10px;
  --shadow-md: 0 12px 44px rgba(55, 20, 18, .16);
  --font: "Arial", "Helvetica Neue", "SimHei", "Microsoft YaHei", sans-serif;
  --mono: "Arial", "SimHei", "Microsoft YaHei", sans-serif;
  --handout-font: "Times New Roman", "SimSun", "宋体", "Songti SC", serif;
  position: fixed;
  top: 72px;
  right: 12px;
  width: 360px;
  max-width: calc(100vw - 24px);
  height: calc(100vh - 84px);
  z-index: 2147483000;
  display: block;
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  text-align: left;
  direction: ltr;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }
button { font-family: inherit; }
.wrap {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-md);
  overflow: hidden;
  container-type: inline-size;
  container-name: prn-panel;
}
.hd {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: linear-gradient(180deg, #A30C10 0%, #8A0609 58%, #7C0508 100%);
  border-bottom: 1px solid #6E0406;
  min-width: 0;
}
.hd-title {
  flex: 1 1 auto;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  color: #FFFFFF;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.icon-btn {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--accent-dim);
  color: var(--accent);
}
.hd .icon-btn { color: rgba(255, 255, 255, .9); }
.hd .icon-btn:hover { background: rgba(255, 255, 255, .16); color: #FFFFFF; }
.hd-text-btn {
  flex: 0 0 auto;
  height: 22px;
  padding: 0 6px;
  border: 1px solid rgba(255, 255, 255, .38);
  border-radius: var(--r-sm);
  background: rgba(255, 255, 255, .08);
  color: rgba(255, 255, 255, .92);
  font-size: 10.5px;
  line-height: 1;
  cursor: pointer;
}
.hd-text-btn:hover {
  color: var(--accent);
  background: #FFFFFF;
  border-color: #FFFFFF;
}
.bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.chapter-rail {
  flex: 0 0 auto;
  padding: 8px 14px 9px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.chapter-rail[hidden] { display: none; }
.cr-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
  min-width: 0;
}
.cr-title {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
}
.cr-count {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 10px;
}
.cr-current {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--text-2);
  font-size: 10px;
}
.cr-track {
  position: relative;
  display: flex;
  gap: 2px;
  height: 8px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--border);
}
.cr-seg {
  flex-basis: 0;
  position: relative;
  min-width: 3px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  overflow: hidden;
}
.cr-seg + .cr-seg { box-shadow: -1px 0 0 var(--surface); }
.cr-fill {
  display: block;
  width: 0;
  height: 100%;
  background: var(--accent);
  transition: width .2s linear;
}
.cr-seg.done .cr-fill { width: 100%; opacity: .38; }
.cr-seg.active .cr-fill { width: 100%; opacity: 1; }
.cr-seg:hover .cr-fill { opacity: .72; }
.cr-labels {
  display: flex;
  gap: 2px;
  margin-top: 4px;
}
.cr-label {
  flex: 1 1 0;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
  font-size: 9px;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
}
.cr-label.active { color: var(--accent); font-weight: 700; }
.cr-label.done { color: var(--text-2); }
/* v0.7 细进度条：只保留 4 个打点，悬停才显示分段内容 */
.chapter-rail {
  padding: 8px 14px 9px;
}
.cr-track {
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: var(--border);
  cursor: pointer;
}
.cr-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 0;
  border-radius: 4px;
  background: var(--accent);
  transition: width .2s linear;
}
.cr-dot {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  padding: 0;
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .25);
  transform: translate(-50%, -50%);
  cursor: pointer;
  z-index: 2;
}
.cr-dot.active {
  width: 13px;
  height: 13px;
  background: #C0392B;
}
.cr-tip {
  display: none;
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #FFFFFF;
  color: var(--text);
  font: 11px Arial, "SimHei", "Microsoft YaHei", sans-serif;
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 5;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .12);
}
.cr-dot:hover .cr-tip,
.cr-dot:focus .cr-tip { display: block; }
.cr-dot:first-of-type .cr-tip { left: -4px; transform: none; }
.cr-dot:last-of-type .cr-tip { left: auto; right: 0; transform: none; }
.dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}
.dot[data-state="idle"] { background: var(--text-3); }
.clock {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--text);
  white-space: nowrap;
}
.clock .sep { color: var(--text-3); margin: 0 4px; }
.clock .dur { color: var(--text-2); }
.btn {
  flex: 0 0 auto;
  margin-left: auto;
  border: 0;
  border-radius: var(--r-sm);
  padding: 6px 12px;
  background: var(--accent);
  color: #FFFFFF;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.55;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: var(--accent-hover); }
.btn:disabled { background: var(--border); color: var(--text-3); cursor: default; }
.btn-sm { margin-left: 0; padding: 4px 12px; font-size: 12px; }
.notice {
  flex: 0 0 auto;
  padding: 8px 16px;
  background: var(--accent-dim);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
}
.notice[hidden] { display: none; }
.composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.composer[hidden] { display: none; }
.composer-time {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  line-height: 1.3;
  color: var(--text-3);
}
.composer input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  outline: none;
}
.composer input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.composer-actions { display: flex; align-items: center; gap: 8px; }
.ghost {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 4px 12px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.55;
  cursor: pointer;
}
.ghost:hover { color: var(--text); border-color: var(--text-3); }
.composer-hint { margin-left: auto; color: var(--text-3); font-size: 11px; }
.listwrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.listwrap::-webkit-scrollbar { width: 8px; }
.listwrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.listwrap::-webkit-scrollbar-track { background: transparent; }
.notes { list-style: none; margin: 8px 0; padding: 0; }
.note {
  padding: 10px 12px;
  margin: 0 4px;
  border-radius: var(--r-sm);
}
.note:hover { background: var(--accent-dim); }
.note-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.note-ai {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding-left: 40px;
  margin-top: 2px;
}
.ai-link {
  flex: 0 0 auto;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
}
.ai-link:hover { color: var(--accent); text-decoration: underline; }
.ai-link:disabled { color: var(--text-3); text-decoration: none; cursor: default; opacity: .7; }
.ai-status {
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.4;
}
.ai-status::before {
  content: "●";
  margin-right: 4px;
  color: var(--accent);
}
.ai-error {
  color: var(--bad);
  font-size: 11px;
  line-height: 1.4;
}
.ai-explain {
  flex: 1 1 100%;
}
.ai-summary {
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
}
.ai-text {
  margin: 4px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ts {
  flex: 0 0 auto;
  border: 0;
  padding: 1px 0 0;
  background: transparent;
  color: var(--text-2);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
}
.ts:hover { color: var(--accent); text-decoration: underline; }
.ts:disabled { color: var(--text-3); cursor: default; text-decoration: none; }
.txt {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  overflow-wrap: anywhere;
}
.del {
  flex: 0 0 auto;
  border: 0;
  padding: 0 2px;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  line-height: 1.2;
  cursor: pointer;
  opacity: 0;
}
.note:hover .del:not(:disabled) { opacity: 1; }
.del:hover { color: var(--accent); }
.empty {
  padding: 16px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}
.empty[hidden] { display: none; }
.dbg {
  flex: 0 0 auto;
  padding: 8px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.3;
}
.dbg[hidden] { display: none; }
.dbg { display: none !important; }
.dbg-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; }
.dbg b { font-weight: 500; color: var(--text-2); }
.dbg-sep { color: var(--border); }
.dbg-methods {
  margin-top: 4px;
  color: var(--text-3);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.ai-sheet {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12px;
  background: rgba(37, 18, 16, .34);
}
.ai-sheet[hidden] { display: none; }
.ai-card {
  width: 100%;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
}
.ai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.ai-title {
  position: relative;
  padding-left: 9px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.ai-title::before {
  content: "";
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 3px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.ai-hint {
  margin: 0 0 8px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
}
.ai-field { display: block; margin-bottom: 6px; }
.ai-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 4px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
}
.ai-check input {
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.ai-label {
  display: block;
  margin-bottom: 4px;
  color: var(--text-2);
  font-size: 11px;
}
.ai-input {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}
.ai-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
/* 模型输入框带 datalist，隐藏 Chromium 自带的箭头，避免看起来像下拉框 */
.ai-input[list]::-webkit-calendar-picker-indicator { display: none !important; }
.ai-test-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  flex-wrap: wrap;
}
.ai-test-result {
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.4;
}
.ai-test-result[data-tone="ok"] { color: var(--success); }
.ai-test-result[data-tone="bad"] { color: var(--bad); }
.ai-save { width: 100%; }
.ai-foot {
  margin: 8px 0 0;
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.45;
}
.ppt-file-row { margin: 0 0 8px; }
.ppt-card.dragging {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-dim);
}
details.advanced {
  border-top: 1px solid var(--border);
  padding-top: 6px;
  margin-top: 2px;
}
details.advanced > summary {
  cursor: pointer;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.6;
}
details.advanced[open] > summary {
  margin-bottom: 6px;
}
.ppt-status {
  margin: 0 0 8px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
}
.ppt-list {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.ppt-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.ppt-item:last-child { border-bottom: 0; }
.ppt-index {
  flex: 0 0 auto;
  width: 20px;
  color: var(--text-3);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.ppt-title {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ppt-empty {
  padding: 10px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
  list-style: none;
}
.material-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.material-item:last-child { border-bottom: 0; }
.material-name {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.material-meta {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 10px;
}
.material-remove {
  flex: 0 0 auto;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.material-remove:hover { color: var(--bad); }
.handout-card {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 120px);
  overflow: hidden;
}
.handout-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  font-family: var(--handout-font);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.handout-body > * {
  max-width: 100%;
  min-width: 0;
}
.handout-head {
  flex: 0 0 auto;
}
.handout-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.handout-foot[hidden] { display: none; }
.handout-foot button {
  font-family: var(--font);
}
.handout-actions button {
  font-family: var(--font);
}
.handout-title-small {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
}
.handout-sections {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.handout-seg {
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.seg-time {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text-2);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  cursor: pointer;
}
.seg-time:hover {
  color: var(--accent);
  text-decoration: underline;
}
.seg-heading {
  margin-top: 2px;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}
.seg-body {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: 11.5px;
  line-height: 1.55;
}
.seg-paragraph { margin: 0 0 5px; }
.seg-intuition {
  margin: 5px 0;
  padding: 5px 8px;
  border-left: 3px solid #E5A83B;
  background: #FFF8E8;
  color: #7A5310;
  font-size: 11px;
  line-height: 1.5;
  border-radius: 0 6px 6px 0;
}
.objectives-list, .pitfalls-list, .review-list {
  margin: 2px 0 6px;
  padding-left: 17px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.55;
}
.objective, .review-item { margin-bottom: 4px; }
.review-q { color: var(--text-2); }
.review-hint { color: var(--text-3); font-size: 10px; margin-top: 1px; }
.section-label {
  margin: 5px 0 2px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
}
.figure {
  margin: 7px 0;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #FCF8F6;
}
.figure-title {
  margin-bottom: 5px;
  color: var(--text-2);
  font-size: 10.5px;
  font-weight: 600;
}
.figure-flow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.figure-step {
  flex: 1 1 80px;
  min-width: 68px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
}
.figure-step-index { display: block; color: var(--accent); font-size: 9px; font-weight: 700; }
.figure-step-label { display: block; font-size: 10px; color: var(--text-2); }
.figure-step-detail { display: block; margin-top: 1px; color: var(--text-3); font-size: 9px; line-height: 1.35; }
.figure-arrow { color: var(--text-3); font-size: 10px; }
.figure-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.figure-side { padding: 5px 6px; border: 1px solid var(--border); border-radius: 6px; background: #fff; }
.figure-side-title { display: block; color: #7A3B36; font-size: 10px; margin-bottom: 2px; }
.figure-side-list { margin: 0; padding-left: 14px; color: var(--text-2); font-size: 9.5px; line-height: 1.4; }
.figure-table { width: 100%; border-collapse: collapse; font-size: 9.5px; color: var(--text-2); }
.figure-table th, .figure-table td { border: 1px solid var(--border); padding: 3px 5px; text-align: left; }
.figure-table th { background: #F7EFED; color: #7A3B36; }
.example-box {
  margin: 6px 0;
  padding: 6px 8px;
  border: 1px solid #CFE5D6;
  border-radius: 7px;
  background: #F2F8F4;
}
.example-title { color: #2D6A45; font-size: 10.5px; font-weight: 600; }
.example-steps { margin: 3px 0 0; padding-left: 16px; color: var(--text-2); font-size: 10.5px; line-height: 1.5; }
.takeaway {
  margin: 6px 0 0;
  padding: 5px 7px;
  border-radius: 6px;
  background: #F7EFED;
  color: #7A3B36;
  font-size: 10.5px;
  font-weight: 600;
}
.term-example { margin: 2px 0 0; color: #2D6A45; font-size: 10px; line-height: 1.4; }
.handout-block-label {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 11px;
}
.handout-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.terms-list { list-style: none; margin: 0; padding: 0; }
.term { margin-bottom: 6px; }
.term-name { color: var(--accent); font-size: 11.5px; font-weight: 600; }
.term-plain { margin: 2px 0 0; color: var(--text-2); font-size: 11.5px; line-height: 1.5; }
.term-why { margin: 2px 0 0; color: var(--text-3); font-size: 10.5px; line-height: 1.4; }
.untouched-list { list-style: none; margin: 0; padding: 0; }
.untouched-item {
  position: relative;
  padding-left: 14px;
  margin-bottom: 4px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
}
.untouched-item::before {
  content: "!";
  position: absolute;
  left: 2px;
  color: #D99A5B;
  font-weight: 600;
}
.transcript-card {
  max-height: calc(100vh - 24px);
  overflow-y: auto;
}
.transcript-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.transcript-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.transcript-service {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font-size: 11px;
  font-family: var(--mono);
}
.transcript-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.transcript-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-3);
  font-size: 11px;
}
.chapter-track {
  display: flex;
  gap: 2px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.chapter-block {
  min-width: 3px;
  height: 100%;
  padding: 0;
  border: 0;
  border-right: 1px solid var(--bg, #111);
  background: var(--accent-dim);
  cursor: pointer;
}
.chapter-block:hover { background: var(--accent); }
.chapter-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.chapter-item {
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.chapter-item:last-child { border-bottom: 0; }
.chapter-page {
  margin-left: 6px;
  color: var(--text-3);
  font-size: 10.5px;
}
.chapter-title {
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}
.chapter-summary {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: 11.5px;
  line-height: 1.5;
}
.chapter-gaps {
  margin: 4px 0 0;
  padding-left: 16px;
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.45;
}
.chapter-gap-label {
  margin-top: 5px;
  color: var(--text-3);
  font-size: 10px;
}
.chapter-gap { margin-bottom: 2px; }
.transcript-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.transcript-cue {
  display: flex;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.transcript-cue:last-child { border-bottom: 0; }
.transcript-cue.active { background: var(--accent-dim); }
.cue-time {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  cursor: pointer;
}
.cue-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-2);
  font-size: 11.5px;
  line-height: 1.45;
}
.media-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.media-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}
.media-item:last-child { border-bottom: 0; }
.media-url {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 10px;
  word-break: break-all;
}

/* v0.9.3：可拖拽 / 可缩放的浮动面板 */
.hd { cursor: move; }
.hd-grip {
  flex: 0 0 auto;
  padding: 0 1px 0 0;
  color: rgba(255, 255, 255, .72);
  font-size: 15px;
  line-height: 1;
  cursor: grab;
  user-select: none;
}
.hd-grip:active { cursor: grabbing; }
.wrap.is-dragging,
.wrap.is-resizing { user-select: none; }
.wrap.is-dragging { box-shadow: 0 18px 60px rgba(0, 0, 0, .22); }
.wrap.is-resizing { box-shadow: 0 18px 60px rgba(0, 0, 0, .22); }
.rz {
  position: absolute;
  /* 放在浮层下面：设置面板打开时不会误触缩放手柄 */
  z-index: 20;
  touch-action: none;
}
.rz-n { top: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
.rz-s { bottom: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
.rz-e { right: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
.rz-w { left: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
.rz-ne, .rz-nw, .rz-se, .rz-sw { width: 14px; height: 14px; }
.rz-ne { top: 0; right: 0; cursor: nesw-resize; }
.rz-nw { top: 0; left: 0; cursor: nwse-resize; }
.rz-se { bottom: 0; right: 0; cursor: nwse-resize; }
.rz-sw { bottom: 0; left: 0; cursor: nesw-resize; }
.rz:hover { background: rgba(148, 7, 10, .12); }
.rz-se::after {
  content: "";
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--border);
  border-bottom: 2px solid var(--border);
  border-radius: 0 0 3px 0;
}

/* v0.9.3 齿轮设置重新排版 */
.ai-card-scroll { max-height: calc(100% - 4px); overflow-y: auto; overflow-x: hidden; }
.ai-row { display: flex; align-items: center; gap: 8px; }
.ai-row .ai-input { flex: 1 1 auto; min-width: 0; }
.ai-fetch {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 10px;
  font-size: 11px;
  white-space: nowrap;
}
.ai-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
.ai-chips:empty { display: none; }
.ai-chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 9px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
}
.ai-chip:hover { border-color: var(--accent); color: var(--accent); }
.ai-chip.active {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
}
.ai-note {
  margin: 2px 0 8px;
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.45;
}
.ai-note[data-tone="bad"] { color: var(--bad); }
.ai-note:empty { display: none; }
.ai-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.ai-actions .ai-save { flex: 1 1 120px; width: auto; }
.ai-actions .ai-test-row { margin: 0; flex: 0 0 auto; }
.ai-section {
  border-top: 1px solid var(--border);
  margin-top: 10px;
  padding-top: 8px;
}
.ai-section-title {
  margin: 0 0 4px;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
}
.ai-foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}
.ai-foot-row .ai-foot { margin: 0; }
.ai-foot-reset {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.4;
  text-decoration: underline;
  cursor: pointer;
}
.ai-foot-reset:hover { color: var(--accent); }

/* 宽度自适应：窄面板压缩字号/内边距，宽面板放大阅读区 */
@container prn-panel (max-width: 348px) {
  .hd { padding: 9px 10px; gap: 5px; }
  .hd-title { font-size: 12.5px; }
  .hd-text-btn { height: 20px; padding: 0 4px; font-size: 9.5px; }
  .icon-btn { width: 24px; height: 24px; font-size: 13px; }
  .bar { padding: 9px 10px; gap: 6px; }
  .chapter-rail { padding: 6px 10px 7px; }
  .composer { padding: 9px 10px; }
  .composer-hint { display: none; }
  .note { padding: 8px 6px; margin: 0 1px; }
  .note-ai { padding-left: 0; }
  .ai-sheet { padding: 6px; }
  .ai-card { padding: 10px; }
  .figure-compare { grid-template-columns: 1fr; }
  .figure-table { font-size: 9px; }
  .handout-body { padding-right: 0; }
  .cr-label { font-size: 8px; }
  .seg-body, .chapter-summary { font-size: 11px; }
}
@container prn-panel (min-width: 480px) {
  .hd { padding: 14px 18px; }
  .note { margin: 0 10px; }
  .txt { font-size: 13.5px; }
  .ai-card { padding: 16px; }
  .seg-body { font-size: 12px; }
}
.wrap.is-short .hd { padding: 8px 12px; }
.wrap.is-short .bar { padding: 8px 12px; }
.wrap.is-short .composer { padding: 8px 12px; }
.wrap.is-short .cr-labels { display: none; }
.wrap.is-tiny .chapter-rail { display: none; }
.wrap.is-tiny .hd-title { font-size: 12px; }

/* v0.9.4：旧版扩展残留提示 */
.ai-dup {
  margin: 0 0 8px;
  padding: 8px 10px;
  border: 1px solid #F0C36D;
  border-radius: var(--r-sm);
  background: #FFF8E8;
}
.ai-dup[hidden] { display: none; }
.ai-dup .ai-note {
  margin: 0 0 6px;
  color: #7A5310;
}
.ai-cleanup {
  width: 100%;
  border-color: #E5A83B;
  color: #7A5310;
}
.ai-cleanup:hover {
  border-color: #B47712;
  color: #5E3D08;
}
.hd-icon.has-badge {
  position: relative;
  color: #FFFFFF;
}
.hd-icon.has-badge::after {
  content: "";
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #FFD166;
}
`;
})();
