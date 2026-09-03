/**
 * Zod验证schemas - 视频生成方法
 *
 * 用于MCP工具的参数验证
 * Feature 005-3-1-2
 */

import { z } from 'zod';
import { DEFAULT_VIDEO_MODEL, LEGACY_VIDEO_MODEL_MAP, VIDEO_MODEL_MAP } from '../types/models.js';

export const legacyVideoModelSchema = z.enum(Object.keys(LEGACY_VIDEO_MODEL_MAP) as [string, ...string[]]);

// 与 MCP video / video_frame 共用，模型相关的交叉约束由 VideoService 在上传前检查。
export const textToVideoControls = {
  model: z.enum(Object.keys(VIDEO_MODEL_MAP) as [string, ...string[]]).default(DEFAULT_VIDEO_MODEL)
    .describe('视频模型；seedance-2.0/seedance-2.5 为新版 Seedance，jimeng-video-2.0 是旧模型'),
  resolution: z.enum(['480p', '720p', '1080p']).default('720p')
    .describe('Seedance 2.0 仅720p；2.5 支持480p/720p/1080p；旧模型720p/1080p'),
  fps: z.number().int().min(12).max(30).default(24).describe('Seedance固定24fps；旧模型12-30'),
  duration: z.number().int().min(3000).max(30000).default(5000)
    .describe('毫秒：Seedance 2.0 为4000-15000，2.5 为4000-30000，均须整秒；旧模型3000-15000')
};

/**
 * 基础视频生成选项schema
 */
const baseVideoOptionsSchema = z.object({
  async: z.boolean().optional().describe('是否异步模式，默认false（同步）'),
  resolution: z.enum(['720p', '1080p']).optional().describe('视频分辨率'),
  videoAspectRatio: z.enum(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']).optional().describe('视频宽高比'),
  fps: z.number().int().min(12).max(30).optional().describe('帧率 (12-30)'),
  duration: z.number().int().min(3000).max(15000).optional().describe('时长（毫秒，3000-15000）'),
  model: legacyVideoModelSchema.optional().describe('旧多帧/主体融合协议的模型；不支持 Seedance 2.0/2.5')
});

/**
 * 文生视频选项schema
 */
export const textToVideoOptionsSchema = baseVideoOptionsSchema.extend({
  ...textToVideoControls,
  prompt: z.string().min(1).describe('视频描述文本'),
  firstFrameImage: z.string().optional().describe('首帧图片路径'),
  lastFrameImage: z.string().optional().describe('尾帧图片路径')
});

/**
 * 帧配置schema
 */
const frameConfigurationSchema = z.object({
  idx: z.number().int().min(0).describe('帧序号（0-based）'),
  duration_ms: z.number().int().min(1000).max(6000).describe('帧时长（毫秒，1000-6000）'),
  prompt: z.string().min(1).describe('帧描述文本'),
  imagePath: z.string().min(1).describe('参考图片路径（必填）')
});

/**
 * 多帧视频选项schema
 */
export const multiFrameVideoOptionsSchema = baseVideoOptionsSchema.extend({
  frames: z.array(frameConfigurationSchema)
    .min(2, '至少需要2个帧')
    .max(10, '最多支持10个帧')
    .describe('帧配置数组（2-10个）')
    .refine(
      (frames) => {
        // 验证帧序号唯一性
        const indices = frames.map(f => f.idx);
        const uniqueIndices = new Set(indices);
        return indices.length === uniqueIndices.size;
      },
      { message: '帧序号必须唯一' }
    )
});

/**
 * 主体参考视频选项schema
 */
export const mainReferenceVideoOptionsSchema = baseVideoOptionsSchema.extend({
  referenceImages: z.array(z.string())
    .min(2, '至少需要2张参考图片')
    .max(4, '最多支持4张参考图片')
    .describe('参考图片路径数组（2-4张）'),
  prompt: z.string()
    .min(1)
    .describe('提示词，使用[图N]语法引用图片')
    .refine(
      (prompt) => /\[图\d+\]/.test(prompt),
      { message: '提示词必须包含至少一个图片引用（如[图0]）' }
    )
});

/**
 * 类型导出（用于TypeScript类型推断）
 */
export type TextToVideoOptionsInput = z.infer<typeof textToVideoOptionsSchema>;
export type MultiFrameVideoOptionsInput = z.infer<typeof multiFrameVideoOptionsSchema>;
export type MainReferenceVideoOptionsInput = z.infer<typeof mainReferenceVideoOptionsSchema>;
