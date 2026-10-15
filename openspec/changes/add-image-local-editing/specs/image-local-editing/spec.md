## ADDED Requirements
### Requirement: Native masked image editing
接口 SHALL 使用即梦原生 painting 局部编辑请求，分别绑定原图与蒙版，不使用普通参考图生成作为替代。
#### Scenario: Valid edit
- **WHEN** 调用方提交经过审核的原图、同尺寸灰度蒙版、文件 SHA256 与提示词
- **THEN** 接口提交一次原生局部重绘，返回 image 类型的原任务编号

### Requirement: Reviewed input validation
接口 SHALL 在上传和入队前检查文件哈希、尺寸、格式、方向与蒙版语义。
#### Scenario: Invalid mask
- **WHEN** 蒙版与原图尺寸不符、选区为空、没有保留区域、含彩色或透明像素，或任一哈希不匹配
- **THEN** 请求被拒绝，未上传且未提交生成

### Requirement: Shared queue recovery
共享服务 SHALL 将局部编辑作为 image 任务执行既有并发和原任务恢复规则，并将原图与蒙版纳入文件快照。
#### Scenario: Changed queued material
- **WHEN** 排队期间原图或蒙版发生变化
- **THEN** 任务被拒绝派发，不上传、不生成
#### Scenario: Lost receipt or restart
- **WHEN** 提交响应丢失或服务重启
- **THEN** 查询原编号，不重新提交，也不通过其他生成模式替代

### Requirement: Single-result handling
接口 SHALL 明确请求一个结果，查询中拒绝异常多结果，不续生成或自动补交。
#### Scenario: Multiple provider outputs
- **WHEN** 原任务报告多个图片结果
- **THEN** 结果被标记为失败，调用方获知原任务及数量异常
