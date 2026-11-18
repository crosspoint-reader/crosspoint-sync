"""Local ASR sidecar for crosspoint-sync's word-level Audiobookshelf alignment.

Downloads one audio file, transcribes it with faster-whisper, and answers with
word timestamps. All the matching against the EPUB happens in the Node service,
so this stays a dumb, dependency-light "audio in, timestamps out" worker.

Split with ffmpeg first: whisper's memory and time scale with file length, and
an audiobook chapter is cheap to stream while a 20-hour m4b is not.
"""

import os
import subprocess
import tempfile
import threading
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR", "/models")
# 30 minutes per chunk keeps CPU memory flat and bounds retry cost.
CHUNK_SECONDS = int(os.environ.get("WHISPER_CHUNK_SECONDS", "1800"))
MAX_BYTES = int(os.environ.get("ALIGNER_MAX_BYTES", str(4 * 1024**3)))

app = FastAPI()
# faster-whisper models are not safe to run concurrently; the sync service also
# hands out one job at a time.
_lock = threading.Lock()
_model: WhisperModel | None = None


def model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE_TYPE, download_root=MODEL_DIR)
    return _model


class Source(BaseModel):
    url: str
    headers: dict[str, str] = Field(default_factory=dict)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None}


def download(url: str, headers: dict[str, str], target: Path) -> Path:
    try:
        with httpx.stream("GET", url, headers=headers, follow_redirects=True, timeout=60) as response:
            response.raise_for_status()
            size = 0
            with target.open("wb") as out:
                for block in response.iter_bytes(1 << 20):
                    size += len(block)
                    if size > MAX_BYTES:
                        raise HTTPException(413, f"audio file exceeds {MAX_BYTES} bytes")
                    out.write(block)
    except httpx.HTTPError as err:
        raise HTTPException(502, f"audio download failed: {err}") from err
    return target


def probe_ms(path: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return round(float(out) * 1000)


def chunks(path: Path, workdir: Path) -> list[tuple[Path, int]]:
    """(file, start offset ms) pairs. Short files stay whole."""
    if probe_ms(path) <= CHUNK_SECONDS * 1000:
        return [(path, 0)]
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path), "-f", "segment",
         "-segment_time", str(CHUNK_SECONDS), "-reset_timestamps", "1",
         "-c:a", "libmp3lame", "-q:a", "5", str(workdir / "chunk%04d.mp3")],
        check=True,
    )
    parts = sorted(workdir.glob("chunk*.mp3"))
    result: list[tuple[Path, int]] = []
    offset = 0
    for part in parts:
        result.append((part, offset))
        offset += probe_ms(part)
    return result


def transcribe_file(path: Path) -> list[dict]:
    segments, _ = model().transcribe(
        str(path), language=LANGUAGE, word_timestamps=True, vad_filter=True,
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append({"word": text, "start_ms": round(word.start * 1000), "end_ms": round(word.end * 1000)})
    return words


@app.post("/transcribe")
def transcribe(source: Source) -> dict:
    with _lock, tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        audio = download(source.url, source.headers, workdir / "audio.bin")
        words = []
        try:
            for part, offset in chunks(audio, workdir):
                for word in transcribe_file(part):
                    words.append({
                        "word": word["word"],
                        "start_ms": word["start_ms"] + offset,
                        "end_ms": word["end_ms"] + offset,
                    })
        except subprocess.CalledProcessError as err:
            raise HTTPException(500, f"ffmpeg split failed: {err}") from err
        return {"words": words}
