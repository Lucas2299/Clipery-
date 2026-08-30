#!/usr/bin/env python3
"""Face-follow helper for Clipery: find the speaker's face centre X (0..1).

Usage: facedetect.py <media> <start_sec> <end_sec>
Prints JSON: {"ok": true, "x": 0.62, "faces": 9}  — median face centre fraction,
or {"ok": false, "reason": "..."} when there is nothing to lock onto.

The crop in clipEngine then centres the 9:16 frame on that point, so the
camera quietly follows the speaker instead of cropping dead centre.

Requires: pip install opencv-python-headless
"""
import json
import sys


def main() -> None:
    src, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    try:
        import cv2
    except Exception:
        print(json.dumps({"ok": False, "reason": "no-cv2"}))
        return

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "reason": "open-failed"}))
        return

    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    xs = []
    total = max(0.2, end - start)
    step = max(0.5, total / 12.0)  # ~12 samples per clip is plenty
    t = start
    while t < end:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            t += step
            continue
        small_w = 384  # small for speed, but big enough for mid-distance faces
        small = cv2.resize(frame, (small_w, max(1, int(frame.shape[0] * small_w / frame.shape[1]))))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=3, minSize=(18, 18))
        if len(faces):
            fx, fy, fw, fh = max(faces, key=lambda r: r[2] * r[3])  # biggest face = the speaker
            xs.append((fx + fw / 2) / small.shape[1])
        t += step
    cap.release()

    if not xs:
        print(json.dumps({"ok": False, "reason": "no-faces"}))
        return
    xs.sort()
    print(json.dumps({"ok": True, "x": round(xs[len(xs) // 2], 4), "faces": len(xs)}))


if __name__ == "__main__":
    main()
