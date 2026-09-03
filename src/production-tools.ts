import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getApiClient } from './api.js';
import { queryProductionTask } from './api/ProductionTasks.js';

export function registerProductionTools(server: McpServer): void {
  const result = (value: Record<string, unknown>) => ({ structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.tool('production_submit', '提交且仅提交一张图片或一段视频。调用前持久化 submitId；超时后只用 task_query 恢复，禁止重试提交。', {
    submitId: z.string().uuid(), mediaType: z.enum(['image', 'video']),
    prompt: z.string().min(1).max(1600), model: z.string(),
    references: z.array(z.string()).max(30),
    firstFrameImage: z.string().min(1).optional().describe('视频首帧输入；与 references 互斥，提示词使用普通文字而非 @图片 编号'),
    ratio: z.enum(['1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3', '21:9']),
    resolution: z.enum(['2k', '480p', '720p', '1080p']), durationSeconds: z.number().int().min(4).max(30).optional(),
  }, async (params) => {
    const client = getApiClient();
    if (params.mediaType === 'image') {
      const limits: Record<string, number> = { 'jimeng-5.0-pro': 10, 'jimeng-5.0-lite': 4, 'jimeng-4.7': 4, 'jimeng-4.1': 4, 'jimeng-3.1': 1 };
      if (!Object.prototype.hasOwnProperty.call(limits, params.model) || params.resolution !== '2k' || params.references.length > limits[params.model] || params.durationSeconds !== undefined || params.firstFrameImage !== undefined) throw new Error('不支持的图片模型/规格/参考图数量');
      const historyId = await client.generateImage({ submitId: params.submitId, prompt: params.prompt, model: params.model, filePath: params.references, aspectRatio: params.ratio, resolution: '2k', count: 1, async: true, refresh_token: process.env.JIMENG_API_TOKEN! });
      return result({ taskId: params.submitId, historyId, mediaType: 'image', status: 'submitted' });
    }
    if (!['seedance-2.0', 'seedance-2.5'].includes(params.model) || params.resolution === '2k' || params.durationSeconds === undefined) throw new Error('不支持的视频模型/规格');
    const submitted = await client.generateTextToVideo({ submitId: params.submitId, prompt: params.prompt, model: params.model, referenceImages: params.references, firstFrameImage: params.firstFrameImage, videoAspectRatio: params.ratio, resolution: params.resolution, duration: params.durationSeconds * 1000, fps: 24, async: true });
    if (submitted.taskId !== params.submitId) throw new Error('服务端返回不同 submitId；请查询原任务，不得重新提交');
    return result({ taskId: params.submitId, mediaType: 'video', status: 'submitted' });
  });
  server.tool('task_query', '只读查询已有单结果生产任务，不续生成、不补交、不消费生成积分。', {
    taskId: z.string(), mediaType: z.enum(['image', 'video']),
  }, async ({ taskId, mediaType }) => result({ ...await queryProductionTask(taskId, mediaType) }));
}
