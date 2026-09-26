import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NewJimengClient } from '../../src/api/NewJimengClient.js';
import { HttpClient } from '../../src/api/HttpClient.js';
import { ImageUploader } from '../../src/api/ImageUploader.js';
import { CacheManager } from '../../src/utils/cache-manager.js';
import { createServer } from '../../src/server.js';
import { getModel, getVideoModel } from '../../src/types/models.js';
import { textToVideoOptionsSchema } from '../../src/schemas/video.schemas.js';

// Offline only: capture the actual request builder, never submit a billable task.
describe('Seedance video model selection', () => {
  let client: NewJimengClient;
  let requests: any[];
  const originalToken = process.env.JIMENG_API_TOKEN;

  beforeEach(() => {
    process.env.JIMENG_API_TOKEN = 'test_seedance_models';
    requests = [];
    jest.spyOn(HttpClient.prototype, 'request').mockImplementation(async (options) => {
      if (options.url === '/mweb/v1/video_generate/get_common_config') return {
        ret: '0', data: { model_list: [
          { model_req_key: 'dreamina_seedance_45_pro', model_status: 0, options: [{ key: 'resolution', enum_val: { string_value: ['480p'] } }] },
          { model_req_key: 'dreamina_seedance_45_pro_draft', model_status: 0, extra: { is_draft_mode: true },
            options: [{ key: 'resolution', forbidden_display: false, enum_val: { string_value: ['480p'] } }],
            commercial_config: { resolution_price_configs: [{ resolution: '480p', price: { benefit_type: 'seedance_25_draft_480p_output' } }] },
        }] },
      } as any;
      requests.push(options);
      if (options.url !== '/mweb/v1/aigc_draft/generate') throw new Error('Unexpected endpoint');
      return { data: { aigc_data: { submit_id: 'offline-video-task' } } } as any;
    });
    jest.spyOn(ImageUploader.prototype, 'upload').mockImplementation(async (path) => ({
      uri: path, width: 1280, height: 720, format: 'png'
    } as any));
    jest.spyOn(ImageUploader.prototype, 'uploadBatch').mockResolvedValue([]);
    client = new NewJimengClient('test_seedance_models');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    CacheManager.clear();
    CacheManager.stopPeriodicEviction();
    if (originalToken === undefined) delete process.env.JIMENG_API_TOKEN;
    else process.env.JIMENG_API_TOKEN = originalToken;
  });

  function submittedVideo() {
    const body = requests.at(-1).data;
    const draft = JSON.parse(body.draft_content);
    return { body, params: draft.component_list[0].abilities.gen_video.text_to_video_params };
  }

  it('keeps old Jimeng Video 2.0 separate and rejects unknown/image model fallback', () => {
    expect(getModel('seedance-2.0')).toBe('dreamina_seedance_40_pro');
    expect(getModel('seedance-2.5')).toBe('dreamina_seedance_45_pro');
    expect(getVideoModel('jimeng-video-2.0')).toBe('dreamina_ic_generate_video_model_vgfm_lite');
    for (const model of ['unknown', 'jimeng-5.0-lite', 'toString', 'constructor']) {
      expect(() => getVideoModel(model)).toThrow(/不支持模型/);
    }
  });

  it.each([
    ['seedance-2.0', 'dreamina_seedance_40_pro', '720p', 4000, 'dreamina_video_seedance_20_pro'],
    ['seedance-2.0', 'dreamina_seedance_40_pro', '720p', 15000, 'dreamina_video_seedance_20_pro'],
    ['seedance-2.5', 'dreamina_seedance_45_pro', '480p', 4000, 'seedance_25_480p_no_input_video_output'],
    ['seedance-2.5', 'dreamina_seedance_45_pro', '720p', 5000, 'seedance_25_720p_no_input_video_output'],
    ['seedance-2.5', 'dreamina_seedance_45_pro', '1080p', 30000, 'seedance_25_1080p_no_input_video_output'],
  ])('builds %s / %s / %s / %s with matching commerce metadata', async (model, modelKey, resolution, duration, benefitType) => {
    for (const frames of [{}, { firstFrameImage: '/first.png' }, { firstFrameImage: '/first.png', lastFrameImage: '/last.png' }]) {
      requests.length = 0;
      const result = await client.generateTextToVideo({ prompt: '镜头缓慢推进', model, resolution, duration, ...frames, async: true });
      expect(result.taskId).toBe('offline-video-task');
      expect(requests).toHaveLength(1);
      const { body, params } = submittedVideo();
      expect(body.extend.root_model).toBe(modelKey);
      expect(params.model_req_key).toBe(modelKey);
      expect(params.video_gen_inputs[0]).toEqual(expect.objectContaining({ resolution, duration_ms: duration, fps: 24, video_mode: 2 }));
      expect(params.video_gen_inputs[0].first_frame_image?.uri).toBe(frames.firstFrameImage);
      expect(params.video_gen_inputs[0].end_frame_image?.uri).toBe(frames.lastFrameImage);
      expect(params.video_gen_inputs[0].ending_control).toBe(frames.lastFrameImage ? '1.0' : undefined);
      expect(body.extend.m_video_commerce_info).toEqual({
        benefit_type: benefitType, resource_id: 'generate_video', resource_id_type: 'str', resource_sub_type: 'aigc', amount: Number(duration) / 1000
      });
      expect(body.extend.m_video_commerce_info_list).toEqual([body.extend.m_video_commerce_info]);
      expect(textToVideoOptionsSchema.safeParse({ prompt: '镜头缓慢推进', model, resolution, duration }).success).toBe(true);
    }
  });

  it('submits Seedance 2.5 sample mode with the web draft field and version', async () => {
    await client.generateTextToVideo({ prompt: '样片', model: 'seedance-2.5', resolution: '480p', duration: 4000, draft: true, async: true });
    const { body, params } = submittedVideo();
    const draft = JSON.parse(body.draft_content);
    expect(draft.min_version).toBe('3.3.28');
    expect(draft.version).toBe('3.3.28');
    expect(params.video_gen_inputs[0]).toEqual(expect.objectContaining({ is_draft_mode: true, resolution: '480p', min_version: '3.3.28' }));
    expect(body.extend.m_video_commerce_info.benefit_type).toBe('seedance_25_draft_480p_output');
    expect(body.extend.root_model).toBe('dreamina_seedance_45_pro_draft');
    expect(params.model_req_key).toBe('dreamina_seedance_45_pro_draft');
    expect(requests).toHaveLength(1);
  });

  it.each([
    { model: 'seedance-2.0', resolution: '720p' },
    { model: 'seedance-2.5', resolution: '720p' },
    { model: 'seedance-2.5', resolution: '1080p' },
  ])('rejects invalid sample mode %j before submitting', async options => {
    await expect(client.generateTextToVideo({ prompt: '样片', duration: 4000, draft: true, async: true, ...options })).rejects.toThrow(/样片模式仅支持 480p/);
    expect(requests).toHaveLength(0);
  });

  it.each([
    { model: 'seedance-2.0', resolution: '1080p' },
    { model: 'seedance-2.0', resolution: '480p' },
    { model: 'seedance-2.0', duration: 16000 },
    { model: 'seedance-2.5', duration: 31000 },
    { model: 'seedance-2.5', duration: 3000 },
    { model: 'seedance-2.0', duration: 4500 },
    { model: 'seedance-2.5', duration: NaN },
    { model: 'seedance-2.0', fps: 30 },
    { model: 'seedance-2.5', fps: 12 },
    { model: 'seedance-2.5', resolution: '4k' },
    { model: 'jimeng-video-3.0', resolution: '480p' },
    { model: 'jimeng-video-3.0', duration: 16000 },
    { model: 'jimeng-5.0-lite' },
    { model: 'seedance-typo' },
  ])('rejects unsupported parameters %j before uploads', async (options) => {
    await expect(client.generateTextToVideo({ prompt: 'test', firstFrameImage: '/first.png', ...options, async: true })).rejects.toThrow();
    expect(ImageUploader.prototype.upload).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it.each(['seedance-2.0', 'seedance-2.5'])('does not use %s through the legacy multi/reference wire formats', async (model) => {
    await expect(client.generateMultiFrameVideo({
      model, async: true, frames: [0, 1].map(idx => ({ idx, imagePath: `/${idx}.png`, duration_ms: 2000, prompt: 'test' }))
    })).rejects.toThrow(/不支持模型/);
    await expect(client.generateMainReferenceVideoUnified({
      model, async: true, referenceImages: ['/a.png', '/b.png'], prompt: '[图0]与[图1]'
    })).rejects.toThrow(/不支持模型/);
    expect(ImageUploader.prototype.upload).not.toHaveBeenCalled();
    expect(ImageUploader.prototype.uploadBatch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it('preserves the default and does not overwrite an explicit legacy model when a last frame exists', async () => {
    await client.generateTextToVideo({ prompt: 'test', async: true });
    expect(submittedVideo().params.model_req_key).toBe(getVideoModel('jimeng-video-3.0'));
    expect(submittedVideo().body.extend.m_video_commerce_info.benefit_type).toBe('basic_video_operation_vgfm_v_three');
    expect(submittedVideo().body.extend.m_video_commerce_info.amount).toBeUndefined();
    await client.generateTextToVideo({ prompt: 'test', model: 'jimeng-video-3.0-pro', firstFrameImage: '/first.png', lastFrameImage: '/last.png', async: true });
    expect(submittedVideo().body.extend.root_model).toBe(getVideoModel('jimeng-video-3.0-pro'));
  });

  it('advertises both choices in MCP and applies them through video and video_frame', async () => {
    const server = createServer();
    const mcp = new Client({ name: 'offline-video-model-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await mcp.connect(clientTransport);
      const { tools } = await mcp.listTools();
      for (const name of ['video', 'video_frame']) {
        const modelSchema = tools.find(t => t.name === name)!.inputSchema.properties!.model as any;
        expect(modelSchema.enum).toEqual(expect.arrayContaining(['seedance-2.0', 'seedance-2.5']));
        expect(modelSchema.default).toBe('jimeng-video-3.0');
        for (const model of ['seedance-2.0', 'seedance-2.5']) {
          const response = await mcp.callTool({ name, arguments: {
            prompt: 'test', model, ...(name === 'video_frame' ? { firstFrameImage: '/first.png', lastFrameImage: '/last.png' } : {})
          } });
          expect(response.isError).not.toBe(true);
          expect(submittedVideo().body.extend.root_model).toBe(getVideoModel(model));
        }
      }
      for (const name of ['video_multi', 'video_mix']) {
        const schema = tools.find(t => t.name === name)!.inputSchema.properties!.model as any;
        expect(schema.enum).not.toContain('seedance-2.0');
        expect(schema.enum).not.toContain('seedance-2.5');
      }
      requests.length = 0;
      const invalid = await mcp.callTool({ name: 'video_frame', arguments: { prompt: 'test', model: 'seedance-2.0', resolution: '1080p', firstFrameImage: '/first.png' } });
      expect(invalid.isError).toBe(true);
      await expect(mcp.callTool({ name: 'video', arguments: { prompt: 'test', model: 'typo' } })).rejects.toThrow(/Invalid arguments/);
      expect(requests).toHaveLength(0);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});
