#!/usr/bin/env python3
"""直接转写本机的音视频文件（不经过浏览器、不上传），输出 SRT。

为什么需要它：
  - 教学网下载的 `.ts` 往往 1–2GB，超过扩展开玩笑般的上传上限；
  - 这个脚本让 Whisper 直接读本地文件（faster-whisper 用 PyAV 解码，不需要 ffmpeg），
    转完把生成的 `.srt` 拖回扩展「字幕 → 导入 SRT/VTT」即可。

用法：
  python transcribe_file.py "D:\\lectures\\lecture-01.ts" --model small
  python transcribe_file.py lecture.mp4 --language zh --model base --output lecture.srt

依赖：
  pip install faster-whisper     # 推荐
  # 或 pip install openai-whisper（需要 ffmpeg）
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import time
from pathlib import Path

# Windows 用户目录的 .cache 可能没有写权限；把模型缓存放到服务目录里
_CACHE = Path(__file__).resolve().parent / ".cache"
_CACHE.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HF_HOME", str(_CACHE))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(_CACHE / "hub"))


def srt_time(seconds: float) -> str:
    value = max(0.0, float(seconds))
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    secs = int(value % 60)
    millis = int(round((value - int(value)) * 1000))
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def simplify_text(text: str) -> str:
    try:
        import zhconv
    except ImportError:
        return text
    try:
        return zhconv.convert(str(text), "zh-hans")
    except Exception:  # noqa: BLE001
        return text


def write_srt(segments, path: str, simplify: bool = True) -> int:
    count = 0
    with open(path, "w", encoding="utf-8") as out:
        for start, end, text in segments:
            text = (text or "").strip().replace("-->", "->")
            if simplify:
                text = simplify_text(text)
            if not text:
                continue
            count += 1
            out.write(f"{count}\n{srt_time(start)} --> {srt_time(end)}\n{text}\n\n")
    return count


def run_faster_whisper(path, model_name, language):
    from faster_whisper import WhisperModel

    print(f"加载 faster-whisper 模型 {model_name}（首次会下载）...", flush=True)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(
        path,
        language=None if language in ("", "auto") else language,
        vad_filter=True,
        beam_size=5,
    )
    print(f"语言={getattr(info, 'language', language)} 时长={getattr(info, 'duration', 0):.1f}s", flush=True)
    started = time.time()
    count = 0
    for segment in segments_iter:
        count += 1
        text = segment.text.strip()
        if count % 20 == 0 or count == 1:
            print(f"[{count}] {srt_time(segment.start)} {text[:40]}", flush=True)
        yield float(segment.start), float(segment.end), text
    print(f"共 {count} 段，用时 {time.time() - started:.0f}s", flush=True)


def run_openai_whisper(path, model_name, language):
    import whisper

    print(f"加载 openai-whisper 模型 {model_name}（需要 ffmpeg）...", flush=True)
    model = whisper.load_model(model_name)
    result = model.transcribe(path, fp16=False, language=None if language in ("", "auto") else language)
    for segment in result.get("segments", []):
        yield float(segment["start"]), float(segment["end"]), str(segment.get("text", "")).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description="本机音视频转 SRT（不经浏览器上传）")
    parser.add_argument("input", help="音视频文件路径，支持 .ts/.mp4/.mkv/.m4a/.mp3 等")
    parser.add_argument("--model", default="base", help="tiny / base / small / medium")
    parser.add_argument("--language", default="zh", help="zh / en / auto")
    parser.add_argument("--output", default="", help="输出 SRT 路径；默认与输入同名")
    parser.add_argument("--keep-traditional", action="store_true", help="保留繁体（默认转简体）")
    args = parser.parse_args()

    path = os.path.abspath(args.input)
    if not os.path.isfile(path):
        sys.exit(f"找不到文件：{path}")
    output = args.output or (os.path.splitext(path)[0] + ".srt")

    if importlib.util.find_spec("faster_whisper") is not None:
        segments = run_faster_whisper(path, args.model, args.language)
    elif importlib.util.find_spec("whisper") is not None:
        segments = run_openai_whisper(path, args.model, args.language)
    else:
        sys.exit(
            "没有可用的 Whisper 后端。请先运行：\n"
            '  .venv\\Scripts\\pip install faster-whisper\n'
            "（或 pip install openai-whisper，并安装 ffmpeg）"
        )

    count = write_srt(segments, output, simplify=not args.keep_traditional)
    if count == 0:
        print("\n没有识别到字幕：这段可能没有语音（比如开头是静音），或音频流有问题。")
    print(f"\n完成：{output}（{count} 条字幕）")


if __name__ == "__main__":
    main()
