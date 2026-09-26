import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoService, VideoSubmissionRejectedError } from '../../src/api/VideoService.js';
import type { HttpClient } from '../../src/api/HttpClient.js';
import type { ImageUploader } from '../../src/api/ImageUploader.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerProductionTools } from '../../src/production-tools.js';

function service(response: unknown, available = true) {
  const calls: string[] = [];
  let submitted: any;
  const http = {
    generateRequestParams: () => ({}),
    request: async ({ url, data }: { url: string; data: any }) => {
      calls.push(url);
      if (url.includes('get_common_config')) return { ret: '0', data: { model_list: [{
        model_req_key: 'dreamina_seedance_45_pro', model_status: 0,
        options: [{ key: 'resolution', forbidden_display: false, enum_val: { string_value: available ? ['480p'] : [] } }],
        commercial_config: { resolution_price_configs: [{ resolution: '480p', price: { benefit_type: 'current-sample-price' } }] },
      }] } };
      submitted = data;
      return response;
    },
  } as unknown as HttpClient;
  const uploader = { upload: async (path: string) => { calls.push(`upload:${path}`); return { uri: path, width: 1280, height: 720, format: 'png' }; } } as unknown as ImageUploader;
  return { video: new VideoService(http, uploader), calls, submitted: () => submitted };
}

test('sample uses live account price before uploading references or submitting', async () => {
  const x = service({ ret: '0', data: { aigc_data: { submit_id: 'offline-id' } } });
  const result = await x.video.generateTextToVideo({
    submitId: 'offline-id', prompt: '@图片1人物前行', model: 'seedance-2.5', resolution: '480p',
    duration: 6000, draft: true, referenceImages: ['/approved.png'], async: true,
  });
  assert.equal(result.taskId, 'offline-id');
  assert.deepEqual(x.calls, ['/mweb/v1/video_generate/get_common_config', 'upload:/approved.png', '/mweb/v1/aigc_draft/generate']);
  assert.equal(x.submitted().extend.m_video_commerce_info.benefit_type, 'current-sample-price');
  assert.equal(x.submitted().extend.m_video_commerce_info.amount, 6);
  const input = JSON.parse(x.submitted().draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
  assert.equal(input.is_draft_mode, true);
});

test('unavailable sample configuration fails before uploads or billable submission', async () => {
  const x = service({}, false);
  await assert.rejects(x.video.generateTextToVideo({
    prompt: '@图片1人物前行', model: 'seedance-2.5', resolution: '480p', duration: 6000,
    draft: true, referenceImages: ['/approved.png'], async: true,
  }), error => error instanceof VideoSubmissionRejectedError && /未开放所选/.test(error.message));
  assert.deepEqual(x.calls, ['/mweb/v1/video_generate/get_common_config']);
});

test('explicit provider refusal is distinguishable from an uncertain submission', async () => {
  const rejected = service({ ret: '1001', errmsg: 'invalid parameter' });
  await assert.rejects(rejected.video.generateTextToVideo({
    prompt: '人物前行', model: 'seedance-2.5', resolution: '480p', duration: 6000, draft: true, async: true,
  }), error => error instanceof VideoSubmissionRejectedError && /invalid parameter/.test(error.message));
  const uncertain = service({ ret: '0' });
  await assert.rejects(uncertain.video.generateTextToVideo({
    prompt: '人物前行', model: 'seedance-2.5', resolution: '480p', duration: 6000, draft: true, async: true,
  }), error => error instanceof Error && !(error instanceof VideoSubmissionRejectedError) && /未返回 submit_id/.test(error.message));
});

test('MCP reports a definitive video refusal as structured rejected status', async () => {
  const previousToken = process.env.JIMENG_API_TOKEN;
  const original = VideoService.prototype.generateTextToVideo;
  process.env.JIMENG_API_TOKEN = 'offline-only';
  VideoService.prototype.generateTextToVideo = async () => { throw new VideoSubmissionRejectedError('即梦明确拒绝视频提交：invalid parameter'); };
  const server = new McpServer({ name: 'rejected-test', version: '1' });
  registerProductionTools(server);
  const client = new Client({ name: 'rejected-client', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    const response = await client.callTool({ name: 'production_submit', arguments: {
      submitId: 'f713e452-c500-4ecd-823d-7f7aff0be8fa', mediaType: 'video',
      model: 'seedance-2.5', prompt: '山道上人物前行', references: [], ratio: '16:9',
      resolution: '480p', durationSeconds: 6, draft: true,
    } });
    assert.notEqual(response.isError, true);
    assert.deepEqual(response.structuredContent, {
      taskId: 'f713e452-c500-4ecd-823d-7f7aff0be8fa', mediaType: 'video',
      status: 'rejected', error: '即梦明确拒绝视频提交：invalid parameter',
    });
  } finally {
    VideoService.prototype.generateTextToVideo = original;
    if (previousToken === undefined) delete process.env.JIMENG_API_TOKEN;
    else process.env.JIMENG_API_TOKEN = previousToken;
    await client.close();
    await server.close();
  }
});
