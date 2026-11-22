#!/usr/bin/env python3
"""本地字幕服务：把一节课的音频/视频转成带时间戳的字幕。

为什么要有它：
  - 浏览器扩展不能跑 Whisper；openai/whisper 需要 Python。
  - 视频的音频解码交给 faster-whisper（PyAV 自带 FFmpeg 库），不需要单独装 ffmpeg。
  - 所有音频只在本机处理，不上传云端。

接口（只监听 127.0.0.1）：
  GET  /health        返回后端、模型、是否可用
  POST /transcribe?filename=lecture.mp4&language=zh
                      body 是文件原始字节（application/octet-stream）
                      返回 {ok, backend, language, duration, segments:[{start,end,text}], srt}

运行：
  python service.py --stub          # 不装 Whisper，返回示例字幕，用于联调
  python service.py --model small   # 真正转写（首次会下载模型）

依赖：
  pip install faster-whisper        # 推荐，CPU int8，无需 torch/ffmpeg
  # 或 pip install openai-whisper   # 备选，需要 torch + ffmpeg
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Windows 用户目录的 .cache 可能没有写权限；把模型缓存放到服务目录里
_CACHE = Path(__file__).resolve().parent / ".cache"
_CACHE.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HF_HOME", str(_CACHE))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(_CACHE / "hub"))


def prepare_cuda_libraries() -> None:
    """pip 安装的 nvidia-*-cu12 轮子不一定自动进 PATH；这里显式登记 DLL 目录。"""
    paths = []
    for module_name in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_nvrtc"):
        try:
            spec = importlib.util.find_spec(module_name)
        except (ImportError, ValueError):
            spec = None
        if not spec or not spec.submodule_search_locations:
            continue
        base = Path(list(spec.submodule_search_locations)[0])
        for child in ("bin", "lib"):
            candidate = base / child
            if candidate.is_dir():
                paths.append(candidate)
    if not paths:
        return
    for path in paths:
        try:
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(path))
        except OSError:
            pass
    os.environ["PATH"] = os.pathsep.join([str(path) for path in paths] + [os.environ.get("PATH", "")])


prepare_cuda_libraries()

DEFAULT_PORT = 8765
MAX_UPLOAD = 1024 * 1024 * 1024  # 1 GB
MEDIA_EXTS = {".ts", ".m2ts", ".mts", ".mp4", ".mkv", ".mov", ".webm", ".flv",
              ".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg"}
DOC_EXTS = {".pptx", ".ppt", ".pdf", ".docx", ".doc", ".txt", ".md"}
MAX_DOC_PAGES = 120
MAX_DOC_BYTES = 200 * 1024 * 1024
STUB_SEGMENTS = [
    (0.0, 6.0, "这节课我们讲组织设计的三个权变因素。"),
    (6.0, 14.0, "第一个是环境不确定性：环境越不稳定，结构越应该扁平、分权。"),
    (14.0, 24.0, "第二个是战略：成本领先适合机械式结构，差异化适合有机式结构。"),
    (24.0, 34.0, "第三个是技术：单件小批生产需要技能多样，流水线更依赖层级控制。"),
    (34.0, 44.0, "下面我们看一个案例，比较两家公司在同样环境下的不同选择。"),
    (44.0, 54.0, "第一家选择把决策权下放到区域，第二家仍然集中在总部。"),
    (54.0, 64.0, "结果在需求波动时，第一家的响应速度明显更快。"),
    (64.0, 74.0, "但分权也带来协调成本，所以还要配套信息系统。"),
    (74.0, 84.0, "这一页的图展示了组织结构与环境不确定性的匹配关系。"),
    (84.0, 94.0, "横轴是环境不确定性，纵轴是结构有机程度。"),
    (94.0, 104.0, "可以看到，两者大致是正相关的。"),
    (104.0, 114.0, "最后留一个思考题：你所在的团队更像哪一种结构？"),
    (114.0, 120.0, "下节课我们讲战略与组织结构的匹配。"),
]

_models = {}
_model_lock = threading.Lock()
_jobs = {}
_jobs_lock = threading.Lock()
_RUNTIME = {"model": "auto", "device": "auto", "compute_type": "auto"}
_cuda_failed = False


def gpu_status() -> dict:
    """跨平台探测：CTranslate2 能枚举到 CUDA 设备才走 GPU。"""
    result = {"cuda": False, "count": 0, "name": "", "memory_mb": 0}
    try:
        import ctranslate2
        count = int(ctranslate2.get_cuda_device_count())
    except Exception:  # noqa: BLE001
        count = 0
    result["count"] = max(0, count)
    result["cuda"] = count > 0
    if result["cuda"] and shutil.which("nvidia-smi"):
        try:
            output = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                stderr=subprocess.DEVNULL, text=True, timeout=5,
            ).strip().splitlines()
            if output:
                parts = [part.strip() for part in output[0].split(",")]
                result["name"] = parts[0] if parts else ""
                if len(parts) > 1:
                    digits = "".join(ch for ch in parts[1] if ch.isdigit())
                    result["memory_mb"] = int(digits or 0)
        except Exception:  # noqa: BLE001
            pass
    return result


def auto_model_name() -> str:
    """体积优先的默认策略：GPU 用 small（约 0.5GB），纯 CPU 用 base（约 0.15GB）。
    需要更高准确率可显式 --model large-v3-turbo；它不随插件分发，按需下载。
    """
    gpu = gpu_status()
    if gpu["cuda"]:
        return "small"
    return "base"


def resolve_model_name(requested: str) -> str:
    name = str(requested or "auto").strip() or "auto"
    return auto_model_name() if name == "auto" else name


def resolve_device(requested: str) -> str:
    name = str(requested or "auto").strip() or "auto"
    if name == "auto":
        return "cuda" if gpu_status()["cuda"] and not _cuda_failed else "cpu"
    if name == "cuda" and (not gpu_status()["cuda"] or _cuda_failed):
        raise RuntimeError("CUDA 运行时不可用（可能需要 cuBLAS/cuDNN），请改用 --device cpu")
    return name


def resolve_compute_type(requested: str, device: str) -> str:
    name = str(requested or "auto").strip() or "auto"
    if name != "auto":
        return name
    return "float16" if device == "cuda" else "int8"


def load_whisper_model(model_name: str, device: str, compute_type: str):
    """带回退的模型加载：GPU 失败/CUDA 库缺失时回退 CPU，避免整台机器不能用。"""
    from faster_whisper import WhisperModel

    key = ("faster-whisper", model_name, device, compute_type)
    cached = _models.get(key)
    if cached is not None:
        return cached

    attempts = [(model_name, device, compute_type)]
    if device == "cuda":
        attempts.append((model_name, "cpu", "int8"))
    if model_name != "base":
        attempts.append(("base", "cpu", "int8"))

    last_error = None
    seen = set()
    for name, dev, compute in attempts:
        signature = (name, dev, compute)
        if signature in seen:
            continue
        seen.add(signature)
        try:
            model = WhisperModel(name, device=dev, compute_type=compute)
            loaded = (model, name, dev, compute)
            _models[key] = loaded
            if (name, dev, compute) != (model_name, device, compute_type):
                print(f"[whisper] fallback model: {name} device={dev} compute={compute}", file=sys.stderr)
            return loaded
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            print(f"[whisper] load failed: model={name} device={dev} compute={compute}: {exc}",
                  file=sys.stderr)
    raise RuntimeError("无法加载 Whisper 模型：" + str(last_error or "未知错误"))



def srt_time(seconds: float) -> str:
    value = max(0.0, float(seconds))
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    secs = int(value % 60)
    millis = int(round((value - int(value)) * 1000))
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def to_srt(segments) -> str:
    lines = []
    for index, seg in enumerate(segments, start=1):
        lines.append(str(index))
        lines.append(f"{srt_time(seg['start'])} --> {srt_time(seg['end'])}")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def backend_status() -> dict:
    faster = importlib.util.find_spec("faster_whisper") is not None
    openai_whisper = importlib.util.find_spec("whisper") is not None
    zhconv = importlib.util.find_spec("zhconv") is not None
    ffmpeg = any(
        os.path.exists(os.path.join(path, "ffmpeg.exe")) or os.path.exists(os.path.join(path, "ffmpeg"))
        for path in os.environ.get("PATH", "").split(os.pathsep)
        if path
    )
    gpu = gpu_status()
    return {
        "faster_whisper": faster,
        "openai_whisper": openai_whisper,
        "zhconv": zhconv,
        "ffmpeg": ffmpeg,
        "av": importlib.util.find_spec("av") is not None,
        "backend": "faster-whisper" if faster else ("whisper" if openai_whisper else "none"),
        "cuda": gpu["cuda"],
        "cuda_devices": gpu["count"],
        "cuda_failed": _cuda_failed,
        "gpu_name": gpu["name"],
        "gpu_memory_mb": gpu["memory_mb"],
        "auto_model": auto_model_name(),
    }


def simplify_text(text: str) -> str:
    """Whisper 中文经常输出繁体；默认转成简体。没装 zhconv 就原样返回。"""
    if not text:
        return text
    try:
        import zhconv
    except ImportError:
        return text
    try:
        return zhconv.convert(str(text), "zh-hans")
    except Exception:  # noqa: BLE001
        return text


def _clean_doc_text(value: str) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in text.split("\n")]
    lines = [line for line in lines if line]
    return "\n".join(lines)[:8000]


def _title_of(text: str, fallback: str) -> str:
    for line in text.split("\n"):
        line = line.strip()
        if line:
            return line[:80]
    return fallback


def extract_pdf(path: str):
    import pymupdf

    document = pymupdf.open(path)
    pages = []
    empty = []
    for index, page in enumerate(document, start=1):
        text = _clean_doc_text(page.get_text("text"))
        if not text:
            empty.append(index)
        pages.append({
            "index": index,
            "title": _title_of(text, "第 " + str(index) + " 页"),
            "text": text,
        })
        if len(pages) >= MAX_DOC_PAGES:
            break
    warning = ""
    if empty:
        warning = "第 " + "、".join(str(i) for i in empty[:8]) + " 页没有可提取文字（可能是扫描件）；"
        warning += "扫描件需要 OCR 或视觉模型才能读。"
    return pages, warning


def extract_pptx(path: str):
    from pptx import Presentation

    presentation = Presentation(path)
    pages = []
    for index, slide in enumerate(presentation.slides, start=1):
        chunks = []
        for shape in slide.shapes:
            try:
                if shape.has_text_frame:
                    value = shape.text_frame.text.strip()
                    if value:
                        chunks.append(value)
            except Exception:  # noqa: BLE001
                continue
        text = _clean_doc_text("\n".join(chunks))
        pages.append({
            "index": index,
            "title": _title_of(text, "第 " + str(index) + " 页"),
            "text": text,
        })
        if len(pages) >= MAX_DOC_PAGES:
            break
    return pages, ""


def extract_docx(path: str):
    from docx import Document

    document = Document(path)
    sections = []
    current = {"title": "", "lines": []}

    def flush():
        nonlocal current
        text = _clean_doc_text("\n".join(current["lines"]))
        if text:
            sections.append({
                "index": len(sections) + 1,
                "title": current["title"] or _title_of(text, "第 " + str(len(sections) + 1) + " 节"),
                "text": text,
            })
        current = {"title": "", "lines": []}

    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style = getattr(paragraph.style, "name", "") or ""
        is_heading = style.lower().startswith("heading") or "标题" in style
        if is_heading:
            flush()
            current["title"] = text[:80]
            current["lines"].append(text)
        else:
            current["lines"].append(text)
        if len(sections) >= MAX_DOC_PAGES:
            break
    flush()

    if not sections:
        # 没有标题样式：按段落长度切成若干「节」
        text = _clean_doc_text("\n".join(p.text.strip() for p in document.paragraphs if p.text.strip()))
        step = 2500
        for offset in range(0, min(len(text), MAX_DOC_PAGES * step), step):
            chunk = text[offset:offset + step]
            sections.append({
                "index": len(sections) + 1,
                "title": _title_of(chunk, "第 " + str(len(sections) + 1) + " 节"),
                "text": chunk,
            })
    return sections[:MAX_DOC_PAGES], ""


def extract_text(path: str):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        text = _clean_doc_text(handle.read())
    step = 3000
    pages = []
    for offset in range(0, min(len(text), MAX_DOC_PAGES * step), step):
        chunk = text[offset:offset + step]
        pages.append({
            "index": len(pages) + 1,
            "title": _title_of(chunk, "第 " + str(len(pages) + 1) + " 页"),
            "text": chunk,
        })
    return pages, ""


def convert_legacy(path: str, target_suffix: str) -> str:
    """用本机 Office 把老式 .ppt/.doc 转成 .pptx/.docx；没有 Office 就报错。"""
    output = tempfile.NamedTemporaryFile(delete=False, suffix=target_suffix).name
    script = tempfile.NamedTemporaryFile("w", delete=False, suffix=".ps1", encoding="utf-8")
    if target_suffix == ".pptx":
        script.write("""
