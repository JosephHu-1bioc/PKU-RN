# PKU-RN

> **PKU Replay Notes** · 北大教学网（Blackboard）课堂实录的笔记 / 字幕 / 讲义工具：一个浏览器扩展 + 一个只跑在本机的转写服务。

看回放时最麻烦的三件事：**找不到上次看到哪**、**没有字幕**、**记了笔记翻不回去**。这个项目把它们串起来——在播放页右侧挂一个面板，边看边打点、一键把整节课转成字幕、再结合课件生成讲义，全部在本机完成。

- 只支持 [北大教学网](https://course.pku.edu.cn) 的课堂实录，**不适用于其他学校或平台**。
- 音频、视频、课件、笔记**均不出本机**；只有你主动点「AI 讲解」时，文字才会发往你自己配置的服务商。

---

## 功能

| 功能 | 说明 |
|---|---|
| **时间戳笔记** | 播放到任意位置按 `Ctrl+B` 打点，点笔记里的时间戳直接跳回视频 |
| **观看进度** | 课程列表新增「学习状态」列，一眼看出哪些没看完 |
| **一键转写** | 扩展把 HLS 地址交给本机服务，只解码音频、用 `faster-whisper` 转写，不需要先下载整段视频 |
| **自动分章节** | 依据字幕内容划分章节，长课也能按段落跳转 |
| **资料解析** | 上传 PPT / PDF / Word，按课程和章节独立保存，自动提取文字 |
| **生成讲义** | 字幕 + 资料合成结构化讲义，可全屏预览、导出 PDF |
| **AI 讲解** | 侧栏基于字幕和资料提问，自带 API Key，支持 DeepSeek / Kimi / 通义 / 豆包 / 智谱 GLM |
| **下载视频** | 支持暂停 / 继续 / 取消，用于离线备份 |

没有 API Key 也能用：本地字幕、打点、资料解析、讲义排版都不依赖大模型。

## 架构

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 浏览器扩展 (MV3, 原生 JS)    │  HTTP  │ 本机转写服务 (Python 标准库)   │
│                             │ ─────► │ 127.0.0.1:8765               │
│ • 列表页：学习状态           │        │ • faster-whisper 转写         │
│ • 播放页：笔记 / 字幕 / 讲义 │ ◄───── │ • PyAV 解码音频（免装 ffmpeg） │
│ • Edge / Chrome             │        │ • 繁体→简体、PDF 生成         │
└─────────────────────────────┘        └──────────────────────────────┘
              │
              │ 只有「AI 讲解」会把文字发出去
              ▼
     你自己配置的 LLM 服务商
```

扩展本身不含模型，服务也不监听外网——`127.0.0.1` 之外访问不到。

## 快速开始

### 1. 本地转写服务

需要 Python 3.10–3.12。

```bash
cd service
python -m venv .venv

# Windows
.venv\Scripts\pip install -r requirements.txt
# macOS / Linux
.venv/bin/pip install -r requirements.txt
```

首次启动会在 `service/.cache` 下载 Whisper 模型（CPU `base` 约 0.15 GB）。模型缓存固定放在服务目录里，不写系统用户目录。

```bash
# Windows
.venv\Scripts\python service.py
# macOS / Linux
.venv/bin/python service.py
```

也可以用现成脚本：

```bash
scripts/start-service.bat     # Windows
scripts/start-service.sh      # macOS / Linux
```

看到这行就说明就绪：

```
PRN whisper service on http://127.0.0.1:8765  model=auto  stub=False
```

> 国内下载模型慢，可以先 `set HF_ENDPOINT=https://hf-mirror.com`（PowerShell 用 `$env:HF_ENDPOINT`）。

### 2. 加载扩展

**Edge / Chrome**

1. 打开 `edge://extensions` 或 `chrome://extensions`，开启 **开发人员模式**；
2. 点 **加载解压缩的扩展**，选择**本仓库根目录**（这一层直接有 `manifest.json`）；
3. 提示读取 Cookie 权限时请允许——这用于 HLS 视频的 AES key，只在本机使用。

**Safari（macOS）** 需要先打包再安装：

```bash
xcrun safari-web-extension-converter .
```

Safari 版另有已打包的 App 和一份详细说明，见 [`docs/使用说明-Safari.md`](docs/使用说明-Safari.md)。

### 3. 用起来

打开教学网的课程列表 → 「学习状态」列出现即表示扩展在工作；点「观看」进入回放页，右侧会挂出面板。播放到想记的位置按 `Ctrl+B`。

详细操作（打点、转写、上传资料、生成讲义、配置 AI）见 [`docs/使用说明-Windows.md`](docs/使用说明-Windows.md)。

## 目录结构

```
manifest.json       扩展入口（仓库根目录就是扩展本体）
src/
  background/   ai.js               Service Worker：代理 LLM 请求，避免页面 CORS
  common/       ai-config / pptx / srt / storage / time / token
  list/         list.js             课程列表「学习状态」
  player/       panel.js            播放页面板（主体逻辑）
                adapter.js          页面元素适配
                probe.js            拦截播放器、抓 HLS 地址
                download-probe.js   视频下载（逻辑移植自 PKU-Art）
                capture.js          抓帧 / 截图
                transcript-store.js / ppt-store.js / handout-store.js
                ai-settings.js      AI 设置面板
icons/             16 / 32 / 48 / 128 图标
service/           service.py（HTTP 服务）、transcribe_file.py（CLI）、requirements.txt
scripts/           启动服务脚本
docs/              使用说明与更新日志
media/             本地音视频放置目录（默认被 git 忽略）
```

## 隐私

- 本地服务只监听 `127.0.0.1`，不对局域网开放；
- 音视频、课件、笔记只在本机处理与存储（浏览器本地存储 + 服务目录）；
- HLS 的 Cookie / AES Key 只在扩展与服务之间使用，不写入任何服务器；
- AI 只收到**文字**（笔记 / 字幕 / 资料页），不会收到视频画面；
- AI 请求只发往你自己填的接入地址。

## 已知限制

- 仅适配北大教学网的回放页结构，页面改版可能导致面板不出现；
- 默认 CPU 转写较慢：2 小时课程在普通笔记本上约 30–40 分钟（有 NVIDIA 显卡可显著加速，见 [`service/README.md`](service/README.md)）；
- `base` 模型中文准确率一般，专有名词可显式换 `small` / `large-v3-turbo`；
- Safari 版为 ad-hoc 签名，每次 Safari 完全退出后需重新安装一次（除非有 Apple Developer 账号做公证）。

## 许可证

本项目以 **GPL-3.0** 发布，全文见 [LICENSE](LICENSE)。

之所以是 GPL-3.0 而非更宽松的许可证：`src/player/download-probe.js` 的视频下载逻辑移植自 [PKU-Art](https://github.com/zhuozhiyongde/PKU-Art)，该项目以 GPL-3.0 授权，衍生作品需沿用同一许可证。

第三方组件：

| 组件 | 用途 | 许可证 |
|---|---|---|
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 语音转写 | MIT |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) | 推理后端 | MIT |
| [PyAV](https://github.com/PyAV-org/PyAV) | 音视频解码 | BSD-3-Clause |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | PDF 生成与解析 | AGPL-3.0 |
| [python-docx](https://github.com/python-openxml/python-docx) | Word 解析 | MIT |
| [python-pptx](https://github.com/scanny/python-pptx) | PPT 解析 | MIT |
| [zhconv](https://github.com/gumblex/zhconv) | 繁体 → 简体 | MIT |
| [Whisper 模型](https://huggingface.co/Systran) | 语音识别权重 | MIT |

PKU-Art 原项目：[zhuozhiyongde/PKU-Art](https://github.com/zhuozhiyongde/PKU-Art)。

## 免责声明

本项目仅用于个人学习辅助，请勿用于传播课程内容或任何违反学校规定及平台服务条款的用途。使用产生的后果由使用者自行承担。
