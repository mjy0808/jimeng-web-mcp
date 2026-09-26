import { randomUUID } from 'node:crypto';
import { HttpClient } from './HttpClient.js';
import { SEEDANCE_25_DRAFT_MODEL_KEY } from '../types/models.js';

export interface VideoDraftPromotionParams {
  submitId: string;
  draftTaskId: string;
  resolution: '720p' | '1080p';
}

function numericId(value: unknown, label: string): string {
  if ((typeof value !== 'string' && (!Number.isSafeInteger(value) || Number(value) < 0))
    || !/^\d+$/.test(String(value))) {
    throw new Error(`原始样片缺少${label}，不能按样片升清`);
  }
  return String(value);
}

/** Build a finalization request bound to the original Draft history and item. */
export function videoDraftPromotionBody(p: VideoDraftPromotionParams, source: any, commerce: Record<string, unknown>) {
  if ((source?.common_attr?.status ?? source?.status) !== 50) throw new Error('原始样片尚未完成，不能升清');
  if (!Array.isArray(source.item_list) || source.item_list.length !== 1) throw new Error('原始样片必须恰好有一个视频结果');
  const historyId = numericId(source.history_record_id ?? source.history_id ?? source.id, '历史记录 ID');
  const itemId = numericId(source.item_list[0]?.id, '视频结果 ID');
  if (typeof source.draft_content !== 'string') throw new Error('原始样片缺少 Draft 内容，不能升清');
  const draft = JSON.parse(source.draft_content);
  const component = draft.component_list?.find((item: any) => item.id === draft.main_component_id);
  const parameters = component?.abilities?.gen_video?.text_to_video_params;
  const input = parameters?.video_gen_inputs?.[0];
  if (parameters?.model_req_key !== SEEDANCE_25_DRAFT_MODEL_KEY || input?.is_draft_mode !== true
    || input?.resolution !== '480p' || input?.v2v_opt || component?.process_type === 15) {
    throw new Error('来源不是真正的 Seedance 2.5 原始 480p 样片，不能升清');
  }
  const componentId = randomUUID();
  const metrics = JSON.stringify({ enterFrom: 'click', isRegenerate: false,
    originSubmitId: p.draftTaskId, originId: itemId, previewSubmitId: p.draftTaskId,
    videoProcessType: 15, videoStage: 'final' });
  return {
    submit_id: p.submitId,
    extend: { root_model: SEEDANCE_25_DRAFT_MODEL_KEY, m_video_commerce_info: commerce, m_video_commerce_info_list: [commerce] },
    metrics_extra: metrics,
    draft_content: JSON.stringify({
      type: 'draft', id: randomUUID(), min_version: '3.3.28', version: '3.3.28',
      is_from_tsn: true, main_component_id: componentId,
      component_list: [{ type: 'video_base_component', id: componentId, min_version: '3.3.28',
        metadata: { type: '', id: randomUUID(), created_platform: 3, created_platform_version: '', created_time_in_ms: Date.now(), created_did: '' },
        generate_type: 'gen_video', aigc_mode: 'workbench', process_type: 15,
        abilities: { type: '', id: randomUUID(), gen_video: { type: '', id: randomUUID(), video_task_extra: metrics,
          video_ref_params: { type: '', id: randomUUID(), item_id: itemId, origin_history_id: historyId },
          text_to_video_params: { type: '', id: randomUUID(), video_gen_inputs: [{ type: '', id: randomUUID(),
            min_version: '3.3.28', origin_history_id: historyId, resolution: p.resolution,
            v2v_opt: { type: '', id: randomUUID(), generate_from_draft: { type: '', id: randomUUID(), enable: true } },
          }] },
        } },
      }],
    }),
  };
}

async function prepareVideoDraftPromotion(p: VideoDraftPromotionParams, http: HttpClient) {
  if (p.submitId === p.draftTaskId) throw new Error('升清任务编号必须区别于原始样片任务');
  const sourceResponse = await http.request({ url: '/mweb/v1/get_history_by_ids', params: http.generateRequestParams(),
    data: { submit_ids: [p.draftTaskId] } });
  if (String(sourceResponse?.ret) !== '0') throw new Error('无法读取原始样片任务；不会提交普通生成');
  const source = sourceResponse?.data?.[p.draftTaskId];
  const configResponse = await http.request({ url: '/mweb/v1/video_generate/get_common_config',
    data: { scene: 'generate_video', params: { needCache: true } } });
  const model = configResponse?.data?.model_list?.find((item: any) => item.model_req_key === SEEDANCE_25_DRAFT_MODEL_KEY);
  const finalization = model?.options?.find((item: any) => item.key === 'generate_from_draft_config' && !item.forbidden_display)
    ?.generate_from_draft_config_val?.resolution;
  const allowed = finalization?.string_value ?? [];
  const disabled = finalization?.disabled_string_value ?? [];
  const price = model?.commercial_config?.resolution_price_configs?.find((item: any) => item.resolution === p.resolution)?.price;
  if (String(configResponse?.ret) !== '0' || model?.model_status !== 0 || model?.extra?.is_draft_mode !== true || !allowed.includes(p.resolution)
    || disabled.includes(p.resolution) || !price?.benefit_type) {
    throw new Error('即梦当前没有开放该样片升清规格；不会改用普通 1080p 生成');
  }
  const component = JSON.parse(source?.draft_content ?? '{}').component_list?.[0];
  const duration = component?.abilities?.gen_video?.text_to_video_params?.video_gen_inputs?.[0]?.duration_ms;
  if (!Number.isInteger(duration) || duration < 4000 || duration > 30000) throw new Error('原始样片时长无效');
  return videoDraftPromotionBody(p, source, { ...price, resource_id: 'generate_video', resource_id_type: 'str', resource_sub_type: 'aigc', amount: duration / 1000 });
}

export async function checkVideoDraftPromotion(p: VideoDraftPromotionParams, http = new HttpClient()) {
  await prepareVideoDraftPromotion(p, http);
  return { eligible: true, draftTaskId: p.draftTaskId, resolution: p.resolution };
}

export async function submitVideoDraftPromotion(p: VideoDraftPromotionParams, http = new HttpClient()) {
  const body = await prepareVideoDraftPromotion(p, http);
  const result = await http.request({ url: '/mweb/v1/aigc_draft/generate', params: http.generateRequestParams(), data: body });
  const taskId = result?.data?.aigc_data?.task?.submit_id ?? result?.data?.aigc_data?.submit_id ?? result?.data?.submit_id ?? result?.submit_id;
  if (String(result?.ret) !== '0' || taskId !== p.submitId) throw new Error('样片升清提交回执不匹配；只允许查询已保存的任务编号');
  return { taskId: p.submitId, mediaType: 'video', status: 'submitted' };
}
