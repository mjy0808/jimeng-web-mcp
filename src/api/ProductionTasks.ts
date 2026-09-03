import { randomUUID } from 'node:crypto';
import { HttpClient } from './HttpClient.js';

export type MediaType = 'image' | 'video';
export interface ProductionTask {
  taskId: string;
  mediaType: MediaType;
  status: 'not_found' | 'processing' | 'completed' | 'failed';
  outputs: Array<{ mediaType: MediaType; url: string }>;
  error?: string;
  progress?: { queuePosition?: number; queueLength?: number };
}

/** Web DAUnifiedEditInput: ordered image resources and text/material chunks. */
export function unifiedImageInput(prompt: string, images: Array<{ uri?: string; width?: number; height?: number; format?: string }>) {
  const meta: any[] = [];
  const used = new Set<number>();
  let offset = 0;
  for (const match of prompt.matchAll(/@图片(\d+)/gu)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= images.length) throw new Error(`参考编号越界: ${match[0]}`);
    if (match.index > offset) meta.push({ type: '', id: randomUUID(), meta_type: 'text', text: prompt.slice(offset, match.index) });
    meta.push({ type: '', id: randomUUID(), meta_type: 'image', text: '', material_ref: { type: '', id: randomUUID(), material_idx: index } });
    used.add(index);
    offset = match.index + match[0].length;
  }
  if (used.size !== images.length) throw new Error('每张参考图必须通过 @图片N 绑定，禁止丢弃参考图');
  if (offset < prompt.length) meta.push({ type: '', id: randomUUID(), meta_type: 'text', text: prompt.slice(offset) });
  return {
    type: '', id: randomUUID(),
    material_list: images.map(image => ({
      type: '', id: randomUUID(), material_type: 'image',
      image_info: { type: 'image', id: randomUUID(), source_from: 'upload', platform_type: 1, uri: image.uri, width: image.width, height: image.height, format: image.format },
    })),
    meta_list: meta,
  };
}

/** Only actual output fields count. Covers, arbitrary URLs and failed partials do not. */
export function parseProductionTask(taskId: string, mediaType: MediaType, record: any): ProductionTask {
  const result: ProductionTask = { taskId, mediaType, status: 'not_found', outputs: [] };
  if (!record) return result;
  // Expose only observed, well-defined counts. Forecast costs have unverified
  // units and are not a percentage or a reliable remaining-time estimate.
  const progress: NonNullable<ProductionTask['progress']> = {};
  for (const [source, target] of [['queue_idx', 'queuePosition'], ['queue_length', 'queueLength']] as const) {
    const value = record.queue_info?.[source];
    if (Number.isSafeInteger(value) && value >= 0) progress[target] = value;
  }
  if (Object.keys(progress).length) result.progress = progress;
  const status = record.common_attr?.status ?? record.status;
  if ([30, 'failed', 'error'].includes(status)) return { ...result, status: 'failed', error: `生成失败 (${record.fail_code ?? record.common_attr?.fail_code ?? 'unknown'})` };
  const items: any[] = record.item_list ?? [];
  const total = mediaType === 'image' ? record.total_image_count : record.total_video_count;
  if ((total !== undefined && total > 1) || items.length > 1) {
    return { ...result, status: 'failed', error: `结果数量不符：只授权 1 个结果，任务报告 ${total ?? items.length} 个；不会续生成或重新提交` };
  }
  if (![50, 'completed', 'success'].includes(status)) return { ...result, status: 'processing' };
  const item = items[0];
  if (mediaType === 'image' && item?.video) return { ...result, status: 'failed', error: '任务返回视频而非图片，不能使用封面代替' };
  const url = mediaType === 'image'
    ? item?.image?.large_images?.[0]?.image_url ?? item?.image_url ?? item?.image?.url
    : item?.video?.transcoded_video?.origin?.video_url ?? item?.video?.video_url ?? item?.video?.origin?.video_url ?? item?.video_url;
  if (typeof url !== 'string' || !url.startsWith('https://')) return { ...result, status: 'failed', error: `任务完成但缺少 ${mediaType} 原始结果地址` };
  return { ...result, status: 'completed', outputs: [{ mediaType, url }] };
}

export async function queryProductionTask(taskId: string, mediaType: MediaType, client = new HttpClient()): Promise<ProductionTask> {
  if (!/^(?:[0-9a-f]{8}-[0-9a-f-]{27}|\d+)$/i.test(taskId)) throw new Error('invalid taskId');
  const response = await client.request({
    url: '/mweb/v1/get_history_by_ids', params: client.generateRequestParams(),
    data: { [taskId.includes('-') ? 'submit_ids' : 'history_ids']: [taskId] },
  });
  if (String(response?.ret) !== '0') throw new Error(`任务查询失败 (${response?.ret ?? 'invalid response'})`);
  return parseProductionTask(taskId, mediaType, response.data?.[taskId]);
}
