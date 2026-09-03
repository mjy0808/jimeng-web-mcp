// 🔇 MCP服务器禁用DEBUG日志（必须在所有import之前）
// MCP协议使用stdio通信，任何非JSON-RPC格式的输出都会导致连接失败
// 必须在import logger之前设置，否则logger初始化时会读取旧值
process.env.DEBUG = 'false';

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { generateImage, getImageResult, getApiClient } from "./api.js";
import { logger } from './utils/logger.js';
import { MAX_IMAGE_COUNT } from './types/constants.js';
import { DEFAULT_VIDEO_MODEL } from './types/models.js';
import { legacyVideoModelSchema, textToVideoControls } from './schemas/video.schemas.js';
import { registerProductionTools } from './production-tools.js';

// 服务器启动调试信息
logger.debug('server.ts loaded', { timestamp: new Date().toISOString() });
logger.debug('Node.js version', { version: process.version });
logger.debug('Working directory', { cwd: process.cwd() });
logger.debug('Environment token available', { available: !!process.env.JIMENG_API_TOKEN });
logger.debug('Environment token length', { length: process.env.JIMENG_API_TOKEN?.length || 'N/A' });

// 定义服务器返回类型接口
export interface ServerInstance {
  server: McpServer;
  transport: StdioServerTransport;
}

