import { randomUUID } from 'node:crypto';
import { HttpClient } from './HttpClient.js';
import { ImageUploader, type UploadResult } from './ImageUploader.js';
import { VideoUploader, type UploadedVideo } from './VideoUploader.js';

export interface VideoEditParams {
  submitId: string;
  sourceVideo: string;
  sourceSha256: string;
  sourceDurationMs: number;
  startMs: number;
  endMs: number;
  prompt: string;
  references: string[];
  resolution: '480p' | '720p' | '1080p';
}

/** Exact rich-text binding: source is @视频1, image indices are independent of material indices. */
export function unifiedVideoEditInput(p: VideoEditParams, video: UploadedVideo, images: Partial<UploadResult>[]) {
  if (!Number.isInteger(p.sourceDurationMs) || p.sourceDurationMs < 4000 || p.sourceDurationMs > 30000
    || !Number.isInteger(p.startMs) || !Number.isInteger(p.endMs) || p.startMs < 0 || p.endMs <= p.startMs
    || p.endMs > p.sourceDurationMs) throw new Error('编辑时间范围必须在源视频内，源视频支持 4–30 秒');
  if (!p.prompt.trim() || p.prompt.length > 1600 || images.length > 30) throw new Error('编辑提示词或参考图数量超过限制');
  const meta: any[] = [];
  const used = new Set<string>();
  let offset = 0;
  for (const match of p.prompt.matchAll(/@(?:图片|视频|音频)\d+/gu)) {
    const image = match[0].startsWith('@图片');
    const index = image ? Number(match[0].slice(3)) : 0;
    if ((!image && match[0] !== '@视频1') || (image && (index < 1 || index > images.length))) throw new Error('编辑提示词参考编号无效：' + match[0]);
    if (match.index > offset) meta.push({ type: '', id: randomUUID(), meta_type: 'text', text: p.prompt.slice(offset, match.index) });
    meta.push({ type: '', id: randomUUID(), meta_type: image ? 'image' : 'video', text: '',
      material_ref: { type: '', id: randomUUID(), material_idx: index } });
    used.add(match[0]);
    offset = match.index + match[0].length;
  }
  if (!used.has('@视频1') || images.some((_, i) => !used.has('@图片' + (i + 1)))) throw new Error('编辑提示词必须绑定源视频和全部参考图');
  if (offset < p.prompt.length) meta.push({ type: '', id: randomUUID(), meta_type: 'text', text: p.prompt.slice(offset) });
  return {
    type: '', id: randomUUID(),
    material_list: [
      { type: '', id: randomUUID(), material_type: 'video', video_info: {
        type: 'video', id: randomUUID(), source_from: 'upload', name: '', vid: video.vid,
        width: video.width, height: video.height, duration: video.durationMs, fps: video.fps,
      } },
      ...images.map(image => ({ type: '', id: randomUUID(), material_type: 'image',
        image_info: { type: 'image', id: randomUUID(), source_from: 'upload', platform_type: 1,
          uri: image.uri, width: image.width, height: image.height, format: image.format } })),
    ],
    meta_list: meta,
    edit_input: { enable: true, edit_from_material_idx: 0, start_timestamp_ms: p.startMs, end_timestamp_ms: p.endMs },
  };
}

