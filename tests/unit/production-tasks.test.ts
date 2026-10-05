import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProductionTools } from '../../src/production-tools.js';
import axios from 'axios';
import { HttpClient } from '../../src/api/HttpClient.js';
import { VideoUploader } from '../../src/api/VideoUploader.js';
import { ImageUploader } from '../../src/api/ImageUploader.js';
import { NewJimengClient } from '../../src/api/NewJimengClient.js';
import { parseProductionTask, queryProductionTask, unifiedImageInput, unifiedReferenceInput } from '../../src/api/ProductionTasks.js';
import { getModel } from '../../src/types/models.js';
import { CacheManager } from '../../src/utils/cache-manager.js';

afterEach(() => { jest.restoreAllMocks(); CacheManager.clear(); CacheManager.stopPeriodicEviction(); });
describe('Film Studio single-result production protocol', () => {
  it('forwards reviewed per-image strength through production_submit into the real HTTP payload', async () => {
    jest.spyOn(ImageUploader.prototype, 'upload').mockImplementation(async path => ({ uri: path, width: 1280, height: 720, format: 'png' } as any));
    const request = jest.spyOn(HttpClient.prototype, 'request').mockResolvedValue({ ret: '0', data: { aigc_data: { history_record_id: 'image-strength-test' } } } as any);
    const server = new McpServer({ name: 'image-strength-test', version: '1' }); registerProductionTools(server);
    const client = new Client({ name: 'offline-strength', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const originalToken = process.env.JIMENG_API_TOKEN; process.env.JIMENG_API_TOKEN = 'offline-only';
    const args = { submitId: randomUUID(), mediaType: 'image', model: 'jimeng-5.0-pro', prompt: '@图片1结构，@图片2画风，@图片3材质。', references: ['/structure.png', '/style.png', '/sample.png'], referenceStrengths: [0.9, 0.25, 0.4], ratio: '16:9', resolution: '2k' };
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const result = await client.callTool({ name: 'production_submit', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      const draft = JSON.parse(request.mock.calls[0]![0].data.draft_content);
      expect(draft.component_list[0].abilities.blend.ability_list.map((ref: any) => ({ path: ref.image_uri_list[0], strength: ref.strength }))).toEqual(args.references.map((path, i) => ({ path, strength: args.referenceStrengths[i] })));
      request.mockClear();
      const invalid = await client.callTool({ name: 'production_submit', arguments: { ...args, referenceStrengths: [0.9] } });
      expect(invalid.isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
      const legacy = { ...args }; delete (legacy as any).referenceStrengths;
      await client.callTool({ name: 'production_submit', arguments: legacy });
      const legacyDraft = JSON.parse(request.mock.calls[0]![0].data.draft_content);
      expect(legacyDraft.component_list[0].abilities.blend.ability_list.map((ref: any) => ref.strength)).toEqual([0.5, 0.5, 0.5]);
    } finally {
      if (originalToken === undefined) delete process.env.JIMENG_API_TOKEN; else process.env.JIMENG_API_TOKEN = originalToken;
      await client.close(); await server.close();
    }
  });
  it('exposes observed queue counts without inventing percentage or interpreting forecast units', () => {
    expect(parseProductionTask('1', 'video', { status: 20, queue_info: { queue_idx: 8, queue_length: 40 }, forecast_queue_cost: 4000 }).progress).toEqual({ queuePosition: 8, queueLength: 40 });
    expect(parseProductionTask('1', 'video', { status: 20, queue_info: { queue_idx: 0, queue_length: 0 } }).progress).toEqual({ queuePosition: 0, queueLength: 0 });
    for (const value of [-1, 1.5, '5', null, Infinity]) {
      expect(parseProductionTask('1', 'video', { status: 20, queue_info: { queue_idx: value, queue_length: value } }).progress).toBeUndefined();
    }
  });
  it('never forwards the session cookie to upload hosts or follows redirects', async () => {
    const original = axios.defaults.adapter;
    const requests: any[] = [];
    axios.defaults.adapter = async config => { requests.push(config); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; };
    try {
      const client = new HttpClient('offline-session');
      await client.request({ url: '/mweb/v1/get_history_by_ids', data: {} });
      await client.request({ url: 'https://imagex.volcengineapi.com/', data: {} });
      expect(requests[0].headers.get('Cookie')).toContain('sessionid=offline-session');
      expect(requests[1].headers.get('Cookie')).toBeUndefined();
      expect(requests.every(request => request.maxRedirects === 0 && request.family === 4)).toBe(true);
    } finally { axios.defaults.adapter = original; }
  });
  it('maps current Pro and 4.7 keys exactly', () => {
    expect(getModel('jimeng-5.0-pro')).toBe('high_aes_general_v50p_large');
    expect(getModel('jimeng-4.7')).toBe('high_aes_general_v43');
  });
  it('preserves ordered reference tokens and surrounding prose without numeric material types', () => {
    const value = unifiedImageInput('角色@图片2走进@图片1，保持@图片2外貌。', [{ uri: 'scene' }, { uri: 'person' }]);
    expect(value.material_list.map(item => item.image_info.uri)).toEqual(['scene', 'person']);
    expect(value.meta_list.filter(item => item.meta_type === 'image').map(item => item.material_ref.material_idx)).toEqual([1, 0, 1]);
    expect(value.meta_list.map(item => item.meta_type === 'text' ? item.text : `@图片${item.material_ref.material_idx + 1}`).join('')).toBe('角色@图片2走进@图片1，保持@图片2外貌。');
    expect(() => unifiedImageInput('@图片3', [{ uri: 'one' }])).toThrow(/越界/);
    expect(() => unifiedImageInput('@图片1', [{}, {}])).toThrow(/每张参考图/);
  });
  it('builds Seedance unified-edit version/feature and persists caller ID', async () => {
    const requests: any[] = [];
    const submitId = randomUUID();
    jest.spyOn(ImageUploader.prototype, 'upload').mockImplementation(async path => ({ uri: path, width: 1280, height: 720, format: 'png' } as any));
    jest.spyOn(HttpClient.prototype, 'request').mockImplementation(async input => {
      requests.push(input);
      return { ret: '0', data: { aigc_data: { submit_id: submitId } } } as any;
    });
    const client = new NewJimengClient('offline-only');
    await client.generateTextToVideo({ submitId, model: 'seedance-2.5', prompt: '@图片1角色，@图片2场景。', referenceImages: ['/person.png', '/scene.png'], async: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].data.submit_id).toBe(submitId);
    const draft = JSON.parse(requests[0].data.draft_content);
    expect(draft.min_features).toEqual(['AIGC_Video_UnifiedEdit']);
    expect(draft.version).toBe('3.3.9');
    const input = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
    expect(input.prompt).toBe('');
    expect(input.unified_edit_input.material_list).toHaveLength(2);
    expect(input.first_frame_image).toBeUndefined();
  });
  it('keeps image numbering independent of one previous-video material and does not set an edit range', () => {
    const prompt = '衔接@视频1末段，@图片2人物沿@图片1场地继续移动。';
    const input = unifiedReferenceInput(prompt, [{ uri: 'scene' }, { uri: 'person' }], { vid: 'prior', width: 1280, height: 720, durationMs: 10000, fps: 24 });
    expect(input.material_list.map(m => m.material_type)).toEqual(['video', 'image', 'image']);
    expect(input.meta_list.filter(m => m.meta_type !== 'text').map(m => m.material_ref.material_idx)).toEqual([0, 2, 1]);
    expect(input.meta_list.map(m => m.meta_type === 'text' ? m.text : m.meta_type === 'video' ? '@视频1' : '@图片' + m.material_ref.material_idx).join('')).toBe(prompt);
    expect(input).not.toHaveProperty('edit_input');
    expect(() => unifiedReferenceInput('@视频2', [], { vid: 'p', width: 1, height: 1, durationMs: 4000, fps: 24 })).toThrow(/越界/);
    expect(() => unifiedImageInput('@视频1', [])).toThrow(/越界/);
    expect(() => unifiedReferenceInput('继续走', [], { vid: 'p', width: 1, height: 1, durationMs: 4000, fps: 24 })).toThrow(/@视频1/);
  });
  it('routes video continuity through production_submit using current input-video commerce, new duration and exact source', async () => {
    const video = jest.spyOn(VideoUploader.prototype, 'upload').mockResolvedValue({ vid: 'prior', width: 1280, height: 720, durationMs: 10000, fps: 24 });
    jest.spyOn(ImageUploader.prototype, 'upload').mockResolvedValue({ uri: 'scene', width: 1280, height: 720, format: 'png' } as any);
    const request = jest.spyOn(HttpClient.prototype, 'request').mockImplementation(async input => input.url === '/mweb/v1/video_generate/get_common_config'
      ? { ret: '0', data: { model_list: [{ model_req_key: 'dreamina_seedance_45_pro', model_status: 0,
        options: [{ key: 'resolution', enum_val: { string_value: ['720p'] } }],
        commercial_config: { resolution_price_configs: [{ resolution: '720p', price: { benefit_type: 'seedance_25_720p_output' } }] },
      }] } } as any : { ret: '0', data: { aigc_data: { submit_id: input.data.submit_id } } } as any);
    const server = new McpServer({ name: 'continuity-test', version: '1' }); registerProductionTools(server);
    const mcp = new Client({ name: 'offline-continuity', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const originalToken = process.env.JIMENG_API_TOKEN; process.env.JIMENG_API_TOKEN = 'offline-only';
    const args = { submitId: randomUUID(), mediaType: 'video', model: 'seedance-2.5', prompt: '衔接@视频1，沿@图片1继续向前。',
      references: ['/scene.png'], referenceVideo: { path: '/prior.mp4', sha256: 'a'.repeat(64), durationMs: 10000 }, ratio: '16:9', resolution: '720p', durationSeconds: 7 };
    try {
      await server.connect(serverTransport); await mcp.connect(clientTransport);
      const result = await mcp.callTool({ name: 'production_submit', arguments: args });
      expect(result.structuredContent).toEqual({ taskId: args.submitId, mediaType: 'video', status: 'submitted' });
      expect(video).toHaveBeenCalledWith('/prior.mp4', args.referenceVideo.sha256);
      const submitted = request.mock.calls.at(-1)![0];
      expect(submitted.params?.commerce_with_input_video).toBe('1');
      expect(submitted.data.extend.m_video_commerce_info).toMatchObject({ benefit_type: 'seedance_25_720p_output', amount: 7 });
      const input = JSON.parse(submitted.data.draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
      expect(input.duration_ms).toBe(7000);
      expect(input.unified_edit_input.material_list[0].video_info.vid).toBe('prior');
      expect(input.unified_edit_input.edit_input).toBeUndefined();
      expect(input.first_frame_image).toBeUndefined(); expect(input.end_frame_image).toBeUndefined();
      video.mockClear(); request.mockClear();
      expect((await mcp.callTool({ name: 'production_submit', arguments: { ...args, model: 'seedance-2.0' } })).isError).toBe(true);
      expect(video).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    } finally {
      if (originalToken === undefined) delete process.env.JIMENG_API_TOKEN; else process.env.JIMENG_API_TOKEN = originalToken;
      await mcp.close(); await server.close();
    }
  });
  it('rejects unavailable video commerce before uploads and rejects changed source before submission', async () => {
    const video = jest.spyOn(VideoUploader.prototype, 'upload').mockRejectedValue(new Error('参考视频与审核时文件不一致'));
    const image = jest.spyOn(ImageUploader.prototype, 'upload');
    const request = jest.spyOn(HttpClient.prototype, 'request').mockResolvedValue({ ret: '0', data: { model_list: [] } } as any);
    const args = { submitId: randomUUID(), model: 'seedance-2.5', prompt: '@视频1继续@图片1场景。', referenceImages: ['/scene.png'],
      referenceVideo: { path: '/prior.mp4', sha256: 'a'.repeat(64), durationMs: 10000 }, resolution: '720p' as const, duration: 7000, async: true };
    const client = new NewJimengClient('offline-only');
    await expect(client.generateTextToVideo(args)).rejects.toThrow(/计费配置/);
    expect(video).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled();
    request.mockResolvedValue({ ret: '0', data: { model_list: [{ model_req_key: 'dreamina_seedance_45_pro', model_status: 0,
      options: [{ key: 'resolution', enum_val: { string_value: ['720p'] } }],
      commercial_config: { resolution_price_configs: [{ resolution: '720p', price: { benefit_type: 'seedance_25_720p_no_input_video_output' } }] } }] } } as any);
    await expect(client.generateTextToVideo(args)).rejects.toThrow(/计费配置/); expect(video).not.toHaveBeenCalled();
    request.mockResolvedValue({ ret: '0', data: { model_list: [{ model_req_key: 'dreamina_seedance_45_pro', model_status: 0,
      options: [{ key: 'resolution', enum_val: { string_value: ['720p'] } }],
      commercial_config: { resolution_price_configs: [{ resolution: '720p', price: { benefit_type: 'seedance_25_720p_output' } }] } }] } } as any);
    await expect(client.generateTextToVideo(args)).rejects.toThrow(/审核时/);
    expect(image).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([input]) => input.url !== '/mweb/v1/aigc_draft/generate')).toBe(true);
  });
  it('uses a placeholder per image, requests exactly one output and preserves image submit ID', async () => {
    const submitId = randomUUID();
    let body: any;
    jest.spyOn(ImageUploader.prototype, 'uploadBatch').mockResolvedValue([1, 2, 3].map(index => ({ uri: String(index), width: 100, height: 100, format: 'png' })) as any);
    jest.spyOn(HttpClient.prototype, 'request').mockImplementation(async input => {
      body = input.data;
      return { ret: '0', data: { aigc_data: { history_record_id: '12345' } } } as any;
    });
    await new NewJimengClient('offline-only').generateImage({ submitId, prompt: '三个参考', filePath: ['/a', '/b', '/c'], model: 'jimeng-4.7', count: 1, async: true, refresh_token: 'offline-only' });
    expect(body.submit_id).toBe(submitId);
    const abilities = JSON.parse(body.draft_content).component_list[0].abilities;
    expect(abilities.gen_option.gen_count).toBe(1);
    expect(JSON.stringify(abilities)).toContain('######三个参考');
  });
  it.each(['seedance-2.0', 'seedance-2.5'])('submits a real first frame through production_submit for %s, never as a unified image', async model => {
    const submitId = randomUUID();
    const upload = jest.spyOn(ImageUploader.prototype, 'upload').mockResolvedValue({ uri: 'approved-tail', width: 1280, height: 720, format: 'png' } as any);
    const request = jest.spyOn(HttpClient.prototype, 'request').mockResolvedValue({ ret: '0', data: { aigc_data: { submit_id: submitId } } } as any);
    const server = new McpServer({ name: 'production-test', version: '1' });
    registerProductionTools(server);
    const mcp = new Client({ name: 'offline-first-frame', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const originalToken = process.env.JIMENG_API_TOKEN;
    process.env.JIMENG_API_TOKEN = 'offline-only';
    try {
      await server.connect(serverTransport);
      await mcp.connect(clientTransport);
      const args = { submitId, mediaType: 'video', model, prompt: '从首帧继续，雨滴沿窗滑落。', references: [], firstFrameImage: '/approved-tail.png', ratio: '16:9', resolution: '720p', durationSeconds: 4 };
      const result = await mcp.callTool({ name: 'production_submit', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ taskId: submitId, mediaType: 'video', status: 'submitted' });
      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledWith('/approved-tail.png');
      const body = request.mock.calls[0][0].data;
      const draft = JSON.parse(body.draft_content);
      const input = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
      expect(body.submit_id).toBe(submitId);
      expect(input.first_frame_image.uri).toBe('approved-tail');
      expect(input.first_frame_image.image_uri).toBe('approved-tail');
      expect(input.unified_edit_input).toBeUndefined();
      expect(input.end_frame_image).toBeUndefined();
      expect(input.prompt).toBe(args.prompt);
      expect(input.duration_ms).toBe(4000);
      expect(JSON.parse(body.metrics_extra).functionMode).toBe('first_last_frames');
      expect((await mcp.callTool({ name: 'production_submit', arguments: { ...args, prompt: '字'.repeat(16000) } })).isError).not.toBe(true);
      upload.mockClear(); request.mockClear();
      for (const invalid of [
        { ...args, prompt: '字'.repeat(16001) },
        { ...args, references: ['/person.png'] },
        { ...args, prompt: '@图片1 从首帧继续。' },
        { ...args, mediaType: 'image', model: 'jimeng-5.0-lite', resolution: '2k', durationSeconds: undefined },
      ]) {
        expect((await mcp.callTool({ name: 'production_submit', arguments: invalid }).catch(error => {
          expect(error.message).toMatch(/Invalid arguments|16000/); return { isError: true };
        })).isError).toBe(true);
      }
      expect(upload).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      if (originalToken === undefined) delete process.env.JIMENG_API_TOKEN; else process.env.JIMENG_API_TOKEN = originalToken;
      await mcp.close(); await server.close();
    }
  });
  it('routes a Seedance 2.5 sample through production_submit without treating ordinary 480p as a sample', async () => {
    const request = jest.spyOn(HttpClient.prototype, 'request').mockImplementation(async input => input.url === '/mweb/v1/video_generate/get_common_config'
      ? { ret: '0', data: { model_list: [{ model_req_key: 'dreamina_seedance_45_pro_draft', model_status: 0, extra: { is_draft_mode: true },
        options: [{ key: 'resolution', forbidden_display: false, enum_val: { string_value: ['480p'] } }],
        commercial_config: { resolution_price_configs: [{ resolution: '480p', price: { benefit_type: 'seedance_25_draft_480p_output' } }] },
      }] } } as any
      : { ret: '0', data: { aigc_data: { submit_id: input.data.submit_id } } } as any);
    const server = new McpServer({ name: 'sample-test', version: '1' });
    registerProductionTools(server);
    const mcp = new Client({ name: 'offline-sample', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const originalToken = process.env.JIMENG_API_TOKEN;
    process.env.JIMENG_API_TOKEN = 'offline-only';
    const args = { submitId: randomUUID(), mediaType: 'video', model: 'seedance-2.5', prompt: '雨夜街道', references: [], ratio: '16:9', resolution: '480p', durationSeconds: 4 };
    try {
      await server.connect(serverTransport);
      await mcp.connect(clientTransport);
      expect((await mcp.callTool({ name: 'production_submit', arguments: { ...args, draft: true } })).isError).not.toBe(true);
      let input = JSON.parse(request.mock.calls.at(-1)![0].data.draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
      expect(input.is_draft_mode).toBe(true);
      expect((await mcp.callTool({ name: 'production_submit', arguments: { ...args, submitId: randomUUID() } })).isError).not.toBe(true);
      input = JSON.parse(request.mock.calls.at(-1)![0].data.draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
      expect(input.is_draft_mode).toBeUndefined();
      request.mockClear();
      expect((await mcp.callTool({ name: 'production_submit', arguments: { ...args, model: 'seedance-2.0', draft: true } })).isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
    } finally {
      if (originalToken === undefined) delete process.env.JIMENG_API_TOKEN; else process.env.JIMENG_API_TOKEN = originalToken;
      await mcp.close(); await server.close();
    }
  });
  it('does not mistake covers, partial failures, or extra images for success', () => {
    for (const record of [
      { status: 50, item_list: [{ common_attr: { cover_url: 'https://cdn.byteimg.com/cover.jpg' } }] },
      { status: 30, item_list: [{ video: { video_url: 'https://cdn.byteimg.com/result.mp4' } }] },
    ]) expect(parseProductionTask('1', 'video', record).status).toBe('failed');
    expect(parseProductionTask('1', 'image', { status: 20, total_image_count: 8 }).status).toBe('failed');
    expect(parseProductionTask('1', 'image', { status: 20, total_image_count: 0 }).status).toBe('processing');
    expect(parseProductionTask('1', 'image', undefined).status).toBe('not_found');
    expect(parseProductionTask('1', 'image', { status: 50, total_image_count: 1, item_list: [{ image: { large_images: [{ image_url: 'https://cdn.byteimg.com/result.png' }] } }] }).status).toBe('completed');
  });
  it('queries UUIDs via submit_ids without cache, continuation or submission', async () => {
    const id = randomUUID();
    const request = jest.spyOn(HttpClient.prototype, 'request').mockResolvedValue({ ret: '0', data: {} } as any);
    const result = await queryProductionTask(id, 'image', new HttpClient('offline-only'));
    expect(result.status).toBe('not_found');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].data).toEqual({ submit_ids: [id] });
    request.mockResolvedValueOnce({ ret: '-1', data: {} } as any);
    await expect(queryProductionTask(id, 'video', new HttpClient('offline-only'))).rejects.toThrow(/查询失败/);
  });
});
