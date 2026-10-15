## Why
现有参考图生图会重生成整图，无法传入明确的局部选区。调用项目需要使用即梦网页原生图片局部重绘，并共享既有队列、凭据和防重复提交机制。

## What Changes
- 新增 production_image_edit：原图、同尺寸灰度 PNG 蒙版、两份文件 SHA256、编辑提示词及可选 strength。
- 使用官方网页的 painting Draft、postedit_param.generate_type=7、origin_uri 与 mask_uri，不退回 blend。
- 原图与蒙版在上传和入队前校验；排队期间复核 SHA256，任务按 image 类型记录并用 task_query 恢复。
- 明确请求单结果，沿用异常数量拒绝与不续生成规则。
- 提供离线协议、输入、队列、错误响应与 MCP 发现测试及接入文档。

## Authorization
用户已明确要求接入即梦图片局部编辑接口。本变更落实该接口及既有共享服务接入，不修改 Film Studio 的编辑界面，不提交付费实测。

## Impact
新增 image-local-editing 能力，扩展生产工具、共享队列与图片解码依赖；现有普通图片生成和视频编辑保持原有入口。保留当前工作区已有的图片 4K 修改。
