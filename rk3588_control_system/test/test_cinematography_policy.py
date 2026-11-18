import base64
import hashlib
import io
import sys
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
try:
    import numpy as np
    from PIL import Image
    import torch
except ModuleNotFoundError:
    torch = None
if torch is not None:
    from cinematography_policy import CinemaActor, FrameSession, person_map, prepare_frame


@unittest.skipUnless(torch is not None, "requires board inference environment with torch and Pillow")
class CinemaPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        y, x = np.indices((237, 419))
        rgb = np.stack((x % 256, y % 256, (x * 3 + y * 5) % 256), axis=2).astype("uint8")
        cls.image = Image.fromarray(rgb)
        stream = io.BytesIO()
        cls.image.save(stream, format="JPEG")
        cls.jpeg = base64.b64encode(stream.getvalue()).decode("ascii")
        cls.box = dict(x1=.31, y1=.22, x2=.44, y2=.62, confidence=.75)

    def message(self, ident, ms, enabled=False):
        return dict(type="frame", frameId=ident, timeMs=ms, jpeg=self.jpeg,
                    visualEnabled=enabled, target=self.box if enabled else None)

    def test_golden_training_observation_and_learned_heads(self):
        # Reference values from u57 on the same RGB, edge and detector score map.
        model = CinemaActor()
        channels = prepare_frame(self.image, person_map(self.box))
        self.assertEqual(hashlib.sha256(channels.tobytes()).hexdigest(),
                         "03ffc4020e343306c3b3620fc6b3d452913df09d53e77c3492187b7c8e7bf7a6")
        with torch.inference_mode():
            mean, modes, gate, _ = model.net(torch.as_tensor(channels)[None].permute(0, 3, 1, 2),
                torch.zeros(4), torch.zeros(3), torch.ones(1), torch.zeros(1, 1, 128), torch.zeros(1))
        np.testing.assert_allclose(mean, [.033165671, -.011481530, .038923066, -.009431515], atol=2e-6)
        np.testing.assert_allclose(modes, [-.097369276, .080726676, -.016953964], atol=2e-6)
        np.testing.assert_allclose(gate, [-.097329035, -3.834898233], atol=2e-6)
        with self.assertRaises(ValueError):
            person_map([self.box, self.box])
        self.assertEqual(float(person_map(None).sum()), 0)

    def test_real_worker_recurrence_and_causal_frame_clock(self):
        torch.manual_seed(1)
        session = FrameSession(CinemaActor())
        first = session.receive(self.message(1, 0, True))["decision"]
        self.assertEqual(first["event"], "reselect")
        self.assertIsNone(session.receive(self.message(2, 200, True))["decision"])
        self.assertIsNone(session.receive(self.message(3, 400, True))["decision"])
        second = session.receive(self.message(4, 600, True))["decision"]
        self.assertEqual(second["observationFrameId"], 3)
        self.assertEqual(second["observationTimeMs"], 400)
        self.assertEqual(second["event"], "continue")
        self.assertEqual(second["intentId"], first["intentId"])
        self.assertEqual(second["radialMps"], first["radialMps"])
        self.assertEqual(second["tangentialMps"], first["tangentialMps"])
        self.assertNotEqual(second["yawDps"], first["yawDps"])
        self.assertIsNone(session.receive(self.message(5, 800, True))["decision"])
        self.assertEqual(session.receive(self.message(6, 1000, True))["decision"]["observationFrameId"], 6)
        switched = session.receive(self.message(7, 1200, False))["decision"]
        self.assertGreater(switched["intentId"], first["intentId"])
        self.assertEqual(switched["event"], "reselect")
        with self.assertRaisesRegex(ValueError, "discontinuity"):
            session.receive(self.message(8, 2000, False))
        with self.assertRaisesRegex(ValueError, "did not advance"):
            session.receive(self.message(7, 1300, False))
        with self.assertRaisesRegex(ValueError, "disabled"):
            session.receive(dict(self.message(8, 1400), target=self.box))

    def test_120s_window_resets_policy_and_emits_a_fresh_global_intent(self):
        actor = CinemaActor()
        session = FrameSession(actor)
        first = session.receive(self.message(1, 1000))["decision"]
        # Advance transport bookkeeping to the final 200-ms frame, independently
        # of motion. No sample from the old observation group may cross the reset.
        session.last_ms = 120800
        session.last_id = 599
        session.next_slot = 120000
        session.pending.append(np.full((180, 320, 5), np.nan, dtype=np.float32))
        after = session.receive(self.message(600, 121000))["decision"]
        self.assertEqual(after["intentId"], first["intentId"] + 1)
        self.assertEqual(after["event"], "reselect")
        self.assertEqual((after["observationFrameId"], after["observationTimeMs"]), (600, 121000))
        self.assertTrue(np.isfinite(after["pitchDps"]))
