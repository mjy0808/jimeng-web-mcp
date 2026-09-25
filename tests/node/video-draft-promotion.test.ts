import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { submitVideoDraftPromotion, videoDraftPromotionBody } from '../../src/api/VideoDraftPromotionService.js';
import type { HttpClient } from '../../src/api/HttpClient.js';

const draftTaskId = randomUUID();
const params = { submitId: randomUUID(), draftTaskId, resolution: '1080p' as const };
const source = {
  status: 50, history_record_id: '123456789', item_list: [{ id: '987654321' }],
  draft_content: JSON.stringify({ main_component_id: 'source', component_list: [{ id: 'source',
    abilities: { gen_video: { text_to_video_params: { model_req_key: 'dreamina_seedance_45_pro',
      video_gen_inputs: [{ is_draft_mode: true, resolution: '480p', duration_ms: 8000 }] } } },
  }] }),
};

test('finalization binds the original Draft history and item instead of rebuilding its prompt', () => {
  const body = videoDraftPromotionBody(params, source, { benefit_type: 'draft-final', amount: 8 });
  const component = JSON.parse(body.draft_content).component_list[0];
  const input = component.abilities.gen_video.text_to_video_params.video_gen_inputs[0];
  assert.equal(body.submit_id, params.submitId);
  assert.equal(component.process_type, 15);
  assert.equal(component.abilities.gen_video.video_ref_params.item_id, '987654321');
  assert.equal(input.origin_history_id, '123456789');
  assert.equal(input.resolution, '1080p');
  assert.equal(input.v2v_opt.generate_from_draft.enable, true);
  assert.equal(input.prompt, undefined);
  assert.throws(() => videoDraftPromotionBody(params, { ...source, draft_content: source.draft_content.replace('true', 'false') }, {}), /原始 480p 样片/);
});

test('unsupported provider finalization is rejected before the paid generate endpoint', async () => {
  const calls: string[] = [];
  const client = {
    generateRequestParams: () => ({}),
    request: async ({ url }: { url: string }) => {
      calls.push(url);
      if (url.includes('get_history_by_ids')) return { ret: '0', data: { [draftTaskId]: source } };
      if (url.includes('get_common_config')) return { ret: '0', data: { model_list: [{ model_req_key: 'dreamina_seedance_45_pro', model_status: 0, options: [] }] } };
      throw new Error('must not submit');
    },
  } as unknown as HttpClient;
  await assert.rejects(submitVideoDraftPromotion(params, client), /没有开放该样片升清规格/);
  assert.deepEqual(calls, ['/mweb/v1/get_history_by_ids', '/mweb/v1/video_generate/get_common_config']);
});

test('supported promotion submits one finalization request at the chosen resolution', async () => {
  const calls: string[] = [];
  let generated: any;
  const client = {
    generateRequestParams: () => ({}),
    request: async ({ url, data }: { url: string; data: any }) => {
      calls.push(url);
      if (url.includes('get_history_by_ids')) return { ret: 0, data: { [draftTaskId]: source } };
      if (url.includes('get_common_config')) return { ret: 0, data: { model_list: [{
        model_req_key: 'dreamina_seedance_45_pro', model_status: 0,
        options: [{ key: 'generate_from_draft_config', generate_from_draft_config_val: { resolution: {
          string_value: ['720p', '1080p'], disabled_string_value: [],
        } } }],
        commercial_config: { resolution_price_configs: [{ resolution: '1080p', price: { benefit_type: 'final-1080p' } }] },
      }] } };
      generated = data;
      return { ret: 0, data: { aigc_data: { task: { submit_id: params.submitId } } } };
    },
  } as unknown as HttpClient;
  assert.deepEqual(await submitVideoDraftPromotion(params, client), { taskId: params.submitId, mediaType: 'video', status: 'submitted' });
  assert.equal(calls.filter(url => url.endsWith('/generate')).length, 1);
  assert.equal(generated.extend.m_video_commerce_info.benefit_type, 'final-1080p');
  assert.equal(generated.extend.m_video_commerce_info.amount, 8);
  assert.equal(JSON.parse(generated.draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].resolution, '1080p');
});
