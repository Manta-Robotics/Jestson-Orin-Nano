# Manta Jetson Orin Nano 船端控制系统

本仓库维护 Manta 水面机器人在 Jetson Orin Nano 上的船端软件，连接 Pixhawk、USB UWB 与 A8 云台，提供手动操控、自动跟随、泳者跟踪、录像和遥测。源码目录沿用上游名称 `rk3588_control_system`。

Jetson 默认使用原有后方跟随，可在停止跟随后选择左侧或右侧伴随。UWB 与 A8 泳者检测的融合结果可在 Web 控制台单独查看。云台校准由操作员确认后写入，实验日志默认保存在 `/home/gongcheng/manta_logs`。

LubanCat 5（RK3588）沿用以下部署目录。Jetson 的串口和网络参数由设备配置提供。

```text
/root/Pixhawk_RK3588/rk3588_control_system
```

## 快速入口

- [实验日志、告警与录像双向定位](rk3588_control_system/docs/EXPERIMENT_LOGGING_ZH.md)

- [Stonefish + ArduRover 本地三维仿真](https://github.com/Manta-Robotics/Stonefish_SITL)（直接复用本仓库船端控制代码，无需连接板子）
- [完整安装与使用说明](rk3588_control_system/README.md)
- [系统架构](rk3588_control_system/docs/ARCHITECTURE.md)
- [Jetson USB UWB 接收与跟随](rk3588_control_system/docs/JETSON_USB_UWB.md)
- [左右侧伴随](rk3588_control_system/docs/SIDE_FOLLOW.md) · [UWB 与 A8 视觉融合](rk3588_control_system/docs/UWB_VISION_FUSION.md)
- [运行维护手册](rk3588_control_system/docs/OPERATIONS.md)
- [root 新板迁移说明](ROOT_MIGRATION_CN.md)

## RK3588 接线参考

| 设备 | 接口 | 配置 |
| --- | --- | --- |
| Pixhawk TELEM2 | RK 物理针脚 8/10/6 | `/dev/ttyS1 @ 115200` |
| 云台 UART | RK 物理针脚 5/3/9 | `/dev/ttyS3 @ 115200` |
| 云台网络 | `eth0` | RK `192.168.144.101`，云台 `192.168.144.108` |
| 手机 Wi-Fi | `p2p0` | `Manta-Control`，控制地址 `10.42.0.1:3000` |
| 手机蓝牙 PAN | `manta-bt0` | 控制地址 `10.43.0.1:3000` |

## 开发检查

```bash
cd rk3588_control_system
npm ci
npm test
npm run check
```

所有运行服务由 systemd 管理。仓库中的 `start.sh`、`stop.sh` 和 `scripts/status_report.sh` 是统一运维入口，不再自行清理未知进程或抢占端口。

## License

MIT
