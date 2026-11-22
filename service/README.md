# 本地字幕服务

把一节课的音频/视频转成带时间戳的字幕，供扩展的「字幕」功能使用。

- 只监听 `127.0.0.1`，音频不出本机。
- 浏览器扩展不跑 Whisper；转写在 Python 里做。
- 使用 `faster-whisper` + PyAV 解码，**不需要单独安装 ffmpeg**。
- 模型不随扩展/仓库打包，首次使用按需下载；默认值优先控制体积。

## 体积与默认策略

| 机器 | 默认模型 | 模型体积（约） | 说明 |
|---|---|---:|---|
| 有 NVIDIA CUDA | `small` | ~0.47GB | 速度与中文准确率折中 |
| 纯 CPU / 其他电脑 | `base` | ~0.15GB | 保证能跑，速度较慢 |
| 需要更高准确率 | `large-v3-turbo` | ~1.6GB | 显式 `--model large-v3-turbo`，不默认下载 |
| 极低配 | `tiny` | ~0.08GB | 准确率较差，仅应急 |

CUDA 的 cuBLAS/cuDNN 是**可选加速包**（约 1.2GB），不装也能用 CPU。服务会自动检测；
GPU 运行时不可用会回退 CPU，不会让整个插件不可用。

本机实测（RTX 4050 Laptop 6GB + i7-13700H）：2 小时 `.ts` 用 GPU `small` 转写约 **351 秒（5.9 分钟）**，
模型约 0.47GB；同样课程 CPU `base` 约 40 分钟。`large-v3-turbo` 约 1.6GB，准确率更高但更占空间，按需手动选择。

## 安装（跨机器）

需要 Python 3.10–3.12。在 `whisper_service` 目录：

```powershell
python -m venv .venv
# Windows
.venv\Scripts\pip install -r requirements.txt
# macOS / Linux
# .venv/bin/pip install -r requirements.txt
```

国内网络可加镜像：

```powershell
.venv\Scripts\pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

模型缓存固定在 `whisper_service/.cache`，不会写到系统用户目录；首次转写需要网络下载模型。
国内下载慢可设置：

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
```

## 启动

```powershell
# 推荐：自动检测 GPU/CPU、自动选体积优先模型
.venv\Scripts\python service.py

# 明确指定模型
.venv\Scripts\python service.py --model small
.venv\Scripts\python service.py --model large-v3-turbo --device cuda

# 只联调扩展界面，不加载模型
.venv\Scripts\python service.py --stub
```

看到类似下面这行就绪：

```
PRN whisper service on http://127.0.0.1:8765  model=auto  stub=False
backend=faster-whisper  device=cuda  resolved_model=small  cuda=True(...)
```

扩展「字幕」浮层的服务地址默认 `http://127.0.0.1:8765`，可在扩展的高级设置里改。

### 可选 GPU 加速

只有希望用显卡时才需要安装；不装会用 CPU：

```powershell
# Windows / Linux，NVIDIA 显卡
.venv\Scripts\pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

服务会尝试 CUDA；如果驱动/库不匹配，自动回退 CPU。若想强制 CPU：

```powershell
.venv\Scripts\python service.py --device cpu --model base
```

## 一键转写（推荐）

扩展在播放页截获 HLS/MP4 地址后，会把**地址**发给本机服务：

```
扩展「字幕」→「一键转写本节」
  → 本机服务只解码音频（不下载整段视频）
  → 转写 → 字幕回填到扩展
```

- 不需要先用「下载视频」把 1–2GB 文件存到磁盘；
- 不需要配置 `--media-dir`；
- 只把地址和 Referer/UA 发给 `127.0.0.1`，不上传云端；
- 浏览器负责读取 HLS 的 AES key（key 接口常要求登录态），本机服务只下载公开分片并解码，不直接请求 key；如果播放列表/分片也拒绝，仍可回退「转写本机视频」。

## 转写本机大文件

如果在别的机器上已经下载了 `.ts`：

```powershell
.venv\Scripts\python service.py --media-dir "你放音视频的目录"
```

扩展 → 字幕 → 「转写本机视频」→ 选择文件。服务只接受该目录内的文件名，不能带路径。

CLI：

```powershell
.venv\Scripts\python transcribe_file.py "path/to/lecture.ts" --model small
```

输出同名 `.srt`，可在扩展里导入。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 后端、CUDA、GPU 名、当前模型/设备、文档能力 |
| GET | `/media` | 列出 `--media-dir` 内的音视频文件 |
| POST | `/transcribe-path` | JSON `{name, language}`，启动本机文件任务 |
| POST | `/transcribe-url` | JSON `{url, referer, user_agent, name, language}`，只取音频转写 |
| GET | `/job?id=…` | 任务状态：`running` / `done` / `error`，含 `stage` |
| POST | `/simplify` | JSON `{texts:[…]}`，繁体 → 简体 |
| POST | `/pdf` | JSON `{html}`，PyMuPDF Story 生成 A4 PDF |
| POST | `/transcribe?filename=…` | body 为文件字节，兼容旧上传方式 |

被阻止的 URL：只接受 `http/https`，服务只监听 localhost。

## 常见问题

- **`No module named faster_whisper`**：用 `.venv` 里的 Python，不要用系统 Python。
- **GPU 报 cublas/cudnn 缺失**：安装可选 CUDA 包，或直接 `--device cpu`。
- **模型下载卡住**：设置 `HF_ENDPOINT` 镜像；或先用 `--model tiny` 验证链路。
- **CPU 太慢**：默认 CPU `base` 只保证可运行；有 NVIDIA 显卡时装可选 CUDA 包并保持 `--device auto`，或显式 `--model small`。
- **中文专有名词不准**：可显式 `--model large-v3-turbo`（更大、更慢的下载），并配合扩展里的 PPT 术语/讲义上下文。
- **换电脑后路径不同**：不要复制 `.venv`；在新机器按 `requirements.txt` 重建，`--media-dir` 指向该机目录；一键转写不需要 media-dir。
