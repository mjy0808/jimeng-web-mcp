# Design

每个项目启动 shared-client stdio 桥接器，桥接器通过独占启动文件启动或复用一个 detached 服务。服务使用已安装 MCP SDK 的无会话 Streamable HTTP、私有随机 bearer、严格 Host 与 Origin 检查。项目身份由 x-jimeng-project 携带。默认动态回环端口，可配置固定端口。

服务调用原 server.js 子进程执行 provider 工具，每次使用当前浏览器凭据，避免长期单例客户端保留过期 token。不保存 Cookie；登录资料继续复用已有专用 Chrome 目录。

任务在 .jimeng-service/tasks 下按 UUID 原子持久化；生成前 fsync submitting，崩溃后标记 unknown 并只查询。queued 任务可继续派发；素材入队时保存 SHA256，派发前复核。上游未找到的未知任务保留并发位置，禁止推断失败后重新生成。旧任务可只读查询，不占队列。

production_submit/edit/promote 的 submitted 回执表示共享服务已持久接收，serviceStatus 提供细分状态；task_query 将等待与处理映射为 processing，兼容 Film Studio。账号并发按活跃上游任务计算，不只是提交请求数量。

手动停止先停止派发和轮询，等待进行中的 provider 调用结束，再关闭监听。任务留存，下次调用重新启动后恢复。不添加系统登录自启或空闲退出。
