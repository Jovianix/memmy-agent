# Teach Mode 浏览器录制

Chrome、Edge 和桌面应用使用同一个 Computer History 采集器。用户在当前窗口演示，录制范围沿用已授权的应用和站点设置。

1. 用户在对话中确认目标和采集范围。Teach 调用 `record_and_replay` 的 `start`，Host 订阅 CH 并记录起始位置。
2. 用户操作浏览器。扩展已连接且 CH 观察策略允许时，页面操作可以补充到同一条事件流。启动 Teach 无需列举标签页或等待扩展。
3. 用户结束演示时，Teach 固定结束位置、保存这段事件并释放自己的订阅。后台 CH 是否继续由其余订阅和设置决定。
4. 用户在聊天中说“录制完成”时，Skill Creator 读取保存的片段和覆盖限制。

旧版只录教学窗口的请求会被拒绝。用户可以在了解 CH 范围后重新发起录制。已有片段仍按原来的事件索引、哈希和边界证明读取。

构建后可用 `node scripts/verify-teach-browser-host.mjs` 检查暂存的 Host 和扩展。
