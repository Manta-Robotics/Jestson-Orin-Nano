"""Exercise the real bridge parser with mocked MAVLink I/O, never a live FCU."""
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'backend'))
import mavlink_bridge as module
from mavlink_bridge import MAVLinkBridge


class ArmingBridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = MAVLinkBridge.__new__(MAVLinkBridge)
        self.bridge.master = SimpleNamespace(mav=Mock())
        self.bridge.flight_data = SimpleNamespace(updated_at=0)
        self.bridge.target_system = self.bridge.target_component = 1
        self.bridge._send_node_packet = Mock()
        self.bridge._send_node_log = Mock()
        self.bridge._handle_imu_ack = Mock()
        self.bridge.imu_calibration = SimpleNamespace(active=False)
        self.record = patch.object(module, 'record_mavlink', Mock(), create=True)
        self.record.start()
        self.addCleanup(self.record.stop)

    def message(self, kind, system=1, component=1, **fields):
        return SimpleNamespace(get_type=lambda: kind, get_srcSystem=lambda: system,
                               get_srcComponent=lambda: component, **fields)

    def test_real_parser_forwards_fcu_rejection_with_request_and_reason(self):
        self.bridge._parse_message(self.message('STATUSTEXT', text='PreArm: Gyros not calibrated', severity=3))
        self.assertTrue(self.bridge._arm_disarm(True, 'request'))
        self.bridge._parse_message(self.message('COMMAND_ACK', command=400, result=4))
        kind, result = self.bridge._send_node_packet.call_args.args
        self.assertEqual(kind, 'arm_ack')
        self.assertEqual(result['requestId'], 'request')
        self.assertEqual(result['reason'], 'Gyros not calibrated')
        self.assertEqual(self.bridge.master.mav.command_long_send.call_count, 1)

    def test_foreign_ack_does_not_consume_our_pending_request(self):
        self.bridge._arm_disarm(True, 'request')
        self.bridge._parse_message(self.message('COMMAND_ACK', system=2, command=400, result=4))
        self.bridge._send_node_packet.assert_not_called()
        self.assertEqual(len(self.bridge.arming_feedback.pending), 1)

    def test_foreign_status_text_cannot_supply_a_failure_reason(self):
        self.bridge._parse_message(self.message('STATUSTEXT', component=191, text='Arm: Foreign failure', severity=3))
        self.bridge._send_node_packet.assert_not_called()

    def test_disarm_keeps_its_own_action(self):
        self.bridge._arm_disarm(False, 'stop')
        self.bridge._parse_message(self.message('COMMAND_ACK', command=400, result=0))
        kind, result = self.bridge._send_node_packet.call_args.args
        self.assertEqual(result['action'], 'disarm')
        self.assertEqual(result['requestId'], 'stop')


if __name__ == '__main__':
    unittest.main()
