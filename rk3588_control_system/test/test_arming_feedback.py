import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'backend'))
from arming_feedback import ArmingFeedback


class ArmingFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.events = []
        self.feedback = ArmingFeedback(
            lambda kind, value: self.events.append((kind, value)),
            wall_clock=lambda: 1793769000.0, clock=lambda: self.now)

    def test_repeated_rejections_are_delivered_for_each_request(self):
        for request in ('first', 'second'):
            self.feedback.status_text('PreArm: Gyros not calibrated')
            self.feedback.requested(True, request)
            self.feedback.acknowledged(4, 'MAV_RESULT_FAILED')
            kind, result = self.events[-1]
            self.assertEqual(kind, 'arm_ack')
            self.assertEqual(result['requestId'], request)
            self.assertEqual(result['reason'], 'Gyros not calibrated')

    def test_statustext_after_ack_enriches_same_failure(self):
        self.feedback.requested(True, 'request')
        self.feedback.acknowledged(4, 'MAV_RESULT_FAILED')
        self.assertEqual(self.events[-1][1]['reason'], '')
        self.now += .02
        self.feedback.status_text('Arm: Gyros not calibrated')
        self.assertEqual(self.events[-1][1]['requestId'], 'request')
        self.assertEqual(self.events[-1][1]['reason'], 'Gyros not calibrated')

    def test_disarm_and_unsolicited_ack_cannot_reject_an_arm_request(self):
        self.feedback.acknowledged(4, 'MAV_RESULT_FAILED')
        self.assertEqual(self.events, [])
        self.feedback.status_text('PreArm: Gyros not calibrated')
        self.feedback.requested(False, 'stop')
        self.feedback.acknowledged(4, 'MAV_RESULT_FAILED')
        self.assertEqual(self.events[-1][1]['action'], 'disarm')
        self.assertEqual(self.events[-1][1]['reason'], '')

    def test_accepted_and_in_progress_do_not_claim_vehicle_is_armed(self):
        self.feedback.requested(True, 'request')
        self.feedback.acknowledged(5, 'MAV_RESULT_IN_PROGRESS')
        self.feedback.acknowledged(0, 'MAV_RESULT_ACCEPTED')
        self.assertEqual([value['result'] for kind, value in self.events], [5, 0])
        self.assertTrue(all('armed' not in value for kind, value in self.events))
        self.assertEqual(len(self.feedback.pending), 0)

    def test_expired_requests_and_old_reasons_are_not_reused(self):
        self.feedback.status_text('PreArm: Old failure')
        self.feedback.requested(True, 'expired')
        self.now += 36
        self.feedback.acknowledged(4, 'MAV_RESULT_FAILED')
        self.assertEqual(len(self.events), 1)
        self.feedback.requested(True, 'new')
        self.feedback.acknowledged(4, 'MAV_RESULT_FAILED')
        self.assertEqual(self.events[-1][1]['reason'], '')

    def test_successful_flight_clears_cached_failure(self):
        self.feedback.status_text('PreArm: Old failure')
        self.feedback.armed()
        self.feedback.requested(True, 'next-flight')
        self.feedback.acknowledged(4, 'MAV_RESULT_FAILED')
        self.assertEqual(self.events[-1][1]['reason'], '')


if __name__ == '__main__':
    unittest.main()
