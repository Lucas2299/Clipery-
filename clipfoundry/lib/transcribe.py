#!/usr/bin/env python3
"""PocketSphinx speech-to-SRT transcriber for Clipery subtitles.

Usage: transcribe.py <input media> <output.srt> [start_offset_sec]

- Converts input to 16k mono wav itself (via ffmpeg) when needed.
- Decodes in 20s blocks for reliability, keeping global timestamps.
- Emits phrase-level SRT (speech segments between silences), then re-chunks
  long phrases into short TikTok-style caption blocks (<=4s, <=42 chars).

Requires: pip install pocketsphinx
"""
import os
import subprocess
import sys
import wave


def to_wav(src: str, dst: str) -> None:
    if src.lower().endswith(".wav"):
        try:
            with wave.open(src, "rb") as w:
                if w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2:
                    if os.path.abspath(src) != os.path.abspath(dst):
                        subprocess.run(["cp", src, dst], check=True)
                    return
        except Exception:
            pass
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", dst],
        check=True,
    )


def srt_ts(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def transcribe(wav_path: str, offset: float = 0.0):
    from pocketsphinx import Decoder

    decoder = Decoder()
    entries = []

    with wave.open(wav_path, "rb") as w:
        fr = w.getframerate()
        sw = w.getsampwidth()
        nc = w.getnchannels()
        chunk_sec = 20
        chunk_frames = fr * chunk_sec
        base = 0.0
        special = {"<s>", "</s>", "<sil>", "[sil]", "<unk>", "[SPEECH]", "[NOISE]"}
        while True:
            data = w.readframes(chunk_frames)
            if not data:
                break
            decoder.start_utt()
            decoder.process_raw(data, False, False)
            decoder.end_utt()
            for seg in decoder.seg():
                start = base + seg.start_frame / 100.0
                end = base + seg.end_frame / 100.0
                # drop engine control tokens (sentence markers, silence, unknown)
                words = [w for w in seg.word.strip().split() if w not in special]
                text = " ".join(words).strip()
                if text:
                    entries.append([start + offset, end + offset, text])
            base += len(data) / float(sw * nc * fr)
    return entries


def chunk_captions(entries, max_dur=4.0, max_chars=42):
    out = []
    for start, end, text in entries:
        if not text:
            continue
        words = text.split()
        if not words:
            continue
        dur = max(end - start, 0.4)
        chunks = []
        cur = []
        for word in words:
            cur.append(word)
            if dur > max_dur and len(cur) >= max(1, int(len(words) * max_dur / dur)):
                chunks.append(cur)
                cur = []
            elif len(" ".join(cur)) > max_chars:
                chunks.append(cur)
                cur = []
        if cur:
            chunks.append(cur)
        n = len(chunks)
        for i, ch in enumerate(chunks):
            cs = start + dur * i / n
            ce = start + dur * (i + 1) / n
            out.append((cs, ce, " ".join(ch)))
    return out


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    offset = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    tmp = dst + ".16k.wav"
    to_wav(src, tmp)
    entries = transcribe(tmp, offset)
    captions = chunk_captions(entries)
    with open(dst, "w", encoding="utf-8") as f:
        for i, (cs, ce, text) in enumerate(captions, 1):
            f.write(f"{i}\n{srt_ts(cs)} --> {srt_ts(ce)}\n{text}\n\n")
    try:
        os.unlink(tmp)
    except OSError:
        pass
    print(f"srt-entries={len(captions)}")


if __name__ == "__main__":
    main()
