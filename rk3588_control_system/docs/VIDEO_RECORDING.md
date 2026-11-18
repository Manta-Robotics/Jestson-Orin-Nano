# Jetson / SIYI 视频录制

录制由后端持久化会话管理，手机只发开始、停止和下载请求。断开手机、关闭网页、暂停云台跟踪都不会结束录制。

## 会话与恢复

- 默认每 120 秒切片；FFmpeg 在源关键帧附近切换文件，不为切片重新编码。
- 文件名为 `任务名_会话ID前8位__000001.mp4`，恢复后继续递增编号，保留已经写入的片段。
- `.sessions/` 保存任务元数据和录制意图，写入采用临时文件、fsync 和原子替换。
- `starting` 表示等待真实视频帧；`recording` 表示已经接收并写入；`recovering` 表示正在恢复视频源；`stopping` 表示等待写入进程退出。
- 启动 15 秒没有帧或录制过程中 8 秒没有新帧会终止当前 FFmpeg，并按 1–15 秒退避重新连接。手动停止先持久化取消意图，再结束子进程，防止自动重启录像。
- 后端服务重启保留未结束的录制意图。网页关机先正常结束录像，取消该意图。
- 手机重连通过 `/api/status`、录像状态接口和 Socket.IO 事件取得真实状态；旧后端实例和较旧版本的状态不能覆盖新状态。

## 文件与存储

默认目录为项目的 `recordings/gimbal/`。内部片段采用 fragmented MP4，减少异常中断导致整段不可播放的风险；异常断电仍可能丢失尚未落盘的数据。

正在写入的片段不列入素材列表，下载、改名和删除返回 409。完成的片段可以播放和下载；下载时用 `-c:v copy` 导出普通 MP4，原文件保持完整。临时导出文件在下载完成或失败后清理。

磁盘至少保留 `reserve_mb` 与 `reserve_ratio × 总容量` 中较大的空间，默认 1 GiB 与 5%。空间不足会正常终止录像并取消恢复，不自动删除已有素材。导出也会预留源片段所需的临时空间。

## 画质与 TF 卡

Jetson 的 `record_codec: copy` 保存相机原始网络码流，不经过手机预览，也不烘焙跟踪框或遥测。相机主码流和 TF 卡录像分别配置。

目标设置为：主码流 H.264 / 1920×1080 / 25 fps / 4000 Kbps；TF 卡原片 H.265 / 3840×2160 / 25 fps / 20000 Kbps。实际生效值必须通过 SIYI 0x20 回读，主码流还须录制后用 ffprobe 和解码检查确认。SDK 0x21 的最后一字节是保留位，不能当作帧率控制。

`recordings.tf_sync_enabled` 只在验证相机设置后开启。启用后，每次开始先核对 `tf_encoding`，再查询相机录像状态。0x0C/2 是切换指令，只在状态确实需要改变时发送一次，并查询确认；不会将“开始”指令连续重发。TF 卡缺失、参数不符或写入异常单独显示，不阻塞 Jetson 保存。录制期间每 10 秒检查 TF 状态并在条件恢复后尝试同步。

相机 TF 原片保留在卡内，此实现不自动导入卡内原片到 Jetson。

## 部署与检查

已有 systemd 服务须安装 `systemd/manta-recording.conf` 到 `/etc/systemd/system/manta-backend.service.d/60-recording.conf`，再执行 `systemctl daemon-reload`。它配置 `KillMode=mixed` 和 20 秒停止期限，允许后端先给 FFmpeg 发送 SIGINT 完成封装。全新安装的服务模板已包含该设置。

录像与编码写接口沿用设备配对、实时通道和控制权校验；不要停用访问控制来执行测试。更改编码时必须先结束录像，编码更改和录像停止操作互斥。

专项检查：

```text
node --test test/segmented_recording.test.mjs test/siyi_camera.test.mjs test/recording_ui.test.mjs
node scripts/validate_config.mjs
```

真实 FFmpeg 测试覆盖分段播放、写入进程异常后恢复和普通 MP4 导出；Windows 未安装 FFmpeg 时跳过该项，应在 Jetson 上执行。

协议依据：[SIYI 官方 SDK](https://siyi.biz/siyi_file/A8%20mini/SDK%20-%20V0.1.1.pdf)；封装依据：[FFmpeg formats](https://www.ffmpeg.org/ffmpeg-formats.html)。
