## ADDED Requirements
### Requirement: 音频参考输入
生产提交 SHALL 保留每段已审核音频的 SHA256、时长和独立编号；最多 10 段、合计 30 秒。
#### Scenario: 已审核音频用于生成
- **WHEN** 用户批准包含 @音频N 的 Seedance 2.5 全能参考提示词
- **THEN** 输入原样上传且编号绑定到对应音频素材
#### Scenario: 文件在入队后变化
- **WHEN** 音频字节与审批摘要不同
- **THEN** 队列拒绝生成且不创建替代任务
