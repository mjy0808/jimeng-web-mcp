import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getApiClient } from './api.js';
import { queryProductionTask } from './api/ProductionTasks.js';
import { submitVideoEdit } from './api/VideoEditService.js';
import { checkVideoDraftPromotion, submitVideoDraftPromotion } from './api/VideoDraftPromotionService.js';
import { VideoSubmissionRejectedError } from './api/VideoService.js';
import { PRODUCTION_PROMPT_CHARACTER_LIMIT } from './production-prompt-limit.js';

export function registerProductionTools(server: McpServer): void {
  const result = (value: Record<string, unknown>) => ({ structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.tool('production_submit', '提交且仅提交一张图片或一段视频。调用前持久化 submitId；超时后只用 task_query 恢复，禁止重试提交。', {
    submitId: z.string().uuid(), mediaType: z.enum(['image', 'video']),
    prompt: z.string().min(1).max(PRODUCTION_PROMPT_CHARACTER_LIMIT), model: z.string(),
    references: z.array(z.string()).max(30),
    referenceVideo: z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), durationMs: z.number().int().min(4000).max(30000) }).optional().describe('已审核前镜视频全能参考，以 @视频1 绑定；不是编辑或强制首尾帧'),
    firstFrameImage: z.string().min(1).optional().describe('视频首帧输入；与 references 互斥，提示词使用普通文字而非 @图片 编号'),
    ratio: z.enum(['1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3', '21:9']),
    resolution: z.enum(['2k', '480p', '720p', '1080p']), durationSeconds: z.number().int().min(4).max(30).optional(),
    draft: z.boolean().optional().describe('仅 Seedance 2.5 + 480p；生成可供审核的样片，不是普通 480p 视频'),
  }, async (params) => {
    const client = getApiClient();
    if (params.mediaType === 'image') {
      const limits: Record<string, number> = { 'jimeng-5.0-pro': 10, 'jimeng-5.0-lite': 4, 'jimeng-4.7': 4, 'jimeng-4.1': 4, 'jimeng-3.1': 1 };
      if (!Object.prototype.hasOwnProperty.call(limits, params.model) || params.resolution !== '2k' || params.references.length > limits[params.model] || params.durationSeconds !== undefined || params.firstFrameImage !== undefined || params.draft !== undefined || params.referenceVideo !== undefined) throw new Error('不支持的图片模型/规格/参考图数量');
      const historyId = await client.generateImage({ submitId: params.submitId, prompt: params.prompt, model: params.model, filePath: params.references, aspectRatio: params.ratio, resolution: '2k', count: 1, async: true, refresh_token: process.env.JIMENG_API_TOKEN! });
      return result({ taskId: params.submitId, historyId, mediaType: 'image', status: 'submitted' });
    }
    if (!['seedance-2.0', 'seedance-2.5'].includes(params.model) || params.resolution === '2k' || params.durationSeconds === undefined) throw new Error('不支持的视频模型/规格');
    if (params.draft && (params.model !== 'seedance-2.5' || params.resolution !== '480p')) throw new Error('Seedance 2.5 样片模式仅支持 480p');
    let submitted;
    try {
      submitted = await client.generateTextToVideo({ submitId: params.submitId, prompt: params.prompt, model: params.model, referenceImages: params.references, referenceVideo: params.referenceVideo, firstFrameImage: params.firstFrameImage, videoAspectRatio: params.ratio, resolution: params.resolution, duration: params.durationSeconds * 1000, fps: 24, draft: params.draft, async: true });
    } catch (error) {
      if (error instanceof VideoSubmissionRejectedError) return result({
        taskId: params.submitId, mediaType: 'video', status: 'rejected', error: error.message,
      });
      throw error;
    }
    if (submitted.taskId !== params.submitId) throw new Error('服务端返回不同 submitId；请查询原任务，不得重新提交');
    return result({ taskId: params.submitId, mediaType: 'video', status: 'submitted' });
  });
  server.tool('production_edit', '编辑一个已审核的源视频。先持久化 submitId；超时后只查询原任务。不会自动拼接局部结果。', {
    submitId: z.string().uuid(), sourceVideo: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceDurationMs: z.number().int().min(4000).max(30000),
    startMs: z.number().int().min(0), endMs: z.number().int().min(1),
    prompt: z.string().min(1).max(PRODUCTION_PROMPT_CHARACTER_LIMIT), references: z.array(z.string()).max(30),
    resolution: z.enum(['480p', '720p', '1080p']),
  }, async params => result(await submitVideoEdit(params)));
  server.tool('production_promote', '从一份已完成的 Seedance 2.5 原始 480p 样片结果生成高清正式版。先持久化新 submitId；不重新生成提示词，超时后只查询新任务。', {
    submitId: z.string().uuid(), draftTaskId: z.string().uuid(), resolution: z.enum(['720p', '1080p']),
  }, async params => result(await submitVideoDraftPromotion(params)));
  server.tool('production_promote_check', '只读验证一份已完成的 Seedance 2.5 样片及当前高清升清规格；不提交生成任务。', {
    submitId: z.string().uuid(), draftTaskId: z.string().uuid(), resolution: z.enum(['720p', '1080p']),
  }, async params => result(await checkVideoDraftPromotion(params)));
  server.tool('task_query', '只读查询已有单结果生产任务，不续生成、不补交、不消费生成积分。', {
    taskId: z.string(), mediaType: z.enum(['image', 'video']),
  }, async ({ taskId, mediaType }) => result({ ...await queryProductionTask(taskId, mediaType) }));
}
