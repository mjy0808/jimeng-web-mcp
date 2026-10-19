import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getApiClient } from './api.js';
import { queryProductionTask } from './api/ProductionTasks.js';
import { submitVideoEdit } from './api/VideoEditService.js';
import { checkVideoDraftPromotion, submitVideoDraftPromotion } from './api/VideoDraftPromotionService.js';
import { VideoSubmissionRejectedError } from './api/VideoService.js';
import { PRODUCTION_PROMPT_CHARACTER_LIMIT } from './production-prompt-limit.js';
import { imageEditSchema, submitImageEdit } from './api/ImageEditService.js';
import { SEEDANCE_20_VIP_MODELS } from './types/models.js';

export const productionSubmitSchema = z.object({
    submitId: z.string().uuid(), mediaType: z.enum(['image', 'video']),
    prompt: z.string().min(1).max(PRODUCTION_PROMPT_CHARACTER_LIMIT), model: z.string().describe('视频使用 seedance-2.0-vip、seedance-2.0-fast-vip 或 seedance-2.5；不接受原非 VIP 2.0 别名'),
    references: z.array(z.string()).max(30),
    referenceAudios: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), durationMs: z.number().int().min(2000).max(30000) })).max(10).optional().describe('Seedance 2.5 音频参考，以 @音频N 绑定；合计不超过 30 秒'),
    referenceStrengths: z.array(z.number().min(0).max(1)).max(30).optional().describe('仅图片：逐张参考强度，与 references 顺序及数量相同；不是几何锁定'),
    referenceVideo: z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), durationMs: z.number().int().min(4000).max(30000) }).optional().describe('已审核前镜视频全能参考，以 @视频1 绑定；不是编辑或强制首尾帧'),
    firstFrameImage: z.string().min(1).optional().describe('视频首帧输入；与 references 互斥，提示词使用普通文字而非 @图片 编号'),
    ratio: z.enum(['1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3', '21:9']),
    resolution: z.enum(['2k', '4k', '480p', '720p', '1080p']), durationSeconds: z.number().int().min(4).max(30).optional(),
    draft: z.boolean().optional().describe('仅 Seedance 2.5 + 480p；生成可供审核的样片，不是普通 480p 视频'),
});

/** Validate locally before reserving a shared-service generation slot. */
export function validateProductionSubmit(params: z.infer<typeof productionSubmitSchema>): void {
    if (params.referenceAudios && (params.mediaType !== 'video' || params.model !== 'seedance-2.5' || params.firstFrameImage || params.referenceAudios.reduce((sum, audio) => sum + audio.durationMs, 0) > 30000)) throw new Error('音频参考须为 Seedance 2.5 全能参考、合计不超过 30 秒');
    if (params.referenceStrengths !== undefined && (params.mediaType !== 'image' || params.referenceStrengths.length !== params.references.length)) throw new Error('参考强度仅用于图片，且必须与参考图片一一对应');
    if (params.mediaType === 'image') {
      const limits: Record<string, number> = { 'jimeng-5.0-pro': 10, 'jimeng-5.0-lite': 4, 'jimeng-4.7': 4, 'jimeng-4.1': 4, 'jimeng-3.1': 1 };
      if (!Object.prototype.hasOwnProperty.call(limits, params.model) || !['2k', '4k'].includes(params.resolution) || params.references.length > limits[params.model] || params.durationSeconds !== undefined || params.firstFrameImage !== undefined || params.draft !== undefined || params.referenceVideo !== undefined) throw new Error('不支持的图片模型/规格/参考图数量');
      return;
    }
    const vip = Object.prototype.hasOwnProperty.call(SEEDANCE_20_VIP_MODELS, params.model)
      ? SEEDANCE_20_VIP_MODELS[params.model as keyof typeof SEEDANCE_20_VIP_MODELS] : undefined;
    if ((!vip && params.model !== 'seedance-2.5') || params.durationSeconds === undefined) throw new Error('不支持的视频模型/规格；2.0 请显式选择 seedance-2.0-vip 或 seedance-2.0-fast-vip');
    const resolutions: readonly string[] = vip?.resolutions ?? ['480p', '720p', '1080p'];
    if (!resolutions.includes(params.resolution) || (vip && (params.durationSeconds < 4 || params.durationSeconds > 15))) throw new Error(`不支持的视频模型/规格：${vip?.name ?? 'Seedance 2.5'} 的分辨率或时长`);
    if (params.draft && (params.model !== 'seedance-2.5' || params.resolution !== '480p')) throw new Error('Seedance 2.5 样片模式仅支持 480p');
}

export function registerProductionTools(server: McpServer): void {
  const result = (value: Record<string, unknown>) => ({ structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.tool('production_image_edit', '按原图和蒙版进行图片局部重绘；白色修改、黑色保留。先持久化 submitId，超时只用 task_query(mediaType=image) 查询原任务。',
    imageEditSchema.shape, async params => result(await submitImageEdit(params)));
  server.tool('production_submit', '提交且仅提交一张图片或一段视频。调用前持久化 submitId；超时后只用 task_query 恢复，禁止重试提交。', productionSubmitSchema.shape, async (params) => {
    const client = getApiClient();
    validateProductionSubmit(params);
    if (params.mediaType === 'image') {
      const historyId = await client.generateImage({ submitId: params.submitId, prompt: params.prompt, model: params.model, filePath: params.references, reference_strength: params.referenceStrengths, aspectRatio: params.ratio, resolution: params.resolution as '2k' | '4k', count: 1, async: true, refresh_token: process.env.JIMENG_API_TOKEN! });
      return result({ taskId: params.submitId, historyId, mediaType: 'image', status: 'submitted' });
    }
    let submitted;
    try {
      submitted = await client.generateTextToVideo({ submitId: params.submitId, prompt: params.prompt, model: params.model, referenceImages: params.references, referenceVideo: params.referenceVideo, referenceAudios: params.referenceAudios, firstFrameImage: params.firstFrameImage, videoAspectRatio: params.ratio, resolution: params.resolution, duration: params.durationSeconds! * 1000, fps: 24, draft: params.draft, async: true });
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
