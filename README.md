# dsh-model-health

模型健康度（本地、零网络、零计费）：从本地会话日志被动记录每个模型的 **首字延迟（TTFT）** 与 **输出速度（tok/s）**，按天分桶、按模型聚合。

- 设置页独立栏：健康度卡片（窗口可选今日/近7天/近30天/全部）+ 趋势图（指标切换 TTFT / 输出速度，Top5 模型可开关）
- 数据来源：`$DSH_HOME/sessions` 会话日志（`step/start` → 首个非空 delta → usage 结束），只认 `$DSH_HOME`
- 持久化：`$DSH_HOME/storages/dsh-model-health/health.json`，max-merge 语义，删除会话不丢历史
- 口径：TTFT = 首个非空 delta（含 reasoning）− step/start；速度 = outputTokens / (usage 时刻 − 首 delta)

要求 Node ≥ 23.8（内置 zstd 解码多帧会话日志）。
