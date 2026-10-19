## Why
用户明确要求将 Seedance 2.0 和 Fast 替换为对应 VIP 模型。

## What Changes
- 使用显式 VIP 别名与官网 _vision 模型，上传前核实所选分辨率的账号配置及 VIP 计费键。
- **BREAKING** 移除普通 2.0/Fast 新提交别名，旧任务仅按原 ID 查询，不重映射为 VIP。
- Film Studio 替换模型选项，暴露 VIP 实际规格；不改变已提交任务或项目已审核参数。

## Authorization
2026-10-19 用户直接要求替换为 Seedance 2.0 VIP 和 Seedance 2.0 Fast VIP，本变更按该明确范围实施。

## Impact
模型映射、VideoService、MCP 参数、文档与 Film Studio 模型配置。
