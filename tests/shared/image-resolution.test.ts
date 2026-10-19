import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getApiClient } from '../../src/api.js';
import { productionSubmitSchema, registerProductionTools, validateProductionSubmit } from '../../src/production-tools.js';

test('图片生产接口保留 2K 并接受 4K，视频拒绝图片分辨率', () => {
  const image = { submitId: randomUUID(), mediaType: 'image', prompt: '人物设定', model: 'jimeng-5.0-pro', references: [], ratio: '16:9', resolution: '4k' };
  for (const resolution of ['2k', '4k']) validateProductionSubmit(productionSubmitSchema.parse({ ...image, resolution }));
  assert.throws(() => validateProductionSubmit(productionSubmitSchema.parse({ ...image, resolution: '720p' })), /图片模型/);
  for (const resolution of ['2k', '4k']) assert.throws(() => validateProductionSubmit(productionSubmitSchema.parse({ ...image, mediaType: 'video', model: 'seedance-2.5', durationSeconds: 8, resolution })), /视频模型/);
});

test('生产图片处理器将 4K 原样传给底层，不降级为 2K', async () => {
  type Params = ReturnType<typeof productionSubmitSchema.parse>;
  let submit: ((params: Params) => Promise<unknown>) | undefined;
  registerProductionTools({ tool(name: string, _description: string, _schema: unknown, callback: (params: Params) => Promise<unknown>) {
    if (name === 'production_submit') submit = callback;
  } } as Parameters<typeof registerProductionTools>[0]);
  const client = getApiClient('test-token');
  const original = client.generateImage;
  let submitted: Parameters<typeof client.generateImage>[0] | undefined;
  client.generateImage = (async (params: Parameters<typeof client.generateImage>[0]) => { submitted = params; return 'test-history'; }) as typeof client.generateImage;
  try {
    await submit!(productionSubmitSchema.parse({ submitId: randomUUID(), mediaType: 'image', prompt: '人物设定', model: 'jimeng-5.0-pro', references: [], ratio: '16:9', resolution: '4k' }));
    assert.equal(submitted?.resolution, '4k');assert.equal(submitted?.aspectRatio, '16:9');assert.equal(submitted?.count, 1);
  } finally { client.generateImage = original; }
});
