## Decisions
以官方 mweb ImageEdit 资源中的局部重绘转换器为协议依据。调用 /mweb/v1/aigc_draft/generate，Draft 中使用 image_base_component、generate_type=painting、abilities.painting、postedit_param.generate_type=7，并分别设置原图 origin_uri 与蒙版 mask_uri。该转换器不设置 root_model，接口不伪造模型选择参数。

蒙版采用 8 位不透明灰度 PNG：白色为修改区域、黑色为保留区域、灰色为羽化边缘。要求原图与蒙版尺寸一致，存在黑色保留像素及非零修改像素；拒绝空白、全覆盖、彩色、透明或 EXIF 方向不明确的输入。单文件限 20 MiB，像素限 16MP，属于本地资源限制。SHA256 在入队、派发和上传前保护审核的输入内容。

新工具独立于视频 production_edit，服务将其归类为 image 并复用全局活跃生成上限、提交前刷盘和不明状态只查询规则。返回的 taskId 沿用调用方预先持久化的 UUID；查询仍严格只接受一个图片原始结果。

## Validation boundary
本次依据官方公开脚本并执行离线测试；未提交真实付费生成，平台对单张数量参数的执行、实际扣费与编辑画面效果仍需显式授权后实测。不把输入校验或 payload 测试当作真实生成成功。
