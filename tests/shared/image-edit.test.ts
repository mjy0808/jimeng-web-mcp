import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { imageEditDraft, imageEditSchema, submitImageEdit, validateImageEditFiles, type ImageEditParams } from '../../src/api/ImageEditService.js';
import { HttpClient } from '../../src/api/HttpClient.js';
import { ImageUploader } from '../../src/api/ImageUploader.js';
import { parseProductionTask } from '../../src/api/ProductionTasks.js';
import { registerProductionTools } from '../../src/production-tools.js';
import { startSharedHttp } from '../../src/shared/http.js';
import { ProductionQueue, type Backend } from '../../src/shared/queue.js';
import { connectService } from '../../src/shared/runtime.js';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function png(width = 4, height = 4, pixel: (index: number) => number[] = index => index < 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]) {
  const value = new PNG({ width, height });
  for (let index = 0; index < width * height; index++) value.data.set(pixel(index), index * 4);
  return PNG.sync.write(value);
}
async function fixture(root: string): Promise<ImageEditParams> {
  const source = png(4, 4, () => [20, 100, 180, 255]), mask = png();
  const sourceImage = join(root, 'source.png'), maskImage = join(root, 'mask.png');
  await writeFile(sourceImage, source); await writeFile(maskImage, mask);
  return { submitId: randomUUID(), sourceImage, maskImage, sourceSha256: hash(source), maskSha256: hash(mask), prompt: '把选中的区域改成红色衣服', strength: 0 };
}

