/**
 * 模型映射和常量定义
 * 从api.ts中提取的模型相关常量和配置
 */

import { generateUuid } from '../utils/index.js';
import { logger } from '../utils/logger.js';

// ============== 模型映射 ==============

export const LEGACY_VIDEO_MODEL_MAP = {
  'jimeng-video-3.0-pro': 'dreamina_ic_generate_video_model_vgfm_3.0_pro',
  'jimeng-video-3.0': 'dreamina_ic_generate_video_model_vgfm_3.0',
  'jimeng-video-2.0': 'dreamina_ic_generate_video_model_vgfm_lite',
  'jimeng-video-2.0-pro': 'dreamina_ic_generate_video_model_vgfm1.0',
  'jimeng-video-multiframe': 'dreamina_ic_generate_video_model_vgfm_3.0'
} as const;

export const VIDEO_MODEL_MAP = {
  ...LEGACY_VIDEO_MODEL_MAP,
  // 即梦网页 get_common_config（2026-09-03）；标准版，不是 Fast / VIP。
  'seedance-2.0': 'dreamina_seedance_40_pro',
  'seedance-2.5': 'dreamina_seedance_45_pro'
} as const;

/**
 * 模型映射表
 * jimeng-4.0 (seedream4.0) 的内部模型名称已通过网络请求分析确认
 */
export const MODEL_MAP: Record<string, string> = {
  'jimeng-5.0-pro': 'high_aes_general_v50p_large',
  'jimeng-4.7': 'high_aes_general_v43',
  // 图片 5.0 Lite（Seedream 5.0 Lite）的网页端模型标识。
  'jimeng-5.0-lite': 'high_aes_general_v50',
  'jimeng-5.0': 'high_aes_general_v50',
  // 图像生成模型 - 经过实际网络请求验证
  'jimeng-4.0': 'high_aes_general_v40', // 4.0
  'jimeng-4.5': 'high_aes_general_v40l', // [User Verified] 4.5
  'jimeng-4.1': 'high_aes_general_v41', // [Verified] Found v41 in index.html
  'jimeng-3.1': 'high_aes_general_v30l_art_fangzhou:general_v3.0_18b',
  'jimeng-3.0': 'high_aes_general_v30l:general_v3.0_18b', // 支持creation_agent_v30模式
  'jimeng-2.1': 'high_aes_general_v21_L:general_v2.1_L',
  'jimeng-2.0-pro': 'high_aes_general_v20_L:general_v2.0_L',
  'jimeng-2.0': 'high_aes_general_v20:general_v2.0',
  'jimeng-1.4': 'high_aes_general_v14:general_v1.4',
  'jimeng-xl-pro': 'text2img_xl_sft',
  ...VIDEO_MODEL_MAP
};

// ============== 默认常量 ==============

export const DEFAULT_MODEL = 'jimeng-4.5';
export const DEFAULT_VIDEO_MODEL = 'jimeng-video-3.0';
export const DEFAULT_BLEND_MODEL = 'jimeng-4.5'; //不允许修改
export const DRAFT_VERSION = '3.0.2';
export const DEFAULT_ASSISTANT_ID = '513695'; // 从原始仓库中提取
export const WEB_ID = Math.random() * 999999999999999999 + 7000000000000000000;
export const USER_ID = generateUuid().replace(/-/g, '');
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ============== 宽高比配置 ==============

/**
 * 宽高比预设选项 - 使用API官方预定义尺寸
 */
export interface AspectRatioPreset {
  name: string;
  ratio: number;
  displayName: string;
  imageRatio: number; // 即梦API内部的比例标识符 (ratio_type)
  width: number; // API官方预定义宽度
  height: number; // API官方预定义高度
  resolutionType: string; // 分辨率类型
}

/**
 * 宽高比预设列表 - 2K分辨率
 * 基于JiMeng API官方预定义的8种尺寸
 */
