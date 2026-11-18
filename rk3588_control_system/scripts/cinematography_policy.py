"""Board cinema actor. One local JSON line per camera frame, one response per line."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageFilter
import torch

MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / "cinematography"
SIZE = (320, 180)
MODES = ("move", "relative_hold", "world_hold")
PERIOD_MS = 500
WINDOW_MS = 120_000
MAX_FRAME_GAP_MS = 600
MAX_LINE_BYTES = 6 * 1024 * 1024


def person_map(target):
    """Represent the one measured detector box; each interior pixel has its YOLO score."""
    probabilities = np.zeros(SIZE[::-1], dtype=np.float32)
    if target is None:
        return probabilities
    if not isinstance(target, dict):
        raise ValueError("Expected one normalized swimmer box")
    x1, y1, x2, y2, confidence = [target[key] for key in ("x1", "y1", "x2", "y2", "confidence")]
    if (not all(type(v) in (float, int) and math.isfinite(v) for v in (x1, y1, x2, y2, confidence))
            or not 0 <= x1 < x2 <= 1 or not 0 <= y1 < y2 <= 1 or not 0 <= confidence <= 1):
        raise ValueError("Invalid normalized swimmer box or confidence")
    w, h = SIZE
    probabilities[math.floor(y1 * h):math.ceil(y2 * h), math.floor(x1 * w):math.ceil(x2 * w)] = confidence
    return probabilities


def prepare_frame(image, probabilities):
    resized = image.convert("RGB").resize(SIZE, Image.Resampling.BILINEAR)
    rgb = np.asarray(resized)
    blurred = np.asarray(resized.filter(ImageFilter.GaussianBlur(2.0)))
    # The training contract uses Sobel on normalized, blurred RGB luminance.
    gray = blurred.astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722], np.float32) / 255.0
    p = np.pad(gray, 1, mode="edge")
    gx = (p[:-2, 2:] - p[:-2, :-2]) + 2*(p[1:-1, 2:] - p[1:-1, :-2]) + (p[2:, 2:] - p[2:, :-2])
    gy = (p[2:, :-2] - p[:-2, :-2]) + 2*(p[2:, 1:-1] - p[:-2, 1:-1]) + (p[2:, 2:] - p[:-2, 2:])
    edges = np.clip(np.hypot(gx, gy) / np.sqrt(32.0), 0, 1).astype(np.float32)
    return np.concatenate((rgb.astype(np.float32) / 255.0, edges[..., None], probabilities[..., None]), axis=2)


class CinemaActor:
    def __init__(self, model_dir=MODEL_DIR, device="cpu"):
        manifest = json.loads((model_dir / "manifest.json").read_text())
        archive = (model_dir / "actor.pt").read_bytes()
        if (manifest["schema"] != "manta.onboard.cinema.actor.v1"
                or hashlib.sha256(archive).hexdigest() != manifest["actorSha256"]):
            raise ValueError("Cinema actor archive mismatch")
        self.version = manifest["policyVersion"]
        self.net = torch.jit.load(io.BytesIO(archive), map_location=device).eval()
        self.device = torch.device(device)
        self.intent_id = -1
        self.reset_window()

    def reset_window(self):
        self.hidden = torch.zeros(1, 1, 128, device=self.device)
        self.action = self.net.action_mid.clone()
        self.mode = None
        self.decisions = 0
        self.latent = torch.zeros(4, device=self.device)
        self.innovation = torch.zeros(2, device=self.device)

    @torch.inference_mode()
    def decide(self, samples, elapsed_ms):
        frames = torch.as_tensor(np.stack(samples), device=self.device).permute(0, 3, 1, 2)
        mode_history = self.action.new_zeros(3)
        if self.mode is not None:
            mode_history[self.mode] = 1
        remaining = self.action.new_tensor([1.0 - elapsed_ms / WINDOW_MS])
        age = self.action.new_tensor([self.decisions * PERIOD_MS / WINDOW_MS])
        mean, logits, gate, self.hidden = self.net(
            frames, self.action, mode_history, remaining, self.hidden, age)
        first = self.mode is None
        reselect = first or int(torch.distributions.Categorical(logits=gate).sample()) == 1
        if reselect:
            self.mode = int(torch.distributions.Categorical(logits=logits).sample())
            self.intent_id += 1
            self.decisions = 0
        self.decisions += 1

        location = mean.clone()
        offsets = torch.zeros_like(mean)
        offsets[:2] = self.net.position_log_scale
        if not first:
            location[2:] = mean[2:] + self.net.log_std[2:].exp() * self.net.rho * self.innovation
            offsets[2:] = (1 - self.net.rho.square()).sqrt().log()
        start_axis = 0 if reselect and self.mode == 0 else 2
        latent = torch.zeros_like(mean)
        noise = torch.randn_like(mean[start_axis:])
        latent[start_axis:] = location[start_axis:] + (self.net.log_std[start_axis:] + offsets[start_axis:]).exp() * noise
        if not reselect:
            latent[:2] = self.latent[:2]
        self.action = self.net.action_mid + self.net.action_half * latent.tanh()
        if self.mode != 0:
            self.action[:2] = 0
        self.latent = latent
        self.innovation = (latent[2:] - mean[2:]) / self.net.log_std[2:].exp()
        radial, tangential, yaw, pitch = self.action.tolist()
        return dict(mode=MODES[self.mode], intentId=self.intent_id,
                    event="reselect" if reselect else "continue",
                    radialMps=radial, tangentialMps=tangential, yawDps=yaw, pitchDps=pitch)


class FrameSession:
    """First new 5 Hz observation drives the first decision; never use a future frame."""

    def __init__(self, actor):
        self.actor = actor
        self.start_ms = None
        self.last_id = -1
        self.last_ms = None
        self.next_slot = 0
        self.pending = []
        self.enabled = None
        self.pending_id = None
        self.pending_time_ms = None

    def _decide(self):
        if not self.pending:
            raise ValueError("No fresh camera observation in decision window")
        decision = self.actor.decide(self.pending, self.next_slot)
        decision["observationFrameId"] = self.pending_id
        decision["observationTimeMs"] = self.pending_time_ms
        self.pending.clear()
        self.next_slot += PERIOD_MS
        return decision

    def receive(self, message):
        if message.get("type") != "frame":
            raise ValueError("Expected camera frame")
        frame_id, now, enabled = (message[key] for key in ("frameId", "timeMs", "visualEnabled"))
        if type(frame_id) is not int or frame_id <= self.last_id:
            raise ValueError("Camera frame ID did not advance")
        if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
            raise ValueError("Invalid camera clock")
        if self.last_ms is not None and not 0 < now - self.last_ms <= MAX_FRAME_GAP_MS:
            raise ValueError("Camera clock discontinuity")
        if type(enabled) is not bool or (not enabled and message.get("target") is not None):
            raise ValueError("Unexpected visual observation while detection is disabled")
        target_map = person_map(message.get("target"))
        with Image.open(io.BytesIO(base64.b64decode(message["jpeg"], validate=True))) as image:
            if image.format != "JPEG" or min(image.size) < 2 or image.width * image.height > 4096 * 2160:
                raise ValueError("Expected a supported JPEG camera frame")
            channels = prepare_frame(image, target_map)

        if self.start_ms is None or now - self.start_ms >= WINDOW_MS or self.enabled != enabled:
            self.actor.reset_window()
            self.pending.clear()
            self.start_ms = now
            self.next_slot = 0
        elapsed = now - self.start_ms
        decision = None
        if elapsed > self.next_slot:
            decision = self._decide()
            if elapsed >= self.next_slot:
                raise ValueError("Missed a PPO decision")
        self.pending.append(channels)
        self.pending_id = frame_id
        self.pending_time_ms = now
        if len(self.pending) > 8:
            raise ValueError("Expected sampled camera input at 5 Hz")
        if elapsed == self.next_slot:
            decision = self._decide()
        self.last_id, self.last_ms, self.enabled = frame_id, now, enabled
        return dict(type="sample", frameId=frame_id, timeMs=now,
                    decision=decision, policyVersion=self.actor.version)


def emit(message):
    print(json.dumps(message, separators=(",", ":"), allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "cuda", "auto"), default="auto")
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--seed", type=int, help="Fixed sampling seed for replay verification")
    args = parser.parse_args()
    try:
        if not 1 <= args.threads <= 16:
            raise ValueError("Invalid CPU thread count")
        torch.set_num_threads(args.threads)
        if args.seed is not None:
            torch.manual_seed(args.seed)
        device = args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
        actor = CinemaActor(device=device)
        # Verify this board can execute the archived graph before announcing readiness.
        with torch.inference_mode():
            zero = actor.action.new_zeros
            actor.net(zero((1, 5, SIZE[1], SIZE[0])), actor.action, zero((3,)), zero((1,)), actor.hidden, zero((1,)))
            if actor.device.type == "cuda":
                torch.cuda.synchronize(actor.device)
        session = FrameSession(actor)
        emit(dict(type="ready", policyVersion=actor.version, device=device))
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not line:
                return 0
            if len(line) > MAX_LINE_BYTES:
                raise ValueError("Input camera frame is too large")
            emit(session.receive(json.loads(line)))
    except Exception as exc:
        emit(dict(type="error", reason=f"{type(exc).__name__}: {exc}"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
