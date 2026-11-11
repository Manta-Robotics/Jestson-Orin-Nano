"""Correlate FCU arm/disarm replies without relying on deduplicated log messages."""

from collections import deque
import re
import time


class ArmingFeedback:
    def __init__(self, send, wall_clock=time.time, clock=time.monotonic):
        self.send = send
        self.wall_clock = wall_clock
        self.clock = clock
        self.pending = deque(maxlen=16)
        self.prearm = None
        self.last_failure = None

    def requested(self, arm, request_id=None):
        self.pending.append({
            'action': 'arm' if arm else 'disarm',
            'requestId': request_id,
            'sentAt': self.clock(),
        })
        self.last_failure = None

    def status_text(self, text):
        match = re.match(r'^(PreArm|Arm):\s*(.+)', text, re.IGNORECASE)
        if not match:
            return
        now = self.clock()
        self.prearm = {'reason': match.group(2).strip(), 'at': now}
        self.send('prearm_status', {
            'reason': self.prearm['reason'],
            'updatedAt': int(self.wall_clock() * 1000),
        })
        # Some FCUs send the explanatory STATUSTEXT just after COMMAND_ACK.
        # Update that same failed transaction so clients can include the reason.
        if self.last_failure and 0 <= now - self.last_failure[1] <= 1.0:
            result = dict(self.last_failure[0], reason=self.prearm['reason'])
            self.last_failure = (result, self.last_failure[1])
            self.send('arm_ack', result)

    def acknowledged(self, result, result_name):
        now = self.clock()
        while self.pending and now - self.pending[0]['sentAt'] >= 8.0:
            self.pending.popleft()
        if not self.pending:
            return
        request = self.pending[0] if result == 5 else self.pending.popleft()
        reason = ''
        if (request['action'] == 'arm' and result not in (0, 5)
                and self.prearm and 0 <= now - self.prearm['at'] <= 35.0):
            reason = self.prearm['reason']
        payload = {
            'requestId': request['requestId'],
            'action': request['action'],
            'result': result,
            'resultName': result_name,
            'reason': reason,
            'updatedAt': int(self.wall_clock() * 1000),
        }
        if request['action'] == 'arm' and result not in (0, 5):
            self.last_failure = (payload, now)
        self.send('arm_ack', payload)

    def armed(self):
        # A previous flight's pre-arm failure must not explain a new request.
        self.prearm = None
        self.last_failure = None