export const ASPECT_RATIO_PRESETS_2K: AspectRatioPreset[] = [
  { name: 'auto', ratio: 1, displayName: '智能', imageRatio: 1, width: 2048, height: 2048, resolutionType: '2k' },
  { name: '1:1', ratio: 1, displayName: '1:1', imageRatio: 1, width: 2048, height: 2048, resolutionType: '2k' },
  { name: '3:4', ratio: 3 / 4, displayName: '3:4', imageRatio: 2, width: 1728, height: 2304, resolutionType: '2k' },
  { name: '16:9', ratio: 16 / 9, displayName: '16:9', imageRatio: 3, width: 2560, height: 1440, resolutionType: '2k' },
  { name: '4:3', ratio: 4 / 3, displayName: '4:3', imageRatio: 4, width: 2304, height: 1728, resolutionType: '2k' },
  { name: '9:16', ratio: 9 / 16, displayName: '9:16', imageRatio: 5, width: 1440, height: 2560, resolutionType: '2k' },
  { name: '2:3', ratio: 2 / 3, displayName: '2:3', imageRatio: 6, width: 1664, height: 2496, resolutionType: '2k' },
  { name: '3:2', ratio: 3 / 2, displayName: '3:2', imageRatio: 7, width: 2496, height: 1664, resolutionType: '2k' },
  { name: '21:9', ratio: 21 / 9, displayName: '21:9', imageRatio: 8, width: 3024, height: 1296, resolutionType: '2k' }
];

/**
 * 宽高比预设列表 - 4K分辨率
 * 基于DevTools实际验证的JiMeng 4K尺寸 (2025-01-05)
 */
export const ASPECT_RATIO_PRESETS_4K: AspectRatioPreset[] = [
  { name: 'auto', ratio: 1, displayName: '智能', imageRatio: 1, width: 4096, height: 4096, resolutionType: '4k' },
  { name: '1:1', ratio: 1, displayName: '1:1', imageRatio: 1, width: 4096, height: 4096, resolutionType: '4k' },
  { name: '3:4', ratio: 3 / 4, displayName: '3:4', imageRatio: 2, width: 3520, height: 4693, resolutionType: '4k' },
  { name: '16:9', ratio: 16 / 9, displayName: '16:9', imageRatio: 3, width: 5404, height: 3040, resolutionType: '4k' },
  { name: '4:3', ratio: 4 / 3, displayName: '4:3', imageRatio: 4, width: 4693, height: 3520, resolutionType: '4k' },
  { name: '9:16', ratio: 9 / 16, displayName: '9:16', imageRatio: 5, width: 3040, height: 5404, resolutionType: '4k' },
  { name: '2:3', ratio: 2 / 3, displayName: '2:3', imageRatio: 6, width: 3328, height: 4992, resolutionType: '4k' },
  { name: '3:2', ratio: 3 / 2, displayName: '3:2', imageRatio: 7, width: 4992, height: 3328, resolutionType: '4k' },
  { name: '21:9', ratio: 21 / 9, displayName: '21:9', imageRatio: 8, width: 6197, height: 2656, resolutionType: '4k' }
];

/**
 * 默认宽高比预设列表（向后兼容，默认2K）
 */
export const ASPECT_RATIO_PRESETS = ASPECT_RATIO_PRESETS_2K;

/**
 * 获取模型的内部名称
 */
export function getModel(model: string): string {
  const mappedModel = MODEL_MAP[model];
  if (!mappedModel) {
    logger.debug(`未知模型: ${model}，使用默认模型: ${DEFAULT_MODEL}`);
    return MODEL_MAP[DEFAULT_MODEL];
  }
  return mappedModel;
}

/** 视频请求不允许回退到图片模型，也不把 Seedance 传入旧多帧协议。 */
export function getVideoModel(model: string, allowSeedance = true): string {
  const models: Readonly<Record<string, string>> = allowSeedance ? VIDEO_MODEL_MAP : LEGACY_VIDEO_MODEL_MAP;
  if (!Object.prototype.hasOwnProperty.call(models, model)) {
    throw new Error(`当前视频模式不支持模型 ${model}；可选：${Object.keys(models).join(', ')}`);
  }
  return models[model];
}

/**
 * 根据分辨率获取对应的预设列表
 */
export function getAspectRatioPresets(resolution: '2k' | '4k' = '2k'): AspectRatioPreset[] {
  return resolution === '4k' ? ASPECT_RATIO_PRESETS_4K : ASPECT_RATIO_PRESETS_2K;
}

/**
 * 根据宽度和高度确定分辨率类型
 */
export function getResolutionType(width: number, height: number): string {
  const maxDimension = Math.max(width, height);
  if (maxDimension <= 1024) return '1k';
  if (maxDimension <= 1536) return '1.5k';
  if (maxDimension <= 2048) return '2k';
  if (maxDimension <= 2560) return '2.5k';
  if (maxDimension <= 4096) return '4k';
  return '8k';
}