export function videoEditDraft(p: VideoEditParams, video: UploadedVideo, images: Partial<UploadResult>[], commerce: Record<string, unknown>) {
  const input = unifiedVideoEditInput(p, video, images);
  const component = randomUUID();
  const extra = JSON.stringify({ enterFrom: 'click', isRegenerate: false, functionMode: 'video_edit', generatorFeature: 'videoEdit' });
  return {
    submit_id: p.submitId,
    extend: { root_model: 'dreamina_seedance_45_pro', m_video_commerce_info: commerce, m_video_commerce_info_list: [commerce] },
    metrics_extra: extra,
    draft_content: JSON.stringify({
      type: 'draft', id: randomUUID(), min_version: '3.3.9', version: '3.3.9',
      min_features: ['AIGC_Video_UnifiedEdit'], is_from_tsn: true, main_component_id: component,
      component_list: [{ type: 'video_base_component', id: component, min_version: '1.0.0',
        metadata: { type: '', id: randomUUID(), created_platform: 3, created_platform_version: '', created_time_in_ms: Date.now(), created_did: '' },
        generate_type: 'gen_video', aigc_mode: 'workbench',
        abilities: { type: '', id: randomUUID(), gen_video: {
          type: '', id: randomUUID(), video_task_extra: extra,
          text_to_video_params: { type: '', id: randomUUID(), generator_feature: 'videoEdit',
            model_req_key: 'dreamina_seedance_45_pro', priority: 0, seed: Math.floor(Math.random() * 2147483647),
            video_aspect_ratio: 'adaptive', video_gen_inputs: [{ type: '', id: randomUUID(),
              min_version: '3.3.9', duration_ms: -1, fps: 24, prompt: '', resolution: p.resolution,
              video_mode: 2, unified_edit_input: input }] },
        } },
      }],
    }),
  };
}

export async function submitVideoEdit(p: VideoEditParams, http = new HttpClient(),
  uploader = new VideoUploader(http), images = new ImageUploader(http)) {
  // Validate authored references/range before uploading or submitting anything.
  unifiedVideoEditInput(p, { vid: '', width: 0, height: 0, durationMs: p.sourceDurationMs, fps: 24 }, p.references.map(() => ({})));
  const response = await http.request({ url: '/mweb/v1/video_generate/get_common_config', data: { scene: 'generate_video', params: { needCache: true } } });
  const model = response?.data?.model_list?.find((item: any) => item.model_req_key === 'dreamina_seedance_45_pro');
  const config = model?.options?.find((item: any) => item.key === 'edit_config' && !item.forbidden_display)?.edit_config_val;
  const price = model?.commercial_config?.resolution_price_configs?.find((item: any) => item.resolution === p.resolution)?.price;
  if (String(response?.ret) !== '0' || model?.model_status !== 0 || !config
    || config.duration_mode !== 'adaptive' || config.video_aspect_ratio_mode !== 'adaptive'
    || config.default_model_req_key !== model.model_req_key
    || p.sourceDurationMs < config.edit_min_video_duration * 1000 || p.sourceDurationMs > config.edit_max_video_duration * 1000
    || price?.benefit_type !== 'seedance_25_' + p.resolution + '_output') throw new Error('即梦当前模型配置不支持此编辑规格，请更新适配器；不会改用普通生成');
  const video = await uploader.upload(p.sourceVideo, p.sourceSha256);
  if (Math.abs(video.durationMs - p.sourceDurationMs) > 100 || video.width < 300 || video.height < 300
    || video.width > 6000 || video.height > 6000 || video.width / video.height < 0.4 || video.width / video.height > 2.5
    || video.width * video.height < 409600 || video.width * video.height > 8295044
    || !Number.isFinite(video.fps) || video.fps < 24 || video.fps > 60) throw new Error('上传的源视频时长、尺寸或帧率不符合编辑规格');
  const uploaded = await Promise.all(p.references.map(path => images.upload(path)));
  const body = videoEditDraft(p, video, uploaded, { ...price, amount: (p.endMs - p.startMs) / 1000 });
  const result = await http.request({ url: '/mweb/v1/aigc_draft/generate',
    params: { ...http.generateRequestParams(), commerce_with_input_video: '1' }, data: body });
  const id = result?.data?.aigc_data?.task?.submit_id ?? result?.data?.aigc_data?.submit_id ?? result?.data?.submit_id ?? result?.submit_id;
  if (String(result?.ret) !== '0' || id !== p.submitId) throw new Error('视频编辑提交回执不匹配；请查询原任务，禁止重复提交');
  return { taskId: p.submitId, mediaType: 'video', status: 'submitted' };
}
