## Why

Seedance 2.5 的样片是独立的 480p Draft 任务。现有普通 480p 提交缺少 `is_draft_mode`，不能当作样片。

## What Changes

- `production_submit` 增加可选 `draft`，仅接受 Seedance 2.5 + 480p，并在即梦草稿输入中设置 `is_draft_mode` 与对应最低版本。
- Film Studio 新建电影时可选择 `Seedance 2.5（样片模式）`，审核与提交记录显示实际模式，旧 MCP 构建在提交前拒绝。
- 样片下载后仍按现有 Take 流程审核；基于样片任务 ID 的正式版升清暂不包含在本次范围。

## Impact

- Affected specs: film-production-integration.
- Affected code: VideoService、production_submit、Film Studio 模型选择、提示词审核与执行记录。
- 本次请求直接授权增加样片模式；验证采用离线请求检查，不发起付费生成。
