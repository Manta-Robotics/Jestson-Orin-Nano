#!/bin/bash
set -e
source /opt/ros/humble/setup.bash
if [ -f /home/gongcheng/usv_ws/install/setup.bash ]; then
  source /home/gongcheng/usv_ws/install/setup.bash
fi
cd /home/gongcheng/Pixhawk_RK3588/rk3588_control_system/scripts/experiment_logger
exec /usr/bin/python3 -u experiment_logger.py --config config.json
