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


class HaarDetector:
    """OpenCV 4 classic detector. Fast, no model file, no network."""

    name = "haar"

    def __init__(self, cv2):
        haar = cv2.data.haarcascades
        self.cv2 = cv2
        self.frontal = cv2.CascadeClassifier(haar + "haarcascade_frontalface_default.xml")
        self.profile = cv2.CascadeClassifier(haar + "haarcascade_profileface.xml")

    def faces(self, gray, width):
        cv2 = self.cv2
        # Try the frame as it is FIRST. Histogram equalisation helps dark or
        # flat footage but wrecks detection on normal, well-lit frames, so it
        # is only a fallback - measured, not guessed.
        for img in (gray, cv2.equalizeHist(gray)):
            found = list(self.frontal.detectMultiScale(img, scaleFactor=1.08, minNeighbors=4, minSize=(18, 18)))
            if found:
                return found
        # Someone turned to the side - a profile is still a person.
        for img in (gray, cv2.equalizeHist(gray)):
            found = list(self.profile.detectMultiScale(img, scaleFactor=1.1, minNeighbors=4, minSize=(18, 18)))
            if found:
                return found
            flipped = cv2.flip(img, 1)
            mirrored = [
                (width - fx - fw, fy, fw, fh)
                for (fx, fy, fw, fh) in self.profile.detectMultiScale(flipped, scaleFactor=1.1, minNeighbors=4, minSize=(18, 18))
            ]
            if mirrored:
                return mirrored
        return []


class YuNetDetector:
    """OpenCV 5 dropped the Haar classifier, so use the bundled DNN detector.

    Needs the small YuNet model (about 230KB). Point CLIPERY_YUNET at it, or
    drop it next to this file as face_detection_yunet.onnx. We also try to
    fetch it once into lib/models/ when the machine is online.
    """

    name = "yunet"
    URL = (
        "https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/"
        "face_detection_yunet/face_detection_yunet_2023mar.onnx"
    )

    def __init__(self, cv2, model_path):
        self.cv2 = cv2
        self.det = cv2.FaceDetectorYN_create(model_path, "", (320, 320), 0.6, 0.3, 5000)

    @classmethod
    def find_model(cls):
        import os
        env = os.environ.get("CLIPERY_YUNET")
        here = os.path.dirname(os.path.abspath(__file__))
        for p in [
            env,
            os.path.join(here, "face_detection_yunet.onnx"),
            os.path.join(here, "models", "face_detection_yunet.onnx"),
        ]:
            if p and os.path.exists(p):
                return p
        # One-time download, best effort - offline machines just fall back.
        try:
            import urllib.request
            dest_dir = os.path.join(here, "models")
            os.makedirs(dest_dir, exist_ok=True)
            dest = os.path.join(dest_dir, "face_detection_yunet.onnx")
            urllib.request.urlretrieve(cls.URL, dest)
            return dest if os.path.exists(dest) else None
        except Exception:
            return None

    def faces(self, gray, width):
        cv2 = self.cv2
        bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        h, w = bgr.shape[:2]
        self.det.setInputSize((w, h))
        _, dets = self.det.detect(bgr)
        out = []
        if dets is not None:
            for d in dets:
                x, y, fw, fh = d[:4]
                out.append((int(x), int(y), int(fw), int(fh)))
        return out


