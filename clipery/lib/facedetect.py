#!/usr/bin/env python3
"""Face-follow helper for Clipery: find the speaker's face centre X (0..1).

Usage: facedetect.py <media> <start_sec> <end_sec>
Prints JSON: {"ok": true, "x": 0.62, "faces": 9}  — median face centre fraction,
or {"ok": false, "reason": "..."} when there is nothing to lock onto.

The crop in clipEngine then centres the 9:16 frame on that point, so the
camera follows whoever is talking (A -> B -> A) instead of staying nailed
to the centre of the frame.

The full answer also carries a TRACK, so the crop can move over time:

  {"ok": true,
   "x": 0.62,                                  <- median centre (old callers)
   "faces": 9,                                 <- samples that saw a face
   "speakers": 2,                              <- distinct people found
   "spread": 0.41,                             <- how far apart they sit (0..1)
   "track": [{"t": 0.0, "x": 0.31, "faces": 2, "xs": [0.31, 0.74]}, ...]}

The engine turns `track` into a moving crop, so the camera follows whoever is
talking (A -> B -> A) instead of staying nailed to the centre.

Requires: pip install opencv-python-headless
"""
import json
import sys


def cluster(xs, gap=0.18):
    """Group face positions into speakers sitting at different spots."""
    if not xs:
        return []
    xs = sorted(xs)
    groups = [[xs[0]]]
    for x in xs[1:]:
        if x - groups[-1][-1] <= gap:
            groups[-1].append(x)
        else:
            groups.append([x])
    return groups


def main() -> None:
    src, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    per_sec = float(sys.argv[4]) if len(sys.argv) > 4 else 2.5

    try:
        import cv2
    except Exception:
        print(json.dumps({"ok": False, "reason": "no-cv2"}))
        return

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "reason": "open-failed"}))
        return

    haar = cv2.data.haarcascades
    frontal = cv2.CascadeClassifier(haar + "haarcascade_frontalface_default.xml")
    profile = cv2.CascadeClassifier(haar + "haarcascade_profileface.xml")

    total = max(0.2, end - start)
    step = max(0.25, 1.0 / max(0.5, per_sec))
    # Keep the work bounded on long clips.
    if total / step > 240:
        step = total / 240.0

    track = []
    all_x = []
    last_x = None
    t = start
    while t < end:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            t += step
            continue

        small_w = 384
        small = cv2.resize(frame, (small_w, max(1, int(frame.shape[0] * small_w / frame.shape[1]))))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)

        faces = list(frontal.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(18, 18)))
        if not faces:
            # Someone turned to the side - a profile is still a person.
            faces = list(profile.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(18, 18)))
            if not faces:
                flipped = cv2.flip(gray, 1)
                for (fx, fy, fw, fh) in profile.detectMultiScale(flipped, scaleFactor=1.1, minNeighbors=4, minSize=(18, 18)):
                    faces.append((small_w - fx - fw, fy, fw, fh))

        if faces:
            centres = [((fx + fw / 2.0) / small.shape[1], fw * fh) for (fx, fy, fw, fh) in faces]
            # Who is the subject right now? Biggest face wins, but if two faces
            # are a similar size we stay with whoever we were already watching -
            # that keeps the camera from flicking back and forth every frame.
            centres.sort(key=lambda c: c[1], reverse=True)
            best_x, best_area = centres[0]
            if last_x is not None and len(centres) > 1:
                for cx, area in centres[1:]:
                    if area >= best_area * 0.72 and abs(cx - last_x) < abs(best_x - last_x):
                        best_x, best_area = cx, area
                        break
            last_x = best_x
            all_x.extend([c[0] for c in centres])
            track.append({
                "t": round(t - start, 2),
                "x": round(best_x, 4),
                "faces": len(faces),
                "xs": sorted(round(c[0], 4) for c in centres),
            })
        else:
            track.append({"t": round(t - start, 2), "x": None, "faces": 0})
        t += step
    cap.release()

    seen = [p for p in track if p["x"] is not None]
    if not seen:
        print(json.dumps({"ok": False, "reason": "no-faces", "track": []}))
        return

    # Fill gaps by holding the last known position, so the camera does not
    # snap back to centre every time the detector blinks.
    hold = seen[0]["x"]
    for p in track:
        if p["x"] is None:
            p["x"] = hold
            p["xs"] = []
        else:
            hold = p["x"]

    groups = cluster(all_x)
    xs = sorted(p["x"] for p in seen)
    lo = xs[int(len(xs) * 0.1)]
    hi = xs[int(len(xs) * 0.9)]

    print(json.dumps({
        "ok": True,
        "x": round(xs[len(xs) // 2], 4),
        "faces": len(seen),
        "samples": len(track),
        "speakers": len(groups),
        "spread": round(max(0.0, hi - lo), 4),
        "track": track,
    }))


if __name__ == "__main__":
    main()
