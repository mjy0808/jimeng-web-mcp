# 多项目共享即梦

需要 Node.js 22.19+（22.x）或 24+。在本仓库运行 `npm install`、`npm run build` 后，各项目配置下方 MCP 入口即可。调用方首次连接时自动启动共享服务，后续连接复用同一个服务；关闭项目和空闲不会停止它。不需要提前启动，不添加系统登录自启。

```json
{
  "mcpServers": {
    "jimeng": {
      "command": "node",
      "args": ["/Users/roy/Documents/jimeng-web-mcp/lib/shared-client.js"],
      "env": {
        "JIMENG_PROJECT_ID": "my-project"
      }
    }
  }
}
```

每个项目使用不同且稳定的 `JIMENG_PROJECT_ID`。项目可通过一个入口调用多项任务，不应为每次连接更换项目 ID。Film Studio 已自动按电影与工作目录生成稳定身份，使用同一入口。

服务只监听 `127.0.0.1`，默认动态端口。入口自动从本仓库 `.jimeng-service/connection.json` 读取当前地址与私有访问凭据；该目录已被 Git 忽略，不应提交或分享。调用方无需配置 HTTP 地址、Cookie 或 API Token。

## 登录

生成前调用 `service_check_login`。服务自动打开或复用专用 Chrome，只读取即梦站点的登录 Cookie；首次登录后所有项目共享当前登录态。也可以在仓库运行：

```sh
npm run login:shared
```

复用原 Film Studio 登录资料 `~/Library/Application Support/AI Film Studio/Jimeng`，不要求重新复制 Cookie。凭据不写入任务记录，每次 provider 调用刷新凭据并使用独立子进程。可选 `JIMENG_API_TOKEN` 仅在服务启动环境提供；默认使用浏览器登录。一个服务目录对应一个即梦账号，多账号应使用不同目录、浏览器资料与 CDP 端口。

## 提交、查询与恢复

- `production_submit`：提交一张图片或一段视频。
- `production_edit`：编辑已审核的视频。
- `production_image_edit`：按原图与蒙版进行图片局部重绘。
- `production_promote_check` / `production_promote`：检查样片并提交升清。
- `task_query`：查询原任务。
- `service_check_login`：检查登录，不生成。
- `service_status`：查看本项目的服务队列。

提交前由调用项目持久化 UUID `submitId`。`status: submitted` 表示共享服务已持久接收任务，`serviceStatus` 表示 queued/submitting/submitted 等细分状态，不代表即梦已经开始生成。排队与生成中的 `task_query` 都返回 `processing`；排队任务附带队列位置。

服务默认同时保留最多三项活跃生成，包含上游处理中任务。所有项目共享此上限，其余持久排队；任务完成、失败或明确拒绝后释放位置。这个数值是本地上限，实际平台权限与额度仍以账号为准。

调用方须先检查 MCP 回执的 `isError`，再读取 `structuredContent`。本地 SDK 已对齐到 1.28，参数校验失败也按标准工具错误返回 `isError: true`；它不代表任务入队或已经生成。

相同项目、相同参数重复调用同一个 `submitId` 只返回原回执；更换参数或项目会拒绝。提交前记录会刷盘；响应丢失、崩溃与重启后只查询原任务，永不自动重提。原任务暂未找到时保留不确定状态及其并发位置，不能据此创建新的生成任务。尚未派发的 queued 任务可以在重启后继续派发。

参考素材必须使用当前机器的绝对路径，排队期间保持文件不变。服务入队保存素材 SHA256，提交前复核，变化时拒绝派发。任务账本在 `.jimeng-service/tasks/`，保留它才能保持跨重启的防重复提交保护。迁移前生成的任务仍可通过原 taskId 只读查询；其他项目不能查询或覆盖服务已记录的任务。

## 图片局部编辑

先保存本次任务 UUID 和已审核文件的 SHA256，再调用 `production_image_edit`：