test('native repaint draft binds source and mask, requests one image, and never uses blend or an invented model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-edit-draft-'));
  try {
    const p = await fixture(root);
    const request = imageEditDraft(p, { uri: 'original-uri' }, { uri: 'mask-uri' }, { width: 4, height: 4 });
    const draft = JSON.parse(request.draft_content), component = draft.component_list[0];
    assert.equal(request.submit_id, p.submitId); assert.deepEqual(request.extend, {});
    assert.equal(draft.main_component_id, component.id);
    assert.equal(component.type, 'image_base_component'); assert.equal(component.generate_type, 'painting');
    assert.equal(component.abilities.painting.origin_uri, 'original-uri');
    assert.equal(component.abilities.painting.mask_uri, 'mask-uri');
    assert.equal(component.abilities.painting.postedit_param.generate_type, 7);
    assert.equal(component.abilities.painting.core_param.prompt, p.prompt);
    assert.equal(component.abilities.painting.core_param.strength, 0, 'zero strength must not become 0.5');
    assert.equal(component.abilities.blend, undefined);
    assert.equal(component.abilities.painting.core_param.model, undefined);
    assert.equal(component.abilities.gen_option.gen_count, 1);
    assert.equal(component.abilities.gen_option.generate_all, false);
    assert.equal(component.abilities.gen_option.is_force_single, true);
    const withoutStrength = { ...p }; delete withoutStrength.strength;
    assert.equal(JSON.parse(imageEditDraft(withoutStrength, { uri: 'a' }, { uri: 'b' }, { width: 4, height: 4 }).draft_content).component_list[0].abilities.painting.core_param.strength, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid mask pixels, dimensions, empty/full masks and hashes fail before upload or generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-edit-invalid-'));
  try {
    const p = await fixture(root);
    assert.deepEqual(await validateImageEditFiles(p), { width: 4, height: 4 });
    await assert.rejects(validateImageEditFiles({ ...p, sourceSha256: '0'.repeat(64) }), /SHA256/);
    assert.equal(imageEditSchema.safeParse({ ...p, sourceImage: 'relative.png' }).success, false);
    assert.equal(imageEditSchema.safeParse({ ...p, prompt: '字'.repeat(801) }).success, false);
    assert.equal(imageEditSchema.safeParse({ ...p, prompt: '  ' }).success, false);
    const cases: Array<[Buffer, RegExp]> = [
      [png(3, 4), /尺寸/], [png(4, 4, () => [255, 255, 255, 255]), /覆盖整图/],
      [png(4, 4, () => [0, 0, 0, 255]), /蒙版为空/], [png(4, 4, () => [128, 128, 128, 255]), /保留区域/],
      [png(4, 4, () => [255, 0, 0, 255]), /灰度/], [png(4, 4, () => [0, 0, 0, 0]), /透明/],
    ];
    for (const [mask, error] of cases) {
      await writeFile(p.maskImage, mask);
      let uploads = 0, requests = 0;
      const uploader = { upload: async () => { uploads++; throw new Error('must not upload'); } } as unknown as ImageUploader;
      const http = { request: async () => { requests++; throw new Error('must not submit'); } } as unknown as HttpClient;
      await assert.rejects(submitImageEdit({ ...p, maskSha256: hash(mask) }, http, uploader), error);
      assert.equal(uploads, 0); assert.equal(requests, 0);
    }
    const feathered = png(4, 4, index => index < 2 ? [255, 255, 255, 255] : index < 4 ? [128, 128, 128, 255] : [0, 0, 0, 255]);
    await writeFile(p.maskImage, feathered);
    await validateImageEditFiles({ ...p, maskSha256: hash(feathered) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider uploads the reviewed pair once, returns a queryable image task, and does not retry a lost response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-edit-provider-'));
  try {
    const p = await fixture(root), uploads: string[] = [], requests: Array<Record<string, unknown>> = [];
    const uploader = { upload: async (path: string) => { uploads.push(path); return { uri: path === p.sourceImage ? 'source' : 'mask', width: 4, height: 4, format: 'png' }; } } as unknown as ImageUploader;
    const http = { generateRequestParams: () => ({ aid: 513695 }), request: async (request: Record<string, unknown>) => {
      requests.push(request); return { ret: '0', data: { aigc_data: { history_record_id: '1234' } } };
    } } as unknown as HttpClient;
    const receipt = await submitImageEdit(p, http, uploader);
    assert.deepEqual(receipt, { taskId: p.submitId, historyId: '1234', mediaType: 'image', status: 'submitted' });
    assert.deepEqual(uploads, [p.sourceImage, p.maskImage]);
    assert.equal(requests.length, 1); assert.equal(requests[0].url, '/mweb/v1/aigc_draft/generate');
    const params = requests[0].params as { babi_param: string };
    assert.equal(JSON.parse(decodeURIComponent(params.babi_param)).feature_key, 'to_image_inpaint');
    http.request = async () => { requests.push({}); throw new Error('response lost'); };
    const before = requests.length;
    await assert.rejects(submitImageEdit({ ...p, submitId: randomUUID() }, http, uploader), /response lost/);
    assert.equal(requests.length, before + 1);
    http.request = async () => ({ ret: '0', data: { aigc_data: { submit_id: randomUUID() } } });
    await assert.rejects(submitImageEdit({ ...p, submitId: randomUUID() }, http, uploader), /回执/);
    const invalidOutput = parseProductionTask(p.submitId, 'image', { status: 50, total_image_count: 4, item_list: [{ image_url: 'https://example.test/result' }] });
    assert.equal(invalidOutput.status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('image edit participates in shared account capacity, preserves image type after restart, and rejects changed masks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-edit-queue-'));
  const submitted: string[] = [];
  let completed = false;
  const backend: Backend = { login: async () => 'test-token', call: async (name, p) => {
    if (name === 'task_query') return { taskId: p.taskId, mediaType: 'image', status: completed ? 'completed' : 'processing', outputs: completed ? [{ mediaType: 'image', url: 'https://example.test/result' }] : [] };
    submitted.push(String(p.submitId)); return { taskId: p.submitId, mediaType: 'image', status: 'submitted' };
  } };
  let queue = new ProductionQueue(join(root, 'tasks'), backend, 1);
  try {
    await queue.load();
    const p = await fixture(root);
    const receipt = await queue.submit('a', 'production_image_edit', p);
    assert.equal(receipt.mediaType, 'image');
    for (let attempt = 0; !submitted.length && attempt < 300; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(submitted.length, 1);
    await queue.submit('a', 'production_image_edit', p);
    assert.equal(submitted.length, 1);
    await queue.stop();
    const durable = JSON.parse(await readFile(join(root, 'tasks', `${p.submitId}.json`), 'utf8'));
    assert.equal(durable.files[p.maskImage], p.maskSha256);
    queue = new ProductionQueue(join(root, 'tasks'), backend, 1); await queue.load();
    assert.equal((await queue.query('a', p.submitId, 'image')).mediaType, 'image');
    await assert.rejects(queue.query('b', p.submitId, 'image'), /其他项目/);
    const next = { ...p, submitId: randomUUID() }; await queue.submit('a', 'production_image_edit', next);
    const changed = png(4, 4, index => index > 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    await writeFile(p.maskImage, changed); completed = true;
    for (let attempt = 0; attempt < 300; attempt++) {
      await queue.tick();
      if ((await queue.query('a', next.submitId, 'image')).status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(submitted.length, 1, 'changed mask is rejected rather than uploaded');
    assert.equal((await queue.query('a', next.submitId, 'image')).status, 'failed');
  } finally { await queue.stop(); await rm(root, { recursive: true, force: true }); }
});

test('stdio and shared HTTP advertise native image editing; malformed masks never enter the queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-edit-http-'));
  const names: string[] = [];
  registerProductionTools({ tool(name: string) { names.push(name); } } as unknown as Parameters<typeof registerProductionTools>[0]);
  assert(names.includes('production_image_edit'));
  let backendCalls = 0;
  const backend: Backend = { login: async () => 'test-token', call: async (_name, args) => {
    backendCalls++; return { taskId: args.submitId ?? args.taskId, mediaType: 'image', status: 'submitted' };
  } };
  const queue = new ProductionQueue(join(root, 'tasks'), backend); await queue.load();
  const service = await startSharedHttp(queue, backend);
  const client = await connectService(service.connection, 'editor-project');
  try {
    const tools = await client.listTools(), tool = tools.tools.find(tool => tool.name === 'production_image_edit');
    assert(tool?.inputSchema.properties?.maskImage); assert(tool.inputSchema.properties.sourceSha256);
    const p = await fixture(root);
    const result = await client.callTool({ name: 'production_image_edit', arguments: { ...p, maskSha256: '0'.repeat(64) } });
    assert.equal(result.isError, true); assert.deepEqual(queue.status('editor-project').tasks, []); assert.equal(backendCalls, 0);
    const accepted = await client.callTool({ name: 'production_image_edit', arguments: p });
    assert.notEqual(accepted.isError, true);
    assert.equal((accepted.structuredContent as { taskId: string; mediaType: string }).taskId, p.submitId);
    assert.equal((accepted.structuredContent as { mediaType: string }).mediaType, 'image');
    await client.callTool({ name: 'production_image_edit', arguments: p });
    for (let attempt = 0; !backendCalls && attempt < 300; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    await queue.stop(); assert.equal(backendCalls, 1, 'repeated accepted UUID dispatches once through shared HTTP');
  } finally { await client.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
