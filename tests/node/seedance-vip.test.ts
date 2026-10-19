import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VideoService, VideoSubmissionRejectedError } from '../../src/api/VideoService.js';
import { productionSubmitSchema, validateProductionSubmit } from '../../src/production-tools.js';
import { getVideoModel } from '../../src/types/models.js';
import { vipModels } from '../support/seedance-vip.js';

function fixture(models = vipModels(), refused = false) {
  const calls: string[] = []; let body: any;
  const http = { generateRequestParams: () => ({}), request: async (input: any) => {
    calls.push(input.url);
    if (input.url.includes('get_common_config')) return { ret: '0', data: { model_list: models } };
    body = input.data;
    return refused ? { ret: '4013', errmsg: '生成失败，疑似存在异常行为，请重新尝试' } : { ret: '0', data: { aigc_data: { submit_id: 'offline-task' } } };
  } };
  const uploader = { upload: async (path: string) => { calls.push('upload:' + path); return { uri: 'reference', width: 1024, height: 1536, format: 'png' }; } };
  return { service: new VideoService(http as any, uploader as any), calls, body: () => body };
}
const selections = [
  ['seedance-2.0-vip', 'dreamina_seedance_40_pro_vision', '720p', 'seedance_20_pro_720p_output'],
  ['seedance-2.0-vip', 'dreamina_seedance_40_pro_vision', '1080p', 'seedance_20_pro_1080p_output'],
  ['seedance-2.0-vip', 'dreamina_seedance_40_pro_vision', '4k', 'seedance_20_pro_4k_output'],
  ['seedance-2.0-fast-vip', 'dreamina_seedance_40_vision', '720p', 'seedance_20_fast_720p_output'],
] as const;
for (const [model, key, resolution, benefit] of selections) test(`${model} ${resolution} uses exact VIP route and resolution price once`, async () => {
  const f = fixture();
  await f.service.generateTextToVideo({ model, prompt: '@图片1 跨步重斩', referenceImages: ['/source.png'], resolution, duration: 5000, fps: 24, async: true });
  assert.deepEqual(f.calls, ['/mweb/v1/video_generate/get_common_config', 'upload:/source.png', '/mweb/v1/aigc_draft/generate']);
  const params = JSON.parse(f.body().draft_content).component_list[0].abilities.gen_video.text_to_video_params;
  assert.equal(getVideoModel(model), key); assert.equal(f.body().extend.root_model, key); assert.equal(params.model_req_key, key);
  assert.ok(params.video_gen_inputs[0].unified_edit_input); assert.equal(params.video_gen_inputs[0].first_frame_image, undefined);
  assert.equal(params.video_gen_inputs[0].resolution, resolution);
  assert.equal(f.body().extend.m_video_commerce_info.benefit_type, benefit); assert.equal(f.body().extend.m_video_commerce_info.amount, 5);
  assert.deepEqual(f.body().extend.m_video_commerce_info_list, [f.body().extend.m_video_commerce_info]);
  validateProductionSubmit(productionSubmitSchema.parse({ submitId: '00000000-0000-4000-8000-000000000001', mediaType: 'video', model, prompt: '动作', references: [], ratio: '16:9', resolution, durationSeconds: 5 }));
});
for (const model of ['seedance-2.0-vip', 'seedance-2.0-fast-vip']) test(`${model} rejects unavailable/wrong account VIP price before uploads`, async () => {
  for (const fault of ['missing', 'name', 'status', 'resolution', 'price', 'old-price']) {
    const models = vipModels(); const current = models[model === 'seedance-2.0-vip' ? 0 : 1]!;
    if (fault === 'missing') models.splice(0);
    if (fault === 'name') current.model_name = '即梦 Seedance 2.0';
    if (fault === 'status') current.model_status = 1;
    if (fault === 'resolution') current.options[0]!.enum_val.string_value = [];
    if (fault === 'price') current.commercial_config.resolution_price_configs = [];
    if (fault === 'old-price') current.commercial_config.resolution_price_configs[0]!.price.benefit_type = 'dreamina_seedance_20_fast';
    const f = fixture(models);
    await assert.rejects(f.service.generateTextToVideo({ model, prompt: '@图片1 动作', referenceImages: ['/source.png'], async: true }), VideoSubmissionRejectedError);
    assert.deepEqual(f.calls, ['/mweb/v1/video_generate/get_common_config']);
  }
});
test('retired aliases and invalid VIP controls never upload or submit', async () => {
  const controls = [
    { model: 'seedance-2.0' }, { model: 'seedance-2.0-fast' }, { model: 'seedance-2.0-fast-vip', resolution: '1080p' },
    { model: 'seedance-2.0-vip', resolution: '480p' }, { duration: 16000 }, { duration: 4500 }, { fps: 30 }, { draft: true },
  ];
  for (const patch of controls) {
    const f = fixture();
    await assert.rejects(f.service.generateTextToVideo({ model: 'seedance-2.0-fast-vip', prompt: '动作', async: true, ...patch } as any));
    assert.deepEqual(f.calls, []);
  }
  for (const model of ['seedance-2.0', 'seedance-2.0-fast']) assert.throws(() => validateProductionSubmit(productionSubmitSchema.parse({ submitId: '00000000-0000-4000-8000-000000000001', mediaType: 'video', model, prompt: '动作', references: [], ratio: '16:9', resolution: '720p', durationSeconds: 5 })), /显式选择/);
});
test('VIP 4013 remains an explicit rejection without retry or model substitution', async () => {
  const f = fixture(vipModels(), true);
  await assert.rejects(f.service.generateTextToVideo({ model: 'seedance-2.0-fast-vip', prompt: '@图片1 动作', referenceImages: ['/source.png'], async: true }), /4013/);
  assert.deepEqual(f.calls, ['/mweb/v1/video_generate/get_common_config', 'upload:/source.png', '/mweb/v1/aigc_draft/generate']);
});
