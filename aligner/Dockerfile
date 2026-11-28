# Word-level ASR sidecar for the Audiobookshelf connector.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /aligner
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Model cache; mount a volume so a restart does not re-download it.
ENV WHISPER_MODEL_DIR=/models
VOLUME ["/models"]

COPY app.py .
EXPOSE 8080

# One transcription at a time (the service serializes jobs), so one worker.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
