## ADDED Requirements
### Requirement: On-demand singleton
服务 SHALL 由首个调用项目启动，并供后续项目复用；空闲与客户端退出不停止服务。
#### Scenario: Concurrent startup
- **WHEN** 多个项目同时启动 MCP 入口
- **THEN** 只有一个服务持有监听与队列，所有项目连接同一服务

### Requirement: Durable at-most-once submission
服务 SHALL 在生成前持久化提交状态，相同项目和参数重复 submitId 不再次生成。
#### Scenario: Lost receipt and restart
- **WHEN** 提交后响应丢失或服务重启
- **THEN** 原任务只查询，不重新提交，未找到时保留不确定状态与并发位置

### Requirement: Account concurrency and project ownership
服务 SHALL 限制全局活跃生成数并检查已记录任务的项目归属。
#### Scenario: Shared capacity
- **WHEN** 多项目同时提交且账号已达并发上限
- **THEN** 新任务持久排队，已有任务完成或失败后释放位置

### Requirement: Central login
服务 SHALL 独立管理当前浏览器凭据，不要求调用项目读取或保存 Cookie。
#### Scenario: Expired login
- **WHEN** 需要登录或登录态过期
- **THEN** 服务提示在专用 Chrome 登录，任务保留且没有重复提交