```json
{
  "submitId": "调用方预先保存的 UUID",
  "sourceImage": "/absolute/path/original.png",
  "sourceSha256": "原图的 64 位小写 SHA256",
  "maskImage": "/absolute/path/mask.png",
  "maskSha256": "蒙版的 64 位小写 SHA256",
  "prompt": "将白色选区中的衣服改成红色，保持原有材质和光照"
}
```

原图支持 PNG、JPEG、WebP；蒙版须为 **同尺寸、8 位、不透明灰度 PNG**：白色修改、黑色保留，灰色用于羽化。拒绝彩色、透明、空白与无黑色保留区域的蒙版，不自动反转选区或缩放。原图存在 EXIF 旋转时须先导出方向已校正的图片，再据此制作蒙版。单文件不超过 20 MiB、像素不超过 16MP，属于本地资源限制。提示词最多 800 字符。可选 `strength` 为 0–1，省略时使用平台默认；该接口不接收普通生图的模型或 2K/4K 规格参数。

使用 `shasum -a 256 /absolute/path/original.png` 获取文件 SHA256。原图与蒙版在入队前、派发前和上传前检查；排队期间保留文件不变。

回执与其他生产工具一致：`taskId` 为原 `submitId`，`mediaType` 为 `image`；共享服务的 `submitted` 表示已持久接收，仍需查询。通过 `task_query({ taskId, mediaType: "image" })` 取得原始结果；不重提、不续生成，也不退回整图参考生成。输入两个文件不会被当作两张参考图混合。

本实现依据即梦官方公开前端模块：

- [原生 painting 转换器，模块 419491](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/mweb/static/js/async/8936.17b4db57e1.js)：`postedit_param.generate_type=7`、`origin_uri`、`mask_uri`。
- [Draft 字段序列化](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/mweb/static/js/async/7198.650755846e.js)：图片 painting 能力及字段名称。
- [蒙版导出](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/mweb/static/js/async/6268.8fc1ea58c4.js)：默认导出白色选区、黑色背景，并保留灰度抗锯齿。
- [请求入口与计费场景](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/mweb/static/js/async/5224.0edff0ae3c.js)、[场景参数映射](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/mweb/static/js/async/6050.e08b8c1c40.js)：`to_image_inpaint`、`canvas_inpaint`。

截至 2026-10-15，验证范围为官方脚本核对和离线测试；尚未执行真实付费局部编辑。请求明确指定单结果，但平台实际数量、扣费与画面效果仍待授权实测，异常多结果会被严格拒绝。

## 状态与手动停止

```sh
npm run service:status
npm run service:stop
```

状态命令不会启动服务。手动停止先停止派发与轮询，等待正在执行的 provider 请求结束；已提交的即梦任务继续在平台执行，下次调用启动后恢复查询。停止命令返回后，退出可能需要等待正在进行的上传或提交结束。

## 可选服务配置

以下变量放在启动共享服务的调用方环境中；服务已启动后修改配置须手动停止，再重新连接。

| 变量 | 默认值与作用 |
| --- | --- |
| `JIMENG_SERVICE_DIR` | 本仓库 `.jimeng-service`；所有共用项目必须一致，建议绝对路径 |
| `JIMENG_SERVICE_PORT` | `0`，自动分配本机端口；可指定固定端口 |
| `JIMENG_MAX_CONCURRENT` | `3`，可设 1–8，所有项目的活跃生成总上限 |
| `JIMENG_CDP_URL` | `http://127.0.0.1:9225` |
| `JIMENG_CHROME_PATH` | macOS Google Chrome 标准位置 |
| `JIMENG_PROFILE_DIR` | 原 Film Studio 的专用登录资料目录 |

服务是本机多个项目共用的单账号适配层，上传路径由该机器读取；跨机器接入需要额外的素材上传与访问控制设计。原 `lib/server.js` stdio 入口仍保留，但通过它直接生成的任务不会进入共享并发队列；需要统一账号并发的项目应全部使用 `shared-client.js`。