def build_detector(cv2):
    """Whichever detector this OpenCV build actually supports."""
    if hasattr(cv2, "CascadeClassifier") and hasattr(cv2, "data"):
        return HaarDetector(cv2), None
    if hasattr(cv2, "FaceDetectorYN_create"):
        model = YuNetDetector.find_model()
        if model:
            return YuNetDetector(cv2, model), None
        return None, "yunet-model-missing"
    return None, "no-face-detector"


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

    detector, why = build_detector(cv2)
    if detector is None:
        # OpenCV 5 removed the classic cascade files. Say so in plain words -
        # the engine prints this straight to the console.
        print(json.dumps({
            "ok": False,
            "reason": why,
            "hint": "pip install 'opencv-python-headless<5'  (or set CLIPERY_YUNET to a yunet .onnx)",
            "cv2": getattr(cv2, "__version__", "?"),
        }))
        return

    total = max(0.2, end - start)
    step = max(0.25, 1.0 / max(0.5, per_sec))
    # Keep the work bounded on long clips.
    if total / step > 240:
        step = total / 240.0

    # Decode SEQUENTIALLY and skip frames, instead of seeking to every sample.
    # Seeking by timestamp lands on the nearest keyframe, which on some files
    # silently returns the wrong part of the video - that made the tracker miss
    # whole sections. Reading forward is both accurate and faster.
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    if not fps or fps != fps or fps > 240:  # 0, NaN or nonsense
        fps = 25.0
    if start > 0.05:
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

    track = []
    all_x = []
    last_x = None
    frame_i = -1
    next_t = 0.0            # next sample time, relative to `start`
    base = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0 or start
    # Seeking lands on the nearest keyframe, which can be seconds BEFORE
    # `start`. Track times must be measured from `start` (that is where
    # ffmpeg's clock begins for the cut), never from where the seek landed,
    # or every camera move happens a few seconds late.
    if base > start:
        base = start
    while True:
        # grab() pulls the next frame WITHOUT decoding it - skipping is then
        # nearly free. We only pay for a full decode at the sample points.
        # Decoding every frame of a 20 minute video took minutes and looked
        # like the app had frozen.
        if not cap.grab():
            break
        frame_i += 1
        t = base + frame_i / fps
        if t > end:
            break
        if t < start - 1e-6:
            continue        # still before the clip: keyframe run-up
        if t - start < next_t - 1e-6:
            continue        # not a sample point yet, no decode needed
        next_t += step
        ok, frame = cap.retrieve()
        if not ok:
            continue

        small_w = 384
        small = cv2.resize(frame, (small_w, max(1, int(frame.shape[0] * small_w / frame.shape[1]))))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        # Motion: how much the picture changes to the VERY NEXT frame. Jumping,
        # running, fast camera work all light this up; a talking head barely
        # moves it. One extra decode per sample, so it stays cheap.
        motion = None
        if cap.grab():
            frame_i += 1
            ok2, nxt = cap.retrieve()
            if ok2:
                nxt_small = cv2.resize(nxt, (small.shape[1], small.shape[0]))
                nxt_gray = cv2.cvtColor(nxt_small, cv2.COLOR_BGR2GRAY)
                diff = cv2.absdiff(gray, nxt_gray)
                # mean abs diff of 0..255; 12+ is already a lot of movement
                motion = round(min(100.0, float(diff.mean()) / 12.0 * 100.0), 1)

        faces = detector.faces(gray, small_w)

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
                "motion": motion,
            })
        else:
            track.append({"t": round(t - start, 2), "x": None, "faces": 0, "motion": motion})
    cap.release()

    seen = [p for p in track if p["x"] is not None]
    if not seen:
        # No faces, but the motion readings are still worth having for scoring.
        print(json.dumps({"ok": False, "reason": "no-faces", "track": track}))
        return

    # Lost-face samples stay x=None on purpose. The reframer needs to know
    # when nobody was seen: filling the gap with the old position made it
    # believe the person was still standing there and keep the camera on
    # an empty spot after they had walked off.
    for p in track:
        if p["x"] is None:
            p["xs"] = []

    groups = cluster(all_x)
    xs = sorted(p["x"] for p in seen)
    lo = xs[int(len(xs) * 0.1)]
    hi = xs[int(len(xs) * 0.9)]

    print(json.dumps({
        "ok": True,
        "x": round(xs[len(xs) // 2], 4),
        "faces": len(seen),
        "samples": len(track),
        "detector": detector.name,
        "speakers": len(groups),
        "spread": round(max(0.0, hi - lo), 4),
        "track": track,
    }))


if __name__ == "__main__":
    main()
