"""Export a verified MANTA-Sim checkpoint as a self-contained, FP32 actor.

Run on the training workstation with manta_sim on PYTHONPATH. The board only
needs the resulting archive, the manifest and the inference worker.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import torch
from torch import nn


class ActorStep(nn.Module):
    def __init__(self, policy):
        super().__init__()
        core = policy.base.core
        self.cnn = core.cnn
        self.gru = core.gru
        self.mean = core.actor_mean
        self.modes = core.mode_head
        self.gate = policy.termination_head
        self.register_buffer("action_mid", core.action_mid)
        self.register_buffer("action_half", core.action_half)
        self.register_buffer("log_std", core.actor_log_std.detach())
        self.register_buffer("rho", core.exploration_correlation)
        self.register_buffer("position_log_scale", torch.tensor(math.log(policy.position_exploration_scale)))

    def forward(self, frames, previous_action, previous_mode, remaining, hidden, age):
        visual = self.cnn(frames).mean(dim=0)
        previous = (previous_action - self.action_mid) / self.action_half
        features = torch.cat((visual, previous, remaining, previous_mode)).reshape(1, 1, 136)
        state, next_hidden = self.gru(features, hidden)
        h = state[0, 0]
        return self.mean(h), self.modes(h), self.gate(torch.cat((h, age))), next_hidden


def export(checkpoint, digest, directory):
    from visual_control.hybrid_checkpoint import load_hybrid_checkpoint
    from visual_control.persistent_intent_policy import PersistentIntentPolicy

    loaded = load_hybrid_checkpoint(checkpoint, expected_sha256=digest)
    if type(loaded.model) is not PersistentIntentPolicy:
        raise ValueError("Expected the persistent-intent policy")
    module = torch.jit.script(ActorStep(loaded.model).eval())
    directory.mkdir(parents=True, exist_ok=True)
    model_path = directory / "actor.pt"
    module.save(str(model_path))
    manifest = {
        "schema": "manta.onboard.cinema.actor.v1",
        "checkpointSha256": loaded.sha256,
        "policyVersion": loaded.payload["policy_version"],
        "update": loaded.payload["update_index"],
        "actorSha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
        "torchExportVersion": str(torch.__version__),
        "observation": "RGB, RGB Sobel edge, single-swimmer YOLO box score map",
        "visionOff": "RGB, RGB Sobel edge, zero person map",
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("sha256")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    export(args.checkpoint, args.sha256, args.directory)
