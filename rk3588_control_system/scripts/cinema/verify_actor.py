"""Compare the archived board actor with the original MANTA-Sim checkpoint on CPU.

Run with the workstation's training Python:
python scripts/cinema/verify_actor.py /path/to/MANTA-Sim /path/to/checkpoint.pt
"""
import argparse
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageFilter
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cinematography_policy import CinemaActor, MODEL_DIR, MODES, person_map, prepare_frame


def verify(sim_root, checkpoint):
    sys.path.insert(0, str(sim_root / "manta_sim"))
    from visual_control.contracts import ActionProposal, EgoAction
    from visual_control.hybrid_checkpoint import load_hybrid_checkpoint
    from visual_control.hybrid_contracts import HybridPolicyInput
    from visual_control.whole_shot_episode import VisualSample, WholeShotPolicyInput
    from visual_data.edges import rgb_edges

    manifest = json.loads((MODEL_DIR / "manifest.json").read_text())
    original = load_hybrid_checkpoint(checkpoint, expected_sha256=manifest["checkpointSha256"]).model
    torch.set_num_threads(1)
    y, x = np.indices((237, 419))
    image = Image.fromarray(np.stack((x % 256, y % 256, (x * 3 + y * 5) % 256), axis=2).astype("uint8"))
    resized = image.resize((320, 180), Image.Resampling.BILINEAR)
    edges = rgb_edges(np.asarray(resized.filter(ImageFilter.GaussianBlur(2.0))))
    frames = []
    for target in (None, dict(x1=.31, y1=.22, x2=.44, y2=.62, confidence=.75)):
        mask = person_map(target)
        data = prepare_frame(image, mask)
        expected = np.concatenate((np.asarray(resized).astype(np.float32) / 255.,
                                   edges[..., None], mask[..., None]), axis=2)
        np.testing.assert_array_equal(data, expected)
        frames.append(data)

    maximum = 0.
    decisions = 0
    modes = set()
    for seed in (0, 1, 2, 7):
        board = CinemaActor()
        torch.manual_seed(seed)
        state = None
        proposals = []
        history = []
        last_frame = -1
        for step in range(130):
            tick = step * .5
            current_frame = int(tick * 5)
            samples = tuple(VisualSample(i / 5., frames[i % 2]) for i in range(last_frame + 1, current_frame + 1))
            obs = HybridPolicyInput(WholeShotPolicyInput(samples, tuple(proposals), tick, (120 - tick) / 120.),
                                    tuple(history))
            rng = torch.get_rng_state()
            with torch.inference_mode():
                ref = original.act(obs, state=state, reset=step == 0)
            state, sample = ref.state, ref.sample
            history.append(sample.original_mode)
            proposals.append(ActionProposal(EgoAction(*sample.original_action.tolist()), tick, tick + .5))
            torch.set_rng_state(rng)
            out = board.decide([s.channels for s in samples], step * 500)
            expected_mode = MODES[sample.original_mode.index]
            modes.add(expected_mode)
            if (out["mode"] != expected_mode or out["event"] != sample.event.name.lower()
                    or out["intentId"] != sample.intent_id):
                raise AssertionError(f"Intent differs at seed {seed}, step {step}")
            delta = np.abs(np.asarray([out[k] for k in ("radialMps", "tangentialMps", "yawDps", "pitchDps")])
                           - sample.original_action.tolist())
            maximum = max(maximum, float(delta.max()))
            last_frame = current_frame
            decisions += 1
    if maximum > 3e-6 or modes != set(MODES):
        raise AssertionError(f"Actor action mismatch or missing mode: {maximum}, {sorted(modes)}")
    print(json.dumps(dict(decisions=decisions, maxAbsActionError=maximum, modes=sorted(modes),
                          policyVersion=manifest["policyVersion"], checkpointSha256=manifest["checkpointSha256"])))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sim_root", type=Path)
    parser.add_argument("checkpoint", type=Path)
    args = parser.parse_args()
    verify(args.sim_root, args.checkpoint)