// 创建MCP服务器
export const createServer = (): McpServer => {
  logger.debug('Creating MCP server instance...');

  const server = new McpServer({
    name: "Jimeng MCP Server",
    version: "1.0.0"
  });

  logger.debug('MCP server instance created successfully');
  registerProductionTools(server);

  server.tool(
    "ping",
    "测试服务器连接",
    {
      name: z.string().describe("姓名")
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `你好，${name}！JiMeng MCP 服务器运行正常。` }]
    })
  );

  logger.debug('Registering image tool...');

  server.tool(
    "image",
    "生成图像，默认只请求一张；仅在用户明确要求多张时增加 count",
    {
      filePath: z.array(z.string()).optional().describe("参考图绝对路径数组，最多4张"),
      prompt: z.string().describe("图像描述文本"),
      count: z.number().int().min(1).max(MAX_IMAGE_COUNT).default(1).describe("实际请求的图片总数，1–8，默认1；不是下载数量，不由提示词决定"),
      model: z.string().optional().describe("模型名称，支持: jimeng-5.0-lite (图片 5.0 Lite), jimeng-4.5 (默认), jimeng-4.1, jimeng-4.0, jimeng-3.1, jimeng-3.0"),
      aspectRatio: z.string().optional().default("auto").describe("宽高比: auto/1:1/16:9/9:16/3:4/4:3/3:2/2:3/21:9"),
      resolution: z.enum(["2k", "4k"]).optional().default("2k").describe("分辨率选择，2k或4k，默认2k"),
      sample_strength: z.number().min(0).max(1).optional().default(0.5).describe("参考图影响强度0-1，默认0.5"),
      negative_prompt: z.string().optional().default("").describe("负向提示词"),
      reference_strength: z.array(z.number().min(0).max(1)).optional().describe("每张参考图的独立强度数组"),
      async: z.boolean().optional().default(false).describe("是否异步模式，默认false（同步）"),
    },
    async (params) => {
      // 🔥 [MCP DEBUG] Tool call entry point - this is the CRITICAL debugging point
      logger.debug('=================================');
      logger.debug('generateImage tool called!');
      logger.debug('Timestamp', { timestamp: new Date().toISOString() });
      logger.debug('Raw params received', { params: JSON.stringify(params, null, 2) });
      logger.debug('=================================');
      try {
        // 🔇 [MCP] console.log已禁用 - MCP协议使用stdio，任何输出都会破坏JSON-RPC通信
        // console.log('🔍 [MCP Server] Received raw parameters:', JSON.stringify(params, null, 2));

        const hasToken = !!process.env.JIMENG_API_TOKEN;
        // console.log('🔍 [MCP Server] Environment token available:', hasToken);
        // if (hasToken) {
        //   console.log('🔍 [MCP Server] Token length:', process.env.JIMENG_API_TOKEN?.length);
        // }

        // console.log('🔍 [MCP Server] Validated parameters for API call:');
        // console.log('  - filePath:', params.filePath || 'undefined');
        // console.log('  - prompt:', params.prompt ? `"${params.prompt.substring(0, 50)}..."` : 'undefined');
        // console.log('  - model:', params.model || 'undefined');
        // console.log('  - aspectRatio:', params.aspectRatio || 'undefined');
        // console.log('  - sample_strength:', params.sample_strength);
        // console.log('  - negative_prompt:', params.negative_prompt || 'empty');
        // console.log('  - reference_strength:', params.reference_strength ? `[${params.reference_strength.join(', ')}]` : 'undefined');

        const imageUrls: string[] | string = await generateImage({
          filePath: params.filePath,
          prompt: params.prompt,
          model: params.model,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          sample_strength: params.sample_strength,
          negative_prompt: params.negative_prompt,
          reference_strength: params.reference_strength,
          async: params.async,
          count: params.count,
          refresh_token: process.env.JIMENG_API_TOKEN
        } as any);

        // 如果没有返回URL数组，返回错误信息
        if (!imageUrls || (Array.isArray(imageUrls) && imageUrls.length === 0)) {
          return {
            content: [{ type: "text", text: "图像生成失败：未能获取图像URL" }],
            isError: true
          };
        }


        // 将返回的图像URL转换为MCP响应格式
        // 使用单个文本内容，每行一个URL，方便客户端解析
        let responseText = '';

        if (typeof imageUrls === 'string') {
          // 单个URL的情况（异步模式返回historyId）
          responseText = imageUrls;
        } else if (Array.isArray(imageUrls)) {
          // URL数组的情况（同步模式返回URLs），每行一个URL
          responseText = (imageUrls as string[]).join('\n');
        }

        return {
          content: [{
            type: "text",
            text: responseText
          }]
        };
      } catch (error) {
        // 🔍 Debug logging - 记录详细错误信息 (使用logger以避免破坏stdio)
        logger.debug('🔍 [MCP Server] Error caught in generateImage tool');
        logger.debug(`🔍 [MCP Server] Error type: ${error?.constructor?.name}`);
        logger.debug(`🔍 [MCP Server] Error message: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
          logger.debug(`🔍 [MCP Server] Error stack: ${error.stack}`);
        }

        // 🔍 记录错误时的参数状态
        logger.debug(`🔍 [MCP Server] Parameters when error occurred: ${JSON.stringify({
          filePath: params.filePath,
          prompt: params.prompt ? `${params.prompt.substring(0, 100)}...` : undefined,
          model: params.model,
          aspectRatio: params.aspectRatio,
          sample_strength: params.sample_strength,
          negative_prompt: params.negative_prompt
        }, null, 2)}`);

        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `图像生成失败: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  logger.debug('image tool registered successfully');

  logger.debug('Registering image_batch tool...');

  server.tool(
    "image_batch",
    "系列图片生成 - 用于生成高相关性的连续图片（如：房间系列、故事分镜、绘本画面、产品多角度）",
    {
      prompts: z.array(z.string()).min(1).max(MAX_IMAGE_COUNT).describe("每张图片的完整描述数组（1–8个），实际请求总数等于数组长度。每个描述重点写该图与其他图的差异。示例：[\"现代客厅，灰色沙发靠窗，阳光洒入\", \"温馨卧室，米色床品，木质床头柜\"]"),
      basePrompt: z.string().optional().default("").describe("整体通用描述，会添加在最终prompt最前面。用于描述：产品基础信息（材质、颜色）、房子整体风格（三室两厅现代简约）、故事背景设定（赛博朋克世界观）等通用信息。示例：\"三室两厅现代简约风格，木地板，暖色调照明\""),
      async: z.boolean().optional().default(true).describe("是否异步模式，默认true（异步）"),
      filePath: z.array(z.string()).optional().describe("可选参考图路径（影响整体风格，最多4张）"),
      aspectRatio: z.string().optional().default("auto").describe("宽高比: auto/1:1/16:9/9:16/3:4/4:3/3:2/2:3/21:9"),
      resolution: z.enum(["2k", "4k"]).optional().default("2k").describe("分辨率选择，2k或4k，默认2k"),
      model: z.string().optional().describe("模型名称，支持: jimeng-5.0-lite (图片 5.0 Lite), jimeng-4.5 (默认), jimeng-4.1, jimeng-4.0"),
      sample_strength: z.number().min(0).max(1).optional().default(0.5).describe("参考图影响强度0-1，默认0.5"),
      negative_prompt: z.string().optional().default("").describe("负向提示词"),
      reference_strength: z.array(z.number().min(0).max(1)).optional().describe("每张参考图的独立强度数组"),
    },
    async (params) => {
      try {
        logger.debug('image_batch tool called with params', { params: JSON.stringify(params, null, 2) });

        // 使用prompts数组和其长度
        const count = params.prompts.length;

        const result = await generateImage({
          prompt: params.basePrompt || '', // 使用basePrompt作为基础prompt
          frames: params.prompts, // 使用prompts作为frames
          count: count, // 数量由prompts.length决定
          filePath: params.filePath,
          model: params.model,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          sample_strength: params.sample_strength,
          negative_prompt: params.negative_prompt,
          reference_strength: params.reference_strength,
          async: params.async,
          refresh_token: process.env.JIMENG_API_TOKEN!
        } as any);

        // 异步模式返回taskId
        if (params.async !== false) {
          const taskId = typeof result === 'string' ? result : (result as any).taskId || result;
          return {
            content: [{
              type: "text",
              text: `✅ 批量图像生成任务已提交！\n\n📋 任务ID: ${taskId}\n🖼️  数量: ${count}张\n\n💡 使用 query 工具查询状态`
            }]
          };
        } else {
          // 同步模式返回URLs
          const imageUrls = Array.isArray(result) ? result : [result];
          return {
            content: [{
              type: "text",
              text: imageUrls.join('\n')
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('image_batch failed', { error: errorMessage });
        return {
          content: [{ type: "text", text: `❌ 批量生成失败: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  logger.debug('image_batch tool registered successfully');

  // ============== 查询工具 ==============

  logger.debug('Registering query tool...');

  server.tool(
    "query",
    "查询任务状态和结果",
    {
      historyId: z.string().regex(/^([0-9]+|h[a-zA-Z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i).describe("任务ID")
    },
    async ({ historyId }) => {
      try {
        logger.debug('getImageResult tool called with historyId', { historyId });

        const result = await getImageResult(historyId);

        logger.debug('Query result', { result: JSON.stringify(result, null, 2) });

        // 格式化响应
        if (result.status === 'completed') {
          // 完成状态
          let resultText = `✅ 生成完成！\n\n状态: completed\n进度: 100%\n\n`;

          if (result.imageUrls && result.imageUrls.length > 0) {
            resultText += `生成结果 (${result.imageUrls.length}张):\n${result.imageUrls.map((url: string) => `- ${url}`).join('\n')}`;
          } else if (result.videoUrl) {
            resultText += `视频URL: ${result.videoUrl}`;
          }

          // 🔥 显示智能继续生成提示
          if (result.needs_more) {
            resultText += `\n\n⚠️  ${result.message || '还有更多图片正在生成，请稍后再次查询'}`;
          }

          return {
            content: [{ type: "text", text: resultText }]
          };
        } else if (result.status === 'failed') {
          // 失败状态
          return {
            content: [{
              type: "text",
              text: `❌ 生成失败\n\n状态: failed\n进度: ${result.progress}%\n错误: ${result.error || '未知错误'}`
            }],
            isError: true
          };
        } else {
          // 进行中状态
          const statusEmoji = result.status === 'pending' ? '⏳' : '🔄';
          let debugInfo = '';
          // 添加调试信息（如果存在）
          if (result.totalCount || result.finishedCount) {
            debugInfo = `\n\n🔍 调试信息:\n- 总目标: ${result.totalCount || 'N/A'}张\n- 已完成: ${result.finishedCount || 'N/A'}张\n- 当前返回: ${result.itemCount || 'N/A'}张`;
          }
          // 添加智能继续生成调试信息
          if (result._debug) {
            debugInfo += `\n\n🔧 继续生成调试:\n- 应触发: ${result._debug.shouldTriggerContinuation ? '✅ 是' : '❌ 否'}\n- 有缓存: ${result._debug.hasCacheEntry ? '✅ 是' : '❌ 否'}\n- 已发送: ${result._debug.continuationSent ? '✅ 是' : '❌ 否'}`;
          }
          return {
            content: [{
              type: "text",
              text: `${statusEmoji} 生成中...\n\n状态: ${result.status}\n进度: ${result.progress}%${debugInfo}`
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('getImageResult failed', { error: errorMessage });
        return {
          content: [{ type: "text", text: `❌ 查询失败: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  logger.debug('query tool registered successfully');

  // logger.debug('Registering query_batch tool...');

  // server.tool(
  //   "query_batch",
  //   "批量查询多个任务",
  //   {
  //     historyIds: z.array(z.string().regex(/^([0-9]+|h[a-zA-Z0-9]+)$/)).max(10).describe("任务ID数组，最多10个")
  //   },
  //   async ({ historyIds }) => {
  //     try {
  //       const client = getApiClient();
  //       const results = await client.getBatchResults(historyIds);

  //       // 格式化响应
  //       let resultText = `📊 批量查询结果 (${Object.keys(results).length}/${historyIds.length})\n\n`;

  //       for (const [id, result] of Object.entries(results)) {
  //         const typedResult = result as any; // Type assertion for DTS build
  //         if ('error' in typedResult) {
  //           resultText += `❌ ${id}: ${typedResult.error}\n\n`;
  //         } else {
  //           const statusEmoji = typedResult.status === 'completed' ? '✅' : typedResult.status === 'failed' ? '❌' : '🔄';
  //           resultText += `${statusEmoji} ${id}:\n`;
  //           resultText += `  状态: ${typedResult.status}\n`;
  //           resultText += `  进度: ${typedResult.progress}%\n`;

  //           if (typedResult.videoUrl) {
  //             resultText += `  视频: ${typedResult.videoUrl}\n`;
  //           } else if (typedResult.imageUrls && typedResult.imageUrls.length > 0) {
  //             resultText += `  图片: ${typedResult.imageUrls.length}张\n`;
  //           }

  //           if (typedResult.error) {
  //             resultText += `  错误: ${typedResult.error}\n`;
  //           }
  //           resultText += `\n`;
  //         }
  //       }

  //       return {
  //         content: [{ type: "text", text: resultText }]
  //       };
  //     } catch (error) {
  //       const errorMessage = error instanceof Error ? error.message : String(error);
  //       return {
  //         content: [{ type: "text", text: `❌ 批量查询失败: ${errorMessage}` }],
  //         isError: true
  //       };
  //     }
  //   }
  // );

  // logger.debug('query_batch tool registered successfully');

  // ============== 新的视频生成工具 ==============

  logger.debug('Registering video tool...');

  server.tool(
    "video",
    "纯文字生成视频",
    {
      prompt: z.string().min(1).describe("视频描述文本"),
      async: z.boolean().optional().default(true).describe("是否异步模式，默认true（异步）"),
      ...textToVideoControls,
      videoAspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional().default("16:9").describe("视频宽高比"),
    },
    async (params: any) => {
      try {
        const client = getApiClient();
        const result = await client.generateTextToVideo(params as any);

        if (result.taskId) {
          // 异步模式
          return {
            content: [{
              type: "text",
              text: `✅ 视频生成任务已提交！\n\n📋 任务ID: ${result.taskId}\n\n💡 使用 query 工具查询状态`
            }]
          };
        } else {
          // 同步模式
          return {
            content: [{
              type: "text",
              text: `✅ 视频生成完成\n\n🎥 视频URL: ${result.videoUrl}`
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `❌ 视频生成失败: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  logger.debug('video tool registered successfully');

  logger.debug('Registering video_frame tool...');

  server.tool(
    "video_frame",
    "首尾帧控制视频",
    {
      prompt: z.string().min(1).describe("视频描述文本"),
      firstFrameImage: z.string().optional().describe("首帧图片路径"),
      lastFrameImage: z.string().optional().describe("尾帧图片路径"),
      async: z.boolean().optional().default(true).describe("是否异步模式，默认true（异步）"),
      ...textToVideoControls,
      videoAspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional().default("16:9").describe("视频宽高比"),
    },
    async (params: any) => {
      try {
        const client = getApiClient();
        const result = await client.generateTextToVideo(params as any);

        if (result.taskId) {
          return {
            content: [{
              type: "text",
              text: `✅ 首尾帧视频任务已提交！\n\n📋 任务ID: ${result.taskId}\n\n💡 使用 query 工具查询状态`
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: `✅ 首尾帧视频生成完成\n\n🎥 视频URL: ${result.videoUrl}`
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `❌ 首尾帧视频失败: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  logger.debug('video_frame tool registered successfully');

  server.tool(
    "video_multi",
    "关键帧动画视频 - 提供2-10个关键帧图片，系统在帧间生成平滑过渡动画",
    {
      frames: z.array(z.object({
        idx: z.number().int().min(0).describe("帧序号（0-based，从0开始连续递增）"),
        imagePath: z.string().min(1).describe("关键帧图片绝对路径（必填，必须是本地绝对路径）"),
        duration_ms: z.number().min(1000).max(6000).describe("从当前帧过渡到下一帧的动画时长（毫秒，1000-6000），总时长≤15000"),
        prompt: z.string().min(1).describe("⚠️关键：描述从此帧到下一帧的过渡过程，包括：1)镜头移动（推拉摇移）2)画面变化（主体动作、光影变化）3)转场效果。示例：'镜头从正面缓慢推进，猫从坐姿站起，光线从左侧照入'。最后一帧的prompt会被忽略")
      })).min(2).max(10).describe("关键帧数组（2-10个）。每帧必须包含图片、过渡时长、动画描述。⚠️注意：最后一帧的prompt不生效。示例：[{idx:0,imagePath:\"/path/1.jpg\",duration_ms:2000,prompt:\"镜头从正面推进，猫站起\"},{idx:1,imagePath:\"/path/2.jpg\",duration_ms:1000,prompt:\"忽略\"}]"),
      async: z.boolean().optional().default(true).describe("是否异步模式，默认true（异步）"),
      resolution: z.enum(["720p", "1080p"]).optional().default("720p").describe("分辨率"),
      videoAspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional().default("16:9").describe("视频宽高比"),
      fps: z.number().min(12).max(30).optional().default(24).describe("帧率(12-30)"),
      model: legacyVideoModelSchema.default(DEFAULT_VIDEO_MODEL).describe("旧多帧协议模型；不支持 Seedance 2.0/2.5")
    },
    async (params: any) => {
      try {
        const client = getApiClient();
        const result = await client.generateMultiFrameVideo(params as any);

        if (result.taskId) {
          return {
            content: [{
              type: "text",
              text: `✅ 多帧视频任务已提交！\n\n📋 任务ID: ${result.taskId}\n🎬 帧数: ${params.frames.length}\n\n💡 使用 query 工具查询状态`
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: `✅ 多帧视频生成完成\n\n🎥 视频URL: ${result.videoUrl}\n🎬 帧数: ${params.frames.length}`
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `❌ 多帧视频失败: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  logger.debug('video_multi tool registered successfully');

  server.tool(
    "video_mix",
    "融合多张图片主体到一个场景",
    {
      referenceImages: z.array(z.string()).min(2).max(4).describe("参考图片路径数组（2-4张）"),
      prompt: z.string().min(1).describe("提示词，使用[图N]语法引用图片，例如：[图0]的猫在[图1]的地板上跑"),
      async: z.boolean().optional().default(true).describe("是否异步模式，默认true（异步）"),
      resolution: z.enum(["720p", "1080p"]).optional().default("720p").describe("分辨率"),
      videoAspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional().default("16:9").describe("视频宽高比"),
      fps: z.number().min(12).max(30).optional().default(24).describe("帧率(12-30)"),
      duration: z.number().min(3000).max(15000).optional().default(5000).describe("时长(毫秒，3-15秒)"),
      model: legacyVideoModelSchema.default(DEFAULT_VIDEO_MODEL).describe("旧主体融合协议模型；不支持 Seedance 2.0/2.5")
    },
    async (params: any) => {
      try {
        const client = getApiClient();
        const result = await client.generateMainReferenceVideoUnified(params as any);

        if (result.taskId) {
          return {
            content: [{
              type: "text",
              text: `✅ 多图融合视频任务已提交！\n\n📋 任务ID: ${result.taskId}\n🖼️  参考图: ${params.referenceImages.length}张\n\n💡 使用 query 工具查询状态`
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: `✅ 多图融合视频生成完成\n\n🎥 视频URL: ${result.videoUrl}\n🖼️  参考图: ${params.referenceImages.length}张`
            }]
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `❌ 多图融合视频失败: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  logger.debug('video_mix tool registered successfully');

  return server;
};

// 启动服务器
export const startServer = async (): Promise<void> => {
  const server = createServer();
  const transport = new StdioServerTransport();

  logger.debug("Jimeng MCP Server 正在启动...");
  logger.debug("stdin.isTTY", { isTTY: process.stdin.isTTY });
  logger.debug("stdout.isTTY", { isTTY: process.stdout.isTTY });

  // 正确等待连接 - 这会阻塞直到连接关闭
  await server.connect(transport);

  // 正常情况下，只有在连接关闭时才会执行到这里
  logger.debug("MCP服务器连接已关闭");
};

// 如果直接运行此文件，则启动服务器
// 使用可靠的文件名检测，支持ESM和CommonJS环境
const isMainModule = (() => {
  try {
    // 优先使用文件名检查 - 在所有环境中都可靠工作
    const scriptPath = process.argv[1];
    if (scriptPath && (
      scriptPath.endsWith('server.cjs') ||
      scriptPath.endsWith('server.js') ||
      scriptPath.endsWith('server.ts')
    )) {
      return true;
    }

    // 备用：检查require.main（在某些环境中可能不可靠）
    if (typeof require !== 'undefined' && require.main === module) {
      return true;
    }

    return false;
  } catch (error) {
    // 错误时只依赖文件名检查
    const scriptPath = process.argv[1];
    return scriptPath && (
      scriptPath.endsWith('server.cjs') ||
      scriptPath.endsWith('server.js') ||
      scriptPath.endsWith('server.ts')
    );
  }
})();

if (isMainModule) {
  startServer().catch((error) => {
    logger.error("启动MCP服务器失败", { error });
    process.exit(1);
  });
}
