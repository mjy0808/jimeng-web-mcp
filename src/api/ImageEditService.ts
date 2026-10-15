import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { imageSize } from 'image-size';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { DRAFT_VERSION } from '../types/models.js';
import { HttpClient } from './HttpClient.js';
import { ImageUploader, type UploadResult } from './ImageUploader.js';

const absolutePath = z.string().min(1).refine(isAbsolute, '必须使用本机绝对路径');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, '必须提供已审核文件的 SHA256');

/** Native canvas repaint, distinct from whole-image reference generation and video editing. */
export const imageEditSchema = z.object({
  submitId: z.string().uuid(),
  sourceImage: absolutePath.describe('原图绝对路径，PNG/JPEG/WebP'),
  sourceSha256: sha256,
  maskImage: absolutePath.describe('同尺寸、8 位、不透明灰度 PNG；白色修改、黑色保留，灰色用于羽化'),
  maskSha256: sha256,
  prompt: z.string().min(1).max(800).refine(value => value.trim().length > 0, '编辑提示词不能为空'),
  strength: z.number().min(0).max(1).optional().describe('网页局部重绘的 strength；省略时交由平台默认处理'),
});
export type ImageEditParams = z.infer<typeof imageEditSchema>;
export interface ImageEditDimensions { width: number; height: number }
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 16_777_216;

async function reviewedFile(path: string, expected: string): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error('局部编辑文件须为非空普通文件，单个文件不超过 20 MiB。');
    const bytes = await file.readFile();
    if (bytes.length > MAX_FILE_BYTES || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('局部编辑文件与审核时的 SHA256 不匹配，未上传或提交。');
    return bytes;
  } finally { await file.close(); }
}

/** Validate bytes, coordinates and mask semantics before either upload or queue acceptance. */
export async function validateImageEditFiles(input: ImageEditParams): Promise<ImageEditDimensions> {
  const p = imageEditSchema.parse(input);
  const source = await reviewedFile(p.sourceImage, p.sourceSha256);
  const mask = await reviewedFile(p.maskImage, p.maskSha256);
  const original = imageSize(source), region = imageSize(mask);
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(original.type ?? '')) throw new Error('原图仅支持 PNG、JPEG 或 WebP。');
  if (original.orientation && original.orientation !== 1) throw new Error('原图含 EXIF 旋转；请先导出方向已校正的原图并按它制作蒙版，避免选区错位。');
  if (!original.width || !original.height || original.width * original.height > MAX_PIXELS) throw new Error('局部编辑原图像素数超过本地 16MP 解码限制。');
  if (region.type !== 'png' || mask[24] !== 8) throw new Error('蒙版必须是 8 位 PNG。');
  if (region.width !== original.width || region.height !== original.height) throw new Error('蒙版尺寸必须与原图完全相同；不会自动缩放或反转选区。');
  const decoded = PNG.sync.read(mask, { checkCRC: true });
  let selected = false, preserved = false;
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const [r, g, b, a] = decoded.data.subarray(offset, offset + 4);
    if (a !== 255 || r !== g || g !== b) throw new Error('蒙版须为不透明灰度图：白色修改、黑色保留；不接受彩色或透明蒙版。');
    if (r > 0) selected = true;
    if (r === 0) preserved = true;
  }
  if (!selected || !preserved) throw new Error('蒙版为空或覆盖整图；局部编辑必须同时包含修改区域和保留区域。');
  return { width: original.width, height: original.height };
}

/** Mirrors official mweb module 419491: painting + postedit generate_type=7 + origin_uri/mask_uri. */
export function imageEditDraft(p: ImageEditParams, source: Pick<UploadResult, 'uri'>,
  mask: Pick<UploadResult, 'uri'>, size: ImageEditDimensions) {
  imageEditSchema.parse(p);
  const componentId = randomUUID();
  const node = () => ({ type: '', id: randomUUID() });
  return {
    submit_id: p.submitId, extend: {},
    metrics_extra: JSON.stringify({ generateCount: 1, promptSource: 'custom' }),
    draft_content: JSON.stringify({
      type: 'draft', id: randomUUID(), version: DRAFT_VERSION, min_version: DRAFT_VERSION,
      min_features: [], is_from_tsn: true, main_component_id: componentId,
      component_list: [{ type: 'image_base_component', id: componentId, min_version: DRAFT_VERSION,
        metadata: { ...node(), created_platform: 3, created_time_in_ms: String(Date.now()), created_platform_version: '', created_did: '' },
        generate_type: 'painting', aigc_mode: 'workbench',
        abilities: { ...node(), painting: {
          ...node(), core_param: { ...node(), prompt: p.prompt,
            ...(p.strength === undefined ? {} : { strength: p.strength }),
            large_image_info: { ...node(), width: size.width, height: size.height } },
          postedit_param: { ...node(), generate_type: 7 }, origin_uri: source.uri, mask_uri: mask.uri,
        }, gen_option: { ...node(), gen_count: 1, generate_all: false, is_force_single: true } },
      }],
    }),
    http_common_info: { aid: 513695 },
  };
}

/** Upload exactly the reviewed pair and submit once. Never replay, blend, or continue generation. */
export async function submitImageEdit(input: ImageEditParams, http = new HttpClient(), uploader = new ImageUploader(http)) {
  const p = imageEditSchema.parse(input);
  const dimensions = await validateImageEditFiles(p);
  const source = await uploader.upload(p.sourceImage);
  const mask = await uploader.upload(p.maskImage);
  if (!source.uri || !mask.uri || source.width !== dimensions.width || source.height !== dimensions.height
    || mask.width !== dimensions.width || mask.height !== dimensions.height) throw new Error('局部编辑上传后的尺寸或资源不匹配，未提交生成。');
  // Official modules 135795/366936/158903 identify canvas repaint independently of model-based generation.
  const babi = { scenario: 'image_video_generation', feature_key: 'to_image_inpaint',
    feature_entrance: 'canvas', feature_entrance_detail: 'canvas_inpaint', edit_type: 'canva',
    tool_id: 'canva', sub_tool_id: 'to_image_inpaint', tab_name: 'canvas', enter_from: 'canvas_inpaint',
    template_id: '', scene_lv1: 'canva', scene_lv2: 'canva' };
  const reply = await http.request({ url: '/mweb/v1/aigc_draft/generate', params: {
    ...http.generateRequestParams(), babi_param: encodeURIComponent(JSON.stringify(babi)),
  },
    data: imageEditDraft(p, source, mask, dimensions) });
  const history = reply?.data?.aigc_data?.history_record_id;
  const returnedId = reply?.data?.aigc_data?.task?.submit_id ?? reply?.data?.aigc_data?.submit_id ?? reply?.data?.submit_id;
  if (String(reply?.ret) !== '0' || (returnedId !== undefined && returnedId !== p.submitId)
    || (!history && returnedId !== p.submitId)) throw new Error('局部编辑提交回执不明确或不匹配；只查询原 submitId，禁止重新提交。');
  return { taskId: p.submitId, ...(history ? { historyId: String(history) } : {}), mediaType: 'image', status: 'submitted' };
}