param($src, $dst)
$ErrorActionPreference = "Stop"
$app = New-Object -ComObject PowerPoint.Application
try {
  $pres = $app.Presentations.Open($src, $true, $false, $false)
  $pres.SaveAs($dst, 24)
  $pres.Close()
} finally {
  $app.Quit()
}
""")
    else:
        script.write("""
param($src, $dst)
$ErrorActionPreference = "Stop"
$app = New-Object -ComObject Word.Application
try {
  $app.Visible = $false
  $doc = $app.Documents.Open($src, $false, $true)
  $doc.SaveAs2($dst, 16)
  $doc.Close()
} finally {
  $app.Quit()
}
""")
    script.close()
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", script.name, path, output],
            capture_output=True, timeout=180,
        )
        if result.returncode != 0 or not os.path.exists(output) or os.path.getsize(output) == 0:
            detail = (result.stderr or result.stdout or b"").decode("utf-8", "replace")[-300:]
            raise RuntimeError("本机 Office 转换失败：" + detail)
        return output
    finally:
        try:
            os.unlink(script.name)
        except OSError:
            pass


def extract_document(path: str, suffix: str):
    suffix = suffix.lower()
    source_kind = suffix.lstrip(".")
    if suffix == ".pptx":
        pages, warning = extract_pptx(path)
        return "pptx", pages, warning
    if suffix == ".pdf":
        pages, warning = extract_pdf(path)
        return "pdf", pages, warning
    if suffix == ".docx":
        pages, warning = extract_docx(path)
        return "docx", pages, warning
    if suffix in (".txt", ".md"):
        pages, warning = extract_text(path)
        return "txt", pages, warning
    if suffix == ".ppt":
        converted = convert_legacy(path, ".pptx")
        try:
            pages, warning = extract_pptx(converted)
        finally:
            try:
                os.unlink(converted)
            except OSError:
                pass
        return "pptx", pages, warning
    if suffix == ".doc":
        converted = convert_legacy(path, ".docx")
        try:
            pages, warning = extract_docx(converted)
        finally:
            try:
                os.unlink(converted)
            except OSError:
                pass
        return "docx", pages, warning
    raise RuntimeError("只支持 .pptx / .ppt / .pdf / .docx / .doc / .txt / .md")


def media_list(media_dir: str) -> list:
    if not media_dir or not os.path.isdir(media_dir):
        raise RuntimeError("没有配置 --media-dir，或目录不存在")
    files = []
    for name in os.listdir(media_dir):
        path = os.path.join(media_dir, name)
        if not os.path.isfile(path):
            continue
        if os.path.splitext(name)[1].lower() not in MEDIA_EXTS:
            continue
        try:
            stat = os.stat(path)
        except OSError:
            continue
        files.append({"name": name, "size": stat.st_size, "mtime": int(stat.st_mtime)})
    files.sort(key=lambda item: item["mtime"], reverse=True)
    return files


def resolve_media(media_dir: str, name: str) -> str:
    if not media_dir or not os.path.isdir(media_dir):
        raise RuntimeError("没有配置 --media-dir，或目录不存在")
    base = os.path.basename(str(name or ""))
    if not base or base != name:
        raise RuntimeError("只接受服务目录里的文件名，不能带路径")
    if os.path.splitext(base)[1].lower() not in MEDIA_EXTS:
        raise RuntimeError("不是支持的音视频格式")
    path = os.path.join(media_dir, base)
    root = os.path.realpath(media_dir)
    real = os.path.realpath(path)
    if os.path.commonpath([real, root]) != root:
        raise RuntimeError("文件不在服务目录里")
    if not os.path.isfile(path):
        raise RuntimeError("找不到文件：" + base)
    return path


def start_path_job(media_dir: str, name: str, language: str, model_name: str, stub: bool,
                   simplify: bool = True) -> str:
    """后台转写，立刻返回 jobId；避免一个几十分钟的 HTTP 请求被浏览器/代理掐掉。"""
    path = resolve_media(media_dir, name)
    job_id = "j" + str(int(time.time() * 1000)) + "_" + os.urandom(3).hex()
    with _jobs_lock:
        _jobs[job_id] = {"state": "running", "stage": "正在解码音频…", "started": time.time(), "filename": name}

    def run():
        try:
            if stub:
                result = transcribe_stub(language)
            else:
                with _jobs_lock:
                    _jobs[job_id]["stage"] = "正在转写音频…"
                result = transcribe_file(path, language, model_name, simplify)
            result["filename"] = name
            result["elapsed"] = round(time.time() - _jobs[job_id]["started"], 1)
            with _jobs_lock:
                _jobs[job_id].update({"state": "done", "result": result})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            with _jobs_lock:
                _jobs[job_id].update({"state": "error", "error": str(exc)})

    threading.Thread(target=run, daemon=True).start()
    return job_id


def job_status(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise RuntimeError("任务不存在或已过期")
        payload = {"ok": True, "jobId": job_id, "state": job["state"],
                   "stage": job.get("stage", ""),
                   "elapsed": round(time.time() - job["started"], 1),
                   "filename": job.get("filename", "")}
        if job["state"] == "done":
            payload["result"] = job["result"]
        if job["state"] == "error":
            payload["error"] = job.get("error", "转写失败")
        return payload


def transcribe_stub(language: str) -> dict:
    segments = [{"start": start, "end": end, "text": text} for start, end, text in STUB_SEGMENTS]
    return {
        "ok": True,
        "backend": "stub",
        "language": language or "zh",
        "duration": 120.0,
        "segments": segments,
        "srt": to_srt(segments),
        "warning": "当前是 --stub 示例字幕，没有真正转写。去掉 --stub 并安装 faster-whisper 后可用。",
    }


def download_audio_from_url(url: str, out_path: str, referer: str = "", cookie: str = "", user_agent: str = "") -> None:
    """只从 HLS/MP4 地址解出音轨，不落整段视频。PyAV 自带 FFmpeg，无需外部 ffmpeg。"""
    try:
        import av
    except ImportError as exc:
        raise RuntimeError("缺少 av 依赖，请 pip install av") from exc

    options = {}
    if referer:
        options["referer"] = str(referer)
    if cookie:
        options["headers"] = "Cookie: " + str(cookie).replace("\r", "").replace("\n", "")
    try:
        container = av.open(str(url), options=options)
    except Exception:
        raise
    try:
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise RuntimeError("这个地址里没有音频轨道")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        with wave.open(out_path, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            for frame in container.decode(stream):
                for resampled in resampler.resample(frame):
                    output.writeframes(resampled.to_ndarray().tobytes())
            for resampled in resampler.resample(None):
                output.writeframes(resampled.to_ndarray().tobytes())
    finally:
        container.close()


class _HlsKeyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003
        return

    def do_GET(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/playlist.m3u8":
            body = getattr(self.server, "playlist_bytes", b"")
            content_type = "application/vnd.apple.mpegurl"
        elif path == "/key":
            body = getattr(self.server, "key_bytes", b"")
            content_type = "application/octet-stream"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def download_audio_from_playlist(playlist_text: str, playlist_url: str,
                                 key_base64: str, out_path: str) -> None:
    """浏览器已经取到 AES key；本地起一个一次性 key 服务，让 FFmpeg 只下载公开分片。"""
    try:
        import av
    except ImportError as exc:
        raise RuntimeError("缺少 av 依赖，请 pip install av") from exc
    key = base64.b64decode(str(key_base64 or ""))
    if len(key) != 16:
        raise RuntimeError("HLS 密钥长度异常")

    key_server = ThreadingHTTPServer(("127.0.0.1", 0), _HlsKeyHandler)
    key_server.key_bytes = key
    key_server.playlist_bytes = b""
    key_port = key_server.server_address[1]
    threading.Thread(target=key_server.serve_forever, daemon=True).start()

    try:
        local_base = f"http://127.0.0.1:{key_port}"
        local_key = local_base + "/key"
        lines = []
        for line in str(playlist_text or "").splitlines():
            raw = line.strip()
            if not raw:
                lines.append("")
                continue
            if raw.startswith("#EXT-X-KEY"):
                raw = re.sub(r'URI="[^"]*"', f'URI="{local_key}"', raw)
                lines.append(raw)
            elif raw.startswith("#"):
                lines.append(raw)
            else:
                lines.append(urllib.parse.urljoin(playlist_url, raw))
        key_server.playlist_bytes = ("\n".join(lines) + "\n").encode("utf-8")

        # 本地播放列表也走 HTTP：部分 FFmpeg 构建对本地 .m3u8 的 HLS demux 支持不一致
        container = av.open(local_base + "/playlist.m3u8")
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise RuntimeError("这个地址里没有音频轨道")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        with wave.open(out_path, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            for frame in container.decode(stream):
                for resampled in resampler.resample(frame):
                    output.writeframes(resampled.to_ndarray().tobytes())
            for resampled in resampler.resample(None):
                output.writeframes(resampled.to_ndarray().tobytes())
    finally:
        if container is not None:
            container.close()
        key_server.shutdown()
        key_server.server_close()


def start_url_job(url: str, name: str, language: str, model_name: str, stub: bool,
                  simplify: bool = True, referer: str = "", cookie: str = "", user_agent: str = "",
                  playlist_text: str = "", key_base64: str = "") -> str:
    """从 URL 只取音频再转写；适合扩展截获到的 HLS 地址。"""
    job_id = "j" + str(int(time.time() * 1000)) + "_" + os.urandom(3).hex()
    display_name = name or "课堂录像"
    with _jobs_lock:
        _jobs[job_id] = {
            "state": "running",
            "stage": "正在连接视频源…",
            "started": time.time(),
            "filename": display_name,
        }

    def run():
        temp_path = None
        try:
            if stub:
                result = transcribe_stub(language)
            else:
                suffix = ".wav"
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
                    temp_path = temp.name
                with _jobs_lock:
                    _jobs[job_id]["stage"] = "正在下载音频…"
                if playlist_text and key_base64:
                    download_audio_from_playlist(playlist_text, url, key_base64, temp_path)
                else:
                    download_audio_from_url(url, temp_path, referer=referer, cookie=cookie, user_agent=user_agent)
                with _jobs_lock:
                    _jobs[job_id]["stage"] = "正在转写音频…"
                result = transcribe_file(temp_path, language, model_name, simplify)
            result["filename"] = display_name
            result["elapsed"] = round(time.time() - _jobs[job_id]["started"], 1)
            with _jobs_lock:
                _jobs[job_id].update({"state": "done", "stage": "完成", "result": result})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            message = str(exc)
            if "401" in message or "unauthorized" in message.lower():
                message = "视频源需要登录态（HLS key 401）；请刷新播放页后重试，或改用「转写本机视频」"
            elif "invalid data" in message.lower() or "immediate exit" in message.lower():
                message = "视频源解析失败或需要登录态；请刷新播放页后重试，或改用「转写本机视频」"
            with _jobs_lock:
                _jobs[job_id].update({"state": "error", "error": message})
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    threading.Thread(target=run, daemon=True).start()
    return job_id


def transcribe_file(path: str, language: str, model_name: str, simplify: bool = True) -> dict:
    global _cuda_failed
    with _model_lock:
        if importlib.util.find_spec("faster_whisper") is not None:
            requested_model = resolve_model_name(model_name or _RUNTIME["model"])
            device = resolve_device(_RUNTIME["device"])
            compute_type = resolve_compute_type(_RUNTIME["compute_type"], device)
            candidates = [(requested_model, device, compute_type)]
            if device == "cuda":
                candidates.append((requested_model, "cpu", "int8"))
            if requested_model != "base":
                candidates.append(("base", "cpu", "int8"))

            last_error = None
            seen = set()
            for name, dev, compute in candidates:
                signature = (name, dev, compute)
                if signature in seen:
                    continue
                seen.add(signature)
                try:
                    model, loaded_model, loaded_device, loaded_compute = load_whisper_model(
                        name, dev, compute,
                    )
                    segments_iter, info = model.transcribe(
                        path,
                        language=None if language in ("", "auto") else language,
                        vad_filter=True,
                        beam_size=5,
                    )
                    segments = []
                    for seg in segments_iter:
                        text = seg.text.strip()
                        if not text:
                            continue
                        segments.append({
                            "start": float(seg.start),
                            "end": float(seg.end),
                            "text": simplify_text(text) if simplify else text,
                        })
                    return {
                        "ok": True,
                        "backend": "faster-whisper",
                        "model": loaded_model,
                        "requested_model": requested_model,
                        "device": loaded_device,
                        "compute_type": loaded_compute,
                        "language": getattr(info, "language", language or ""),
                        "duration": float(getattr(info, "duration", 0.0) or 0.0),
                        "segments": segments,
                        "srt": to_srt(segments),
                    }
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    message = str(exc).lower()
                    if "cublas" in message or "cudnn" in message or "cuda" in message:
                        _cuda_failed = True
                    print(f"[whisper] transcribe failed: model={name} device={dev} compute={compute}: {exc}",
                          file=sys.stderr)
            raise RuntimeError("转写失败：" + str(last_error or "未知错误"))

        if importlib.util.find_spec("whisper") is not None:
            import whisper

            key = ("whisper", model_name)
            model = _models.get(key)
            if model is None:
                model = whisper.load_model(model_name)
                _models[key] = model
            result = model.transcribe(path, fp16=False, language=None if language in ("", "auto") else language)
            segments = []
            for seg in result.get("segments", []):
                text = str(seg.get("text", "")).strip()
                if not text:
                    continue
                segments.append({
                    "start": float(seg["start"]),
                    "end": float(seg["end"]),
                    "text": simplify_text(text) if simplify else text,
                })
            return {
                "ok": True,
                "backend": "whisper",
                "language": result.get("language", language or ""),
                "duration": float(result.get("duration", 0.0) or 0.0),
                "segments": segments,
                "srt": to_srt(segments),
            }

        raise RuntimeError(
            "没有可用的 Whisper 后端。请在 whisper_service 目录运行："
            " .venv\\Scripts\\pip install faster-whisper（或 pip install openai-whisper），"
            " 然后重启服务；只想联调可以先加 --stub。"
        )


def render_pdf(html: str):
    """用 PyMuPDF Story 直接排版成 PDF，不启动浏览器。"""
    body = str(html or "")
    if not body.strip():
        raise RuntimeError("讲义 HTML 为空")
    import pymupdf  # noqa: PLC0415

    css = """
    body { font-family: "Times New Roman", "SimSun", "宋体", serif; font-size: 10.5pt;
           line-height: 1.7; color: #1f2933; }
    h1 { font-size: 22pt; color: #C0564A; margin: 0 0 6pt 0; }
    h2 { font-size: 15pt; color: #2E5A78; margin: 14pt 0 4pt 0; }
    h3 { font-size: 12pt; color: #2E5A78; margin: 10pt 0 3pt 0; }
    p { margin: 0 0 6pt 0; }
    ul, ol { margin: 0 0 6pt 0; padding-left: 16pt; }
    li { margin: 0 0 3pt 0; }
    .meta { color: #6b7a88; font-size: 9.5pt; }
    .intuition { background-color: #FFF8E8; border-left: 3pt solid #E5A83B;
                 padding: 5pt 8pt; margin: 6pt 0 8pt 0; color: #7A5310; }
    .box { background-color: #F2F8F4; border: 1pt solid #CFE5D6;
           padding: 6pt 8pt; margin: 6pt 0; }
    .pitfall { background-color: #FDF3F1; border: 1pt solid #F1D5CF;
               padding: 6pt 8pt; margin: 6pt 0; }
    .takeaway { background-color: #F1F6FA; padding: 5pt 8pt; margin: 6pt 0;
                font-weight: bold; color: #2E5A78; }
    table { border-collapse: collapse; width: 100%; margin: 6pt 0; }
    th, td { border: 1pt solid #DCE3EB; padding: 3pt 5pt; text-align: left;
             font-size: 9.5pt; }
    th { background-color: #F1F6FA; color: #2E5A78; }
    .term { border: 1pt solid #DCE3EB; padding: 5pt 7pt; margin: 0 0 5pt 0; }
    .notice { background-color: #FDF3F1; border: 1pt solid #F1D5CF;
              padding: 5pt 8pt; margin: 0 0 8pt 0; color: #A54236; font-size: 9.5pt; }
    .cover-meta { color: #8a97a6; font-size: 9pt; margin: 4pt 0 10pt 0; }
    .audience { color: #A54236; font-size: 9pt; }
    """
    temp_dir = Path(tempfile.mkdtemp(prefix="prn-pdf-"))
    try:
        out_path = temp_dir / "handout.pdf"
        story = pymupdf.Story(html=body, user_css=css)
        writer = pymupdf.DocumentWriter(str(out_path))

        def rectfn(rect_num, filled):
            page = pymupdf.paper_rect("a4")
            return page, page + (42, 42, -42, -42), None

        story.write(writer, rectfn)
        writer.close()
        if not out_path.exists() or out_path.stat().st_size <= 100:
            raise RuntimeError("PDF 生成失败")
        data = out_path.read_bytes()
        doc = pymupdf.open(stream=data, filetype="pdf")
        pages = doc.page_count
        doc.close()
        if pages <= 0:
            raise RuntimeError("生成的 PDF 没有页面")
        return data, pages
    finally:
        # PyMuPDF 在 Windows 上可能稍后才释放文件句柄；清理失败不影响返回
        shutil.rmtree(temp_dir, ignore_errors=True)

class Handler(BaseHTTPRequestHandler):
    server_version = "PRNWhisper/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write("[whisper] " + (fmt % args) + "\n")

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            status = backend_status()
            status.update({
                "ok": True,
                "stub": self.server.stub,
                "model": self.server.model,
                "device": _RUNTIME["device"],
                "compute_type": _RUNTIME["compute_type"],
                "port": self.server.server_address[1],
                "media_dir": self.server.media_dir or "",
                "keep_traditional": self.server.keep_traditional,
                "documents": {
                    "pdf": importlib.util.find_spec("pymupdf") is not None,
                    "docx": importlib.util.find_spec("docx") is not None,
                    "pptx": importlib.util.find_spec("pptx") is not None,
                },
                "pdf_export": importlib.util.find_spec("pymupdf") is not None,
            })
            return self.send_json(200, status)
        if parsed.path == "/media":
            try:
                files = media_list(self.server.media_dir)
            except Exception as exc:  # noqa: BLE001
                return self.send_json(400, {"ok": False, "error": str(exc)})
            return self.send_json(200, {
                "ok": True,
                "dir": self.server.media_dir,
                "files": files,
            })
        if parsed.path == "/job":
            job_id = (urllib.parse.parse_qs(parsed.query).get("id") or [""])[0]
            try:
                return self.send_json(200, job_status(job_id))
            except Exception as exc:  # noqa: BLE001
                return self.send_json(404, {"ok": False, "error": str(exc)})
        if parsed.path == "/":
            return self.send_json(200, {"ok": True, "service": "prn-whisper"})
        return self.send_json(404, {"ok": False, "error": "not found"})

    def handle_document(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        filename = (query.get("filename") or ["document.pptx"])[0]
        suffix = os.path.splitext(filename)[1].lower()
        if suffix not in DOC_EXTS:
            return self.send_json(400, {
                "ok": False,
                "error": "只支持 .pptx / .ppt / .pdf / .docx / .doc / .txt / .md",
            })
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.send_json(400, {"ok": False, "error": "bad content-length"})
        if length <= 0 or length > MAX_DOC_BYTES:
            return self.send_json(413, {"ok": False, "error": "文件为空或超过 200MB"})

        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
                temp_path = temp.name
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    temp.write(chunk)
                    remaining -= len(chunk)
            kind, pages, warning = extract_document(temp_path, suffix)
            return self.send_json(200, {
                "ok": True,
                "kind": kind,
                "source_kind": suffix.lstrip("."),
                "name": filename,
                "pages": pages,
                "warning": warning,
            })
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.send_json(500, {"ok": False, "error": str(exc)})
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    def handle_simplify(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 4 * 1024 * 1024:
                return self.send_json(413, {"ok": False, "error": "请求体为空或过大"})
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            texts = payload.get("texts")
            if not isinstance(texts, list) or len(texts) > 5000:
                return self.send_json(400, {"ok": False, "error": "texts 必须是数组且不超过 5000 条"})
            converted = [simplify_text(str(text)) for text in texts]
            return self.send_json(200, {
                "ok": True,
                "texts": converted,
                "zhconv": importlib.util.find_spec("zhconv") is not None,
            })
        except Exception as exc:  # noqa: BLE001
            return self.send_json(400, {"ok": False, "error": str(exc)})

    def handle_transcribe_url(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 256 * 1024:
                return self.send_json(413, {"ok": False, "error": "请求体为空或过大"})
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            url = str(payload.get("url") or "").strip()
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or len(url) > 8192:
                return self.send_json(400, {"ok": False, "error": "只支持有效的 http/https 视频地址"})
            name = str(payload.get("name") or "课堂录像").strip()[:120]
            language = str(payload.get("language") or "auto")
            job_id = start_url_job(
                url, name, language, self.server.model,
                self.server.stub, not self.server.keep_traditional,
                referer=str(payload.get("referer") or ""),
                cookie=str(payload.get("cookie") or ""),
                user_agent=str(payload.get("user_agent") or ""),
                playlist_text=str(payload.get("playlist_text") or ""),
                key_base64=str(payload.get("key_base64") or ""),
            )
            return self.send_json(200, {"ok": True, "jobId": job_id, "filename": name})
        except Exception as exc:  # noqa: BLE001
            return self.send_json(400, {"ok": False, "error": str(exc)})

    def handle_transcribe_path(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 1024 * 1024:
                return self.send_json(413, {"ok": False, "error": "请求体为空或过大"})
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            name = str(payload.get("name") or "")
            language = str(payload.get("language") or "auto")
            job_id = start_path_job(self.server.media_dir, name, language, self.server.model,
                                    self.server.stub, not self.server.keep_traditional)
            return self.send_json(200, {"ok": True, "jobId": job_id, "filename": name})
        except Exception as exc:  # noqa: BLE001
            return self.send_json(400, {"ok": False, "error": str(exc)})

    def handle_pdf(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.send_json(400, {"ok": False, "error": "bad content-length"})
        if length <= 0 or length > 20 * 1024 * 1024:
            return self.send_json(400, {"ok": False, "error": "HTML 为空或超过 20MB"})
        try:
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
                html = payload.get("html", "") if isinstance(payload, dict) else ""
            except (UnicodeDecodeError, json.JSONDecodeError):
                html = raw.decode("utf-8", "replace")
            if not str(html).strip():
                return self.send_json(400, {"ok": False, "error": "讲义 HTML 为空"})
            pdf, pages = render_pdf(str(html))
            return self.send_json(200, {
                "ok": True,
                "pages": pages,
                "bytes": len(pdf),
                "pdfBase64": base64.b64encode(pdf).decode("ascii"),
            })
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.send_json(500, {"ok": False, "error": str(exc)})

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/transcribe-path":
            return self.handle_transcribe_path()
        if parsed.path == "/transcribe-url":
            return self.handle_transcribe_url()
        if parsed.path == "/document":
            return self.handle_document()
        if parsed.path == "/pdf":
            return self.handle_pdf()
        if parsed.path == "/simplify":
            return self.handle_simplify()
        if parsed.path != "/transcribe":
            return self.send_json(404, {"ok": False, "error": "not found"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.send_json(400, {"ok": False, "error": "bad content-length"})
        if length <= 0 or length > MAX_UPLOAD:
            return self.send_json(413, {"ok": False, "error": "文件为空或超过 1GB"})

        query = urllib.parse.parse_qs(parsed.query)
        filename = (query.get("filename") or ["audio.mp4"])[0]
        language = (query.get("language") or ["auto"])[0]
        model_name = (query.get("model") or [self.server.model])[0]
        suffix = os.path.splitext(filename)[1] or ".mp4"
        if len(suffix) > 8:
            suffix = ".mp4"

        if self.server.stub:
            # 仍读完 body，避免客户端连接被重置
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                remaining -= len(chunk)
            return self.send_json(200, transcribe_stub(language))

        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
                temp_path = temp.name
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    temp.write(chunk)
                    remaining -= len(chunk)
            started = time.time()
            result = transcribe_file(temp_path, language, model_name, not self.server.keep_traditional)
            result["elapsed"] = round(time.time() - started, 1)
            result["filename"] = filename
            return self.send_json(200, result)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.send_json(500, {"ok": False, "error": str(exc)})
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass


def main():
    parser = argparse.ArgumentParser(description="课堂录音转字幕的本地服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default="auto",
                        help="auto / tiny / base / small / medium / large-v3 / large-v3-turbo"
                             "（auto：GPU 用 small，CPU 用 base，控制安装体积）")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"],
                        help="自动检测 CUDA；没有 NVIDIA GPU 时回退 CPU")
    parser.add_argument("--compute-type", default="auto",
                        help="auto / int8 / float16 / int8_float16")
    parser.add_argument("--stub", action="store_true", help="不转写，返回示例字幕，用于联调")
    parser.add_argument("--media-dir", default="", help="允许直接转写的本地目录（如桌面），不传则禁用 /media")
    parser.add_argument("--keep-traditional", action="store_true", help="保留 Whisper 输出的繁体（默认转简体）")
    args = parser.parse_args()

    status = backend_status()
    if not args.stub and status["backend"] == "none":
        print("警告：没有安装 Whisper 后端，服务只能以 --stub 运行。", file=sys.stderr)
        print("      pip install faster-whisper", file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.stub = args.stub
    server.model = args.model
    server.media_dir = os.path.abspath(args.media_dir) if args.media_dir else ""
    server.keep_traditional = args.keep_traditional
    _RUNTIME.update({
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
    })
    resolved_device = "cpu" if args.stub else resolve_device(args.device)
    resolved_model = args.model if args.model != "auto" else auto_model_name()
    print(f"PRN whisper service on http://{args.host}:{args.port}  model={args.model}  stub={args.stub}", flush=True)
    print(f"backend={status['backend']}  device={resolved_device}  resolved_model={resolved_model}  "
          f"cuda={status['cuda']}({status['gpu_name'] or 'none'})  ffmpeg={status['ffmpeg']}  "
          f"zhconv={status['zhconv']}  media_dir={server.media_dir or '(disabled)'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
