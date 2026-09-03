# JiMeng Web MCP Server

> 本地维护仓库：[mjy0808/jimeng-web-mcp](https://github.com/mjy0808/jimeng-web-mcp)。
> 验证本地修改请使用本仓库源码；下文 `npx -y jimeng-web-mcp` 下载的是 npm 发布包，不包含尚未发布的本地修改。

## 本地生图实测

已增加 `jimeng-5.0-lite`（别名 `jimeng-5.0`）→ `high_aes_general_v50`，不改变原来的默认模型。

2026-09-03 首次实测：MCP `image` 提交、`query` 查询、下载成功，但旧请求只在提示词中要求一张，实际返回四张，账号余额减少 12 积分。这是该次请求的结果，不是固定报价。

随后核对即梦网页：数量选择为 1–8；真正的请求字段是 `draft_content.component_list[0].abilities.gen_option.gen_count`，同级 `generate_all` 为 `false`。`metrics_extra.generateCount` 是统计计数，不是出图张数。实现已对齐网页，默认明确请求一张，覆盖文生图与参考图生图；数量异常时报告原任务，不自动续生成或重提。**本次改造只做离线回归，尚未再次付费验证单张结果与扣费。**

字段依据：[官方文生图/参考图转换器](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/jimeng/static/js/async/2821.529655da63.js)、[官方字段序列化定义](https://lf3-lv-buz.vlabstatic.com/obj/image-lvweb-buz/ies/dreamina/web/jimeng/static/js/async/8535.0b68e98a6e.js)。网页内部接口可能变化。

本地测试命令（会消耗即梦积分，需明确允许生成一张）：

```bash
npm ci --ignore-scripts
npm run test:live:image -- /absolute/path/credentials.env ./output/my-test --allow-generate-one
```

`credentials.env` 仅填写 `JIMENG_API_TOKEN=你的sessionid`，放在仓库外。不要把真实凭据写入上游已经跟踪的 `.env`；测试脚本只读取显式指定的文件，不自动加载仓库 `.env`。

测试使用本地源码的 MCP `image` / `query` 工具（内存传输）；发送前核对真实数量字段，最多提交一次，阻止续生成、上传和领取积分，结果必须恰好一张才算通过。已有输出目录再次运行会拒绝重新生成；查询中断时使用：

```bash
npm run test:live:image -- /absolute/path/credentials.env ./output/my-test --resume
```

普通 MCP `image` 同样默认 `count=1`；`image_batch` 总数等于 `prompts.length`。均限制 1–8，超出范围直接拒绝，不静默截断或拆单。只有显式请求超过四张且服务端目标数量与请求一致的任务，才保留旧的批次续生成；单张任务不会自动续生成。此轮尚未接入 AI Film Studio。

<div align="center">

[![npm version](https://img.shields.io/npm/v/jimeng-web-mcp.svg)](https://www.npmjs.com/package/jimeng-web-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-1.10-green.svg)](https://modelcontextprotocol.io/)

基于TypeScript的Model Context Protocol (MCP) 服务器，直接访问即梦AI Web端

**🚀 直接访问Web端 | 每日免费积分 | 最新功能支持 | 组合模式架构 | 100%类型安全**

[English](./README.en.md) | 中文

</div>

---

## ⚠️ 免责声明

**本项目仅供学习和研究使用，请勿用于商业或其他用途。**

- 本项目通过技术手段访问即梦AI Web端接口
- 使用本项目需遵守即梦AI的服务条款
- 因使用本项目产生的任何问题，开发者不承担责任
- 建议仅在学习研究场景下使用，不要滥用API接口

---

## ✨ 核心特性

### 🎨 图像生成
- **明确数量控制** - 默认一张，使用 `count` 指定 1–8 张，不从 prompt 推断消费数量
- **系列图生成** - 专用于高相关性场景：房间系列、故事分镜、产品多角度
- **多参考图混合** - 支持最多4张参考图，可控制每张强度
- **同步/异步模式** - 灵活选择即时返回或后台生成

### 🎬 视频生成
- **纯文本生成** - 从prompt直接创建视频
- **首尾帧控制** - 精确控制视频起止画面
- **多帧动画** - 2-10个关键帧，系统自动补间平滑过渡
- **主体融合** - 将多张图片的主体组合到一个场景（使用`[图0]`语法）

### 💰 免费积分优势
- **每日免费积分** - 每天可获得60-80免费积分，无需付费
- **最新功能支持** - 直接访问Web端，第一时间体验新功能
- **无需API密钥** - 只需登录账号获取sessionid即可使用

### 🏗️ 现代化架构
- **组合模式设计** - 74.6%代码减少（5,268行 → 1,335行）
- **零安装部署** - npx自动安装，无需手动配置
- **TypeScript + Zod** - 完整类型定义和运行时验证
- **100%向后兼容** - 无缝升级，现有代码无需修改

---

## 🚀 快速开始

### 1. 获取API Token

1. 访问 [即梦AI官网](https://jimeng.jianying.com) 并登录
2. 按 `F12` 打开开发者工具
3. 进入 `Application` > `Cookies`
4. 复制 `sessionid` 的值

### 2. 配置Claude Desktop

编辑Claude Desktop配置文件：
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

添加以下配置：

```json
{
  "mcpServers": {
    "jimeng-web-mcp": {
      "command": "npx",
      "args": ["-y", "jimeng-web-mcp"],
      "env": {
        "JIMENG_API_TOKEN": "你的sessionid"
      }
    }
  }
}
```

### 3. 重启Claude Desktop

配置完成！现在可以在Claude中使用即梦AI生成功能。

---

## 🛠️ MCP工具列表

### 图像生成 (2个工具)

| 工具 | 默认模式 | 适用场景 | 说明 |
|------|---------|---------|------|
| `image` | 同步 | 单图/多图生成 | 默认一张；通过 `count` 明确指定 1–8 张 |
| `image_batch` | 异步 | 高相关性系列图 | 房间系列、故事分镜、产品多角度 |

### 视频生成 (4个工具)

| 工具 | 默认模式 | 适用场景 | 说明 |
|------|---------|---------|------|
| `video` | 异步 | 纯文本生成视频 | 从prompt直接创建 |
| `video_frame` | 异步 | 首尾帧控制 | 支持首帧、尾帧或两者 |
| `video_multi` | 异步 | 多帧动画 | 2-10个关键帧，系统补间 |
| `video_mix` | 异步 | 主体融合 | 用`[图0]`语法引用多张图 |

### 查询与工具 (3个工具)

| 工具 | 说明 |
|------|------|
| `query` | 查询单个任务状态和结果 |
| `query_batch` | 批量查询最多10个任务 |
| `ping` | 测试服务器连接 |

### 后处理 (1个工具)

| 工具 | 说明 |
|------|------|
| `video_post_process` | 帧插值、超分辨率、音效生成（开发中） |

---

## 📸 图像生成详解

### `image` - 单图/多图生成

#### 核心特性
- ✅ **真实数量参数** - 默认 `count=1`，不依赖提示词中的数量描述
- ✅ **受限批次续生成** - 仅对显式多图请求且返回数量一致的任务自动确认
- ✅ **一次性返回** - 等待所有图片完成，统一返回结果
- ✅ **多参考图支持** - 最多4张参考图，可单独控制强度

#### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | ✅ | - | 图片内容描述；不负责数量控制 |
| `count` | integer | ❌ | 1 | 实际请求图片总数，1–8 |
| `filePath` | string[] | ❌ | - | 参考图路径数组（最多4张） |
| `model` | string | ❌ | jimeng-4.0 | 模型名称 |
| `aspectRatio` | string | ❌ | auto | 宽高比：auto/1:1/16:9/9:16/3:4/4:3/3:2/2:3/21:9 |
| `sample_strength` | number | ❌ | 0.5 | 参考图影响强度 (0-1) |
| `reference_strength` | number[] | ❌ | - | 每张参考图独立强度 |
| `negative_prompt` | string | ❌ | - | 负面提示词 |
| `async` | boolean | ❌ | false | 是否异步模式 |

#### 使用示例

**示例1: 明确请求一张**
```typescript
// Claude中直接说：
"请用image工具生成一张可爱橘猫图片"

// 工具调用：
{
  "prompt": "可爱的橘猫坐在窗边，柔和晨光",
  "model": "jimeng-5.0-lite",
  "count": 1,
  "async": false
}

// 请求的目标数量：1 张；服务端数量异常时报告原任务，不自动重试。
```

**示例2: 多参考图混合**
```typescript
{
  "prompt": "梵高星空风格的城市夜景",
  "filePath": [
    "/path/to/starry-night.jpg",
    "/path/to/city.jpg"
  ],
  "reference_strength": [0.7, 0.3],
  "async": false
}
```

#### 继续生成机制说明

**工作原理**：
1. 使用 `count` 明确请求总数量，`image_batch` 使用描述数组长度
2. 若服务端在四张后暂停，仅当目标总数与原始请求一致且大于四张时，自动发送 `action=2`
3. 单张请求、无原请求缓存或目标数量不符时，绝不自动续生成

**重要特性**：
- ✅ **单次确认**：只发送一次继续请求，不是循环生成
- ✅ **显式授权数量**：以 `gen_option.gen_count` 为准，提示词不能扩大出图预算
- ✅ **完整等待**：同步模式会等待所有图片完成

---

### `image_batch` - 系列图生成

#### 适用场景

**✅ 推荐使用场景**：
- 同一房子的不同空间（客厅、卧室、厨房、书房）
- 故事连续分镜（场景1、场景2、场景3）
- 绘本不同页面（第1页、第2页、第3页）
- 产品多角度展示（正面、侧面、背面、细节）

**❌ 不适用场景**：
- 完全无关的独立图片
- 单张图片生成（请用`image`）

#### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompts` | string[] | ✅ | - | 每张图的差异描述（1–8个），长度即请求总数 |
| `basePrompt` | string | ❌ | - | 整体通用描述，添加在最前面 |
| `filePath` | string[] | ❌ | - | 可选参考图（影响整体风格） |
| `model` | string | ❌ | jimeng-4.0 | 模型名称 |
| `aspectRatio` | string | ❌ | auto | 宽高比 |
| `sample_strength` | number | ❌ | 0.5 | 参考图强度 |
| `async` | boolean | ❌ | true | 是否异步模式 |

#### 使用示例

**示例1: 房间系列**
```typescript
{
  "basePrompt": "三室两厅现代简约风格，木地板，暖色调照明，简约家具",
  "prompts": [
    "客厅，灰色布艺沙发靠窗，落地窗洒入阳光，茶几上放着杂志和遥控器",
    "主卧室，米色床品整齐铺展，木质床头柜上有台灯，墙面淡蓝色乳胶漆",
    "开放式厨房，白色橱柜整齐排列，大理石台面，中岛台上摆放水果篮",
    "书房，木质书架靠墙摆放，书桌上有笔记本电脑，窗外绿植清晰可见",
    "儿童房，彩色玩具收纳柜，小床上铺着卡通床品，墙上贴着儿童画"
  ],
  "async": true
}

// 最终prompt格式：
// "三室两厅现代简约风格，木地板，暖色调照明，简约家具 第1张：客厅... 第2张：主卧室... 一共5张图"
```

**示例2: 产品多角度**
```typescript
{
  "basePrompt": "苹果AirPods Pro 2代，白色陶瓷材质，磨砂质感，苹果logo清晰",
  "prompts": [
    "正面特写，充电盒开盖状态，耳机在盒内，LED指示灯可见",
    "侧面45度角，展示充电盒厚度和圆润边缘，耳机柄部分露出",
    "背面视角，充电口特写，序列号区域清晰，磁吸接触点可见"
  ],
  "async": false
}
```

**⚠️ 错误示例**：
```typescript
// ❌ prompts过于简短，缺少差异描述
{
  "prompts": ["客厅", "卧室", "厨房"]  // 太简单！
}

// ✅ 正确做法：每个prompt应该是一小段话
{
  "prompts": [
    "客厅，灰色沙发靠窗，阳光洒入...",
    "卧室，米色床品，木质床头柜...",
    "厨房，白色橱柜，大理石台面..."
  ]
}
```

---

## 🎬 视频生成详解

### `video` - 纯文本生成视频

#### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | ✅ | - | 视频描述 |
| `model` | string | ❌ | jimeng-video-3.0 | 视频模型，新增 `seedance-2.0` / `seedance-2.5` |
| `resolution` | string | ❌ | 720p | 2.0 仅720p；2.5 支持480p/720p/1080p；旧模型720p/1080p |
| `fps` | number | ❌ | 24 | Seedance 固定24；旧模型12-30 |
| `duration` | number | ❌ | 5000 | 毫秒：2.0 为4000-15000，2.5 为4000-30000，均须整秒；旧模型3000-15000 |
| `videoAspectRatio` | string | ❌ | 16:9 | 宽高比 |
| `async` | boolean | ❌ | true | 是否异步 |

#### 使用示例

```typescript
{
  "prompt": "一只小狗在草地上奔跑，阳光明媚，镜头跟随，高清画质",
  "resolution": "1080p",
  "fps": 30,
  "duration": 5000,
  "async": true
}
```

---

### `video_frame` - 首尾帧控制

#### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | ✅ | - | 视频描述 |
| `firstFrameImage` | string | ❌ | - | 首帧图片路径 |
| `lastFrameImage` | string | ❌ | - | 尾帧图片路径 |
| 其他参数 | - | - | - | 同`video` |

#### 使用示例

```typescript
{
  "prompt": "从白天到夜晚的城市延时摄影",
  "firstFrameImage": "/path/to/day.jpg",
  "lastFrameImage": "/path/to/night.jpg",
  "resolution": "1080p",
  "async": true
}
```

---

### `video_multi` - 多帧动画

#### 核心概念

**关键帧过渡动画**：提供2-10个关键帧图片，系统在帧间生成平滑过渡。

**⚠️ 重要**：每帧的`prompt`描述的是"从当前帧到下一帧的过渡过程"，包括：
1. **镜头移动**：推进、拉远、摇移、跟随
2. **画面变化**：主体动作、场景变化、光影变化
3. **转场效果**：淡入淡出、切换方式

**最后一帧的prompt不生效**（因为没有下一帧），可以留空或随意填写。

#### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `frames` | Frame[] | ✅ | 关键帧数组（2-10个） |
| `frames[].idx` | number | ✅ | 帧序号（从0开始） |
| `frames[].imagePath` | string | ✅ | 帧图片绝对路径 |
| `frames[].duration_ms` | number | ✅ | 过渡时长（1000-6000毫秒） |
| `frames[].prompt` | string | ✅ | 过渡过程描述 |
| 其他参数 | - | - | 同`video`的旧模型参数；不支持 Seedance 2.0/2.5 |

#### 使用示例

```typescript
{
  "frames": [
    {
      "idx": 0,
      "imagePath": "/path/frame0.jpg",
      "duration_ms": 2000,
      "prompt": "镜头从正面缓慢推进，猫从坐姿站起，光线从左侧照入"
    },
    {
      "idx": 1,
      "imagePath": "/path/frame1.jpg",
      "duration_ms": 2000,
      "prompt": "猫向前迈步行走，尾巴自然摇摆，背景虚化效果增强"
    },
    {
      "idx": 2,
      "imagePath": "/path/frame2.jpg",
      "duration_ms": 1000,
      "prompt": "（最后一帧，此prompt不生效）"
    }
  ],
  "fps": 24,
  "resolution": "720p",
  "async": true
}

// 生成效果（总时长5秒）：
// 0-2秒：显示frame0 + 执行"站起来"动画 → 渐变到frame1
// 2-4秒：显示frame1 + 执行"行走"动画 → 渐变到frame2
// 4-5秒：显示frame2作为结尾画面
```

---

### `video_mix` - 主体融合

#### 核心特性

将多张图片的主体组合到一个场景中，使用`[图0]`、`[图1]`语法引用。

#### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `referenceImages` | string[] | ✅ | 参考图路径数组（2-4张） |
| `prompt` | string | ✅ | 必须包含`[图N]`引用 |
| 其他参数 | - | - | 同`video`的旧模型参数；不支持 Seedance 2.0/2.5 |

#### 使用示例

**示例1: 角色换场景**
```typescript
{
  "referenceImages": [
    "/path/cat.jpg",
    "/path/floor.jpg"
  ],
  "prompt": "[图0]中的猫在[图1]的地板上奔跑",
  "async": true
}
```

**示例2: 多元素组合**
```typescript
{
  "referenceImages": [
    "/path/person.jpg",
    "/path/car.jpg",
    "/path/beach.jpg"
  ],
  "prompt": "[图0]中的人坐在[图1]的车里，背景是[图2]的海滩日落景色",
  "resolution": "1080p",
  "async": true
}
```

---

## 🔍 查询工具

### `query` - 查询单个任务

```typescript
{
  "historyId": "4761818115596"
}

// 返回：
{
  "status": "completed",
  "progress": 100,
  "imageUrls": ["https://...", "https://...", ...]
}
```

### `query_batch` - 批量查询

```typescript
{
  "historyIds": [
    "4761818115596",
    "4761818115597",
    "1e06b3c9-bd41-46dd-8889-70f2c61f66bb"  // 视频ID
  ]
}

// 返回：
{
  "4761818115596": { "status": "completed", "imageUrls": [...] },
  "4761818115597": { "status": "processing", "progress": 45 },
  "1e06b3c9-...": { "status": "completed", "videoUrl": "https://..." }
}
```

---

## 💻 本地开发

### 安装依赖

```bash
# 使用npm
npm install

# 或使用yarn
yarn install
```

### 开发命令

```bash
# 开发模式（热重载）
npm run dev

# 类型检查
npm run type-check

# 构建项目
npm run build

# 运行测试
npm test

# 测试覆盖率
npm run test:coverage

# 测试MCP服务器
npm run test:mcp
```

### 启动服务器

```bash
# MCP stdio模式
npm start

# HTTP API服务模式
npm run start:api
```

---

## 🤔 常见问题

### 1. 图像生成失败

**检查清单**：
- ✅ `JIMENG_API_TOKEN`是否正确配置
- ✅ 即梦账号积分是否充足（[登录查看](https://jimeng.jianying.com)）
- ✅ 提示词是否包含敏感内容
- ✅ 参考图路径是否有效（网络图需可公开访问）

### 2. 继续生成未触发

**排查步骤**：
- ✅ `count` 是否明确指定大于四张（最大八张）
- ✅ API 返回的 `totalCount` 是否与请求数量一致；不一致不要自动重新提交
- ✅ 检查是否在同步模式下（async: false）
- ✅ 查看日志中的`[智能继续生成检测]`信息

### 3. 服务器无法启动

**解决方法**：
- ✅ 确保Node.js版本 ≥ 16.0
- ✅ 重新安装依赖：`rm -rf node_modules && npm install`
- ✅ 检查环境变量是否正确设置

### 4. 视频生成超时

**调整建议**：
- ✅ 使用异步模式（async: true）
- ✅ 降低分辨率（720p代替1080p）
- ✅ 减少视频时长（推荐5秒）
- ✅ 简化prompt描述

---

## 🎯 支持的模型

### 图片模型

| 模型名称 | 说明 | 推荐场景 |
|---------|------|---------|
| `jimeng-5.0-lite` / `jimeng-5.0` | 图片 5.0 Lite，已实测 | 文生图 |
| `jimeng-4.5` | 图片 4.5（默认） | 通用图像生成 |
| `jimeng-4.1` | 图片 4.1 | 图像设计 |
| `jimeng-4.0` | 图片 4.0 | 通用图像生成 |
| `jimeng-3.0` | 第三代模型，画面鲜明 | 风格化创作 |
| `jimeng-2.1` | 稳定版本 | 常规生成 |
| `jimeng-2.0-pro` | Pro版本 | 高质量需求 |

### 视频模型

| 模型名称 | 说明 | 推荐场景 |
|---------|------|---------|
| `seedance-2.0` | 即梦 Seedance 2.0 标准版，720p、4-15秒、24fps | `video` / `video_frame` |
| `seedance-2.5` | 即梦 Seedance 2.5，480p/720p/1080p、4-30秒、24fps | `video` / `video_frame` |
| `jimeng-video-3.0` | 主力模型（默认） | 全场景推荐 |
| `jimeng-video-3.0-pro` | Pro高质量版本 | 专业级作品 |
| `jimeng-video-2.0-pro` | 兼容性好 | 多场景适配 |

`seedance-2.0` 不等于旧的 `jimeng-video-2.0`，也不会自动切换为 Fast 或 VIP 版。默认模型不变。

映射和能力取自 2026-09-03 [即梦网页](https://jimeng.jianying.com/ai-tool/generate) 的 `video_generate/get_common_config` 配置：2.0 为 `dreamina_seedance_40_pro`，2.5 为 `dreamina_seedance_45_pro`。本地会在上传前拒绝不支持的参数组合，不自动替换模型或重试付费任务。是否可调用仍取决于账号权限及网页服务；本次仅完成参数构建和离线测试，未进行付费视频生成验证。

旧 `video_multi` / `video_mix` 的多帧/主体融合协议不等同于 Seedance 的全能参考；本次没有接入全能参考、视频编辑或长视频分镜模式。

例如调用 `video`：

```json
{
  "model": "seedance-2.5",
  "prompt": "镜头缓慢前移，一只猫走到窗边坐下，抬头看向窗外，窗帘随风轻轻摆动",
  "resolution": "720p",
  "duration": 5000,
  "fps": 24,
  "async": true
}
```

---

## 📊 架构亮点

### 组合模式设计

```typescript
class NewJimengClient {
  private httpClient: HttpClient              // HTTP请求和认证
  private imageUploader: ImageUploader        // 图片上传
  private creditService: NewCreditService     // 积分管理
  private videoService: VideoService          // 视频生成

  constructor(token?: string) {
    this.httpClient = new HttpClient(token);
    this.imageUploader = new ImageUploader(this.httpClient);
    this.creditService = new NewCreditService(this.httpClient);
    this.videoService = new VideoService(this.httpClient, this.imageUploader);
  }
}
```

### 代码减少对比

| 指标 | 重构前 | 重构后 | 改进 |
|------|-------|-------|------|
| 总代码行数 | 5,268行 | 1,335行 | **-74.6%** |
| 核心类数量 | 9个 | 5个 | **-44.4%** |
| 继承层级 | 3层 | 0层 | **扁平化** |
| 类型安全 | 部分 | 完整 | **100%** |

---

## 📦 手动安装（可选）

如果不使用npx方式，可以手动安装：

```bash
# 全局安装
npm install -g jimeng-web-mcp

# 或项目内安装
npm install jimeng-web-mcp
```

**Claude Desktop配置**：
```json
{
  "mcpServers": {
    "jimeng-web-mcp": {
      "command": "node",
      "args": ["/path/to/jimeng-web-mcp/lib/index.js"],
      "env": {
        "JIMENG_API_TOKEN": "你的sessionid"
      }
    }
  }
}
```

---

## 🤝 贡献

欢迎提交Issue和Pull Request！

---

## 📄 许可证

[MIT License](./LICENSE)

---

## 🔗 相关链接

- **GitHub仓库**: [LupinLin1/jimeng-web-mcp](https://github.com/LupinLin1/jimeng-web-mcp)
- **npm包**: [jimeng-web-mcp](https://www.npmjs.com/package/jimeng-web-mcp)
- **即梦AI官网**: [jimeng.jianying.com](https://jimeng.jianying.com)
- **MCP协议**: [modelcontextprotocol.io](https://modelcontextprotocol.io)

---

<div align="center">

**⭐ 如果这个项目对你有帮助，请给个Star支持一下！**

Made with ❤️ by [LupinLin1](https://github.com/LupinLin1)

</div>
