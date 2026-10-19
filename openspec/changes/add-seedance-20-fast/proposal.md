## Why
SpineAuto 用户明确要求使用即梦 Seedance 2.0 Fast 全能参考生成动作视频。

## What Changes
- 增加独立 Fast 模型别名，并在上传前读取当前账号配置核验规格与计费键。
- 保留标准版、VIP 与现有共享队列行为。

## Impact
- VideoService、模型映射和 production_submit。
- 授权依据：2026-10-19 用户已直接指定模型和调用项目，按此范围实施。
