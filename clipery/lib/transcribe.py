#!/usr/bin/env python3
"""PocketSphinx speech transcriber for Clipery karaoke subtitles.

Usage: transcribe.py <input media> <output> [start_offset_sec]

- Converts input to 16k mono wav itself (via ffmpeg) when needed.
- Decodes in 20s blocks for reliability, keeping global timestamps.
- Output .json  -> word-level timings: {"words":[{"w":"hello","s":0.1,"e":0.4}, ...]}
  (used to build TikTok-style karaoke captions: word by word, left to right)
- Output .srt   -> legacy phrase-level SRT (kept for compatibility)

Requires: pip install pocketsphinx
"""
import json
import os
import re
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


def clean_word(piece: str):
    """Drop engine control tokens (<s>, </s>, <sil>, [sil], [NOISE], +filler+)
    and pronunciation suffixes like hello(2). Returns None for junk."""
    piece = re.sub(r"\(\d+\)$", "", piece).strip()
    if not piece:
        return None
    if piece.startswith(("<", "[", "+")):
        return None
    if not any(ch.isalnum() for ch in piece):
        return None
    return piece


def transcribe(wav_path: str, offset: float = 0.0):
    """Returns (entries, words):
    entries = phrase-level [[start, end, text], ...] (for legacy SRT)
    words   = [{"w": word, "s": start, "e": end}, ...] word-level timings"""
    from pocketsphinx import Decoder

    decoder = Decoder()
    entries = []
    words = []

    with wave.open(wav_path, "rb") as w:
        fr = w.getframerate()
        sw = w.getsampwidth()
        nc = w.getnchannels()
        chunk_sec = 20
        chunk_frames = fr * chunk_sec
        base = 0.0
        while True:
            data = w.readframes(chunk_frames)
            if not data:
                break
            decoder.start_utt()
            decoder.process_raw(data, False, False)
            decoder.end_utt()
            seg_text = []
            seg_start = None
            seg_end = None
            for seg in decoder.seg():
                for piece in seg.word.strip().split():
                    word = clean_word(piece)
                    if word is None:
                        continue
                    ws = base + seg.start_frame / 100.0 + offset
                    we = base + seg.end_frame / 100.0 + offset
                    words.append({"w": word, "s": round(ws, 3), "e": round(we, 3)})
                    if seg_start is None:
                        seg_start = ws
                    seg_end = we
                    seg_text.append(word)
            if seg_text:
                entries.append([seg_start, seg_end, " ".join(seg_text)])
            base += len(data) / float(sw * nc * fr)

    # timing sanity: monotonic, minimum duration
    prev = 0.0
    for wd in words:
        if wd["s"] < prev - 0.05:
            wd["s"] = round(prev, 3)
        if wd["e"] <= wd["s"]:
            wd["e"] = round(wd["s"] + 0.12, 3)
        prev = wd["e"]
    return entries, words


def chunk_captions(entries, max_dur=4.0, max_chars=42):
    out = []
    for start, end, text in entries:
        if not text:
            continue
        wrds = text.split()
        if not wrds:
            continue
        dur = max(end - start, 0.4)
        chunks = []
        cur = []
        for word in wrds:
            cur.append(word)
            if dur > max_dur and len(cur) >= max(1, int(len(wrds) * max_dur / dur)):
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
    entries, words = transcribe(tmp, offset)
    try:
        os.unlink(tmp)
    except OSError:
        pass

    if dst.lower().endswith(".json"):
        with open(dst, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "words": words}, f)
        print(f"words={len(words)}")
    else:
        captions = chunk_captions(entries)
        with open(dst, "w", encoding="utf-8") as f:
            for i, (cs, ce, text) in enumerate(captions, 1):
                f.write(f"{i}\n{srt_ts(cs)} --> {srt_ts(ce)}\n{text}\n\n")
        print(f"srt-entries={len(captions)}")


if __name__ == "__main__":
    main()
