import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NewJimengClient } from '../../src/api/NewJimengClient.js';
import { HttpClient } from '../../src/api/HttpClient.js';
import { ImageUploader } from '../../src/api/ImageUploader.js';
import { CacheManager } from '../../src/utils/cache-manager.js';
import { createServer } from '../../src/server.js';

// No real network, uploads, session cookies or image credits are used here.
describe('explicit image count', () => {
  const historyId = '123456789';
  let client: NewJimengClient;
  let requests: any[];
  let record: any;
  const originalToken = process.env.JIMENG_API_TOKEN;

  beforeEach(() => {
    CacheManager.clear();
    process.env.JIMENG_API_TOKEN = 'test_image_count';
    requests = [];
    record = { status: 20, total_image_count: 1, finished_image_count: 0, item_list: [] };
    jest.spyOn(HttpClient.prototype, 'request').mockImplementation(async (options) => {
      requests.push(options);
      if (options.url === '/mweb/v1/aigc_draft/generate') {
        return { data: { aigc_data: { history_record_id: historyId } } } as any;
      }
      if (options.url === '/mweb/v1/get_history_by_ids') {
        return { data: { [historyId]: record } } as any;
      }
      throw new Error(`Unexpected endpoint in offline test: ${options.url}`);
    });
    jest.spyOn(ImageUploader.prototype, 'uploadBatch').mockResolvedValue([
      { uri: 'test-reference', width: 1024, height: 1024, format: 'png' } as any,
    ]);
    client = new NewJimengClient('test_image_count');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    CacheManager.clear();
    CacheManager.stopPeriodicEviction();
    if (originalToken === undefined) delete process.env.JIMENG_API_TOKEN;
    else process.env.JIMENG_API_TOKEN = originalToken;
  });

  function submittedAbilities() {
    const body = requests.find(r => r.url === '/mweb/v1/aigc_draft/generate').data;
    return JSON.parse(body.draft_content).component_list[0].abilities;
  }

  it.each([false, true])('defaults to one on the wire, with reference=%s', async (withReference) => {
    await client.generateImage({
      prompt: '画九张猫', model: 'jimeng-5.0-lite', async: true,
      filePath: withReference ? ['/test/reference.png'] : undefined,
    });
    const abilities = submittedAbilities();
    expect(abilities.gen_option).toEqual(expect.objectContaining({ gen_count: 1, generate_all: false }));
    expect(abilities[withReference ? 'blend' : 'generate']).toBeDefined();
    expect(CacheManager.get(historyId)?.apiParams.count).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it.each([2, 4, 8])('sends count=%s separately from telemetry', async (count) => {
    await client.generateImage({ prompt: '猫', count, async: true });
    expect(submittedAbilities().gen_option.gen_count).toBe(count);
    expect(JSON.parse(requests[0].data.metrics_extra).generateCount).toBe(1);
  });

  it('infers series count from frames and carries it into the draft', async () => {
    await client.generateImage({ prompt: '故事', frames: ['开场', '结尾'], async: true });
    expect(submittedAbilities().gen_option.gen_count).toBe(2);
  });

  it.each([0, -1, 1.5, 9, 15, NaN, Infinity, null, '1'])('rejects invalid count=%s before upload/submission', async (count) => {
    await expect(client.generateImage({
      prompt: '猫', count: count as number, filePath: ['/test/reference.png'], async: true,
    })).rejects.toThrow(/count/);
    expect(ImageUploader.prototype.uploadBatch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it('rejects conflicting or excessive frames without truncating', async () => {
    await expect(client.generateImage({ prompt: '', count: 1, frames: ['一', '二'], async: true })).rejects.toThrow(/count/);
    await expect(client.generateImage({ prompt: '', frames: Array(9).fill('一'), async: true })).rejects.toThrow(/frames/);
    expect(requests).toHaveLength(0);
  });

  it.each([true, false])('does not continue an unexpected eight-image task in async=%s mode', async (asyncMode) => {
    record = { status: 42, total_image_count: 8, finished_image_count: 4, item_list: [] };
    if (asyncMode) {
      await client.generateImage({ prompt: '猫', async: true });
      const result = await client.getImageResult(historyId);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('不要自动重新提交');
      expect(result._debug.shouldTriggerContinuation).toBe(false);
    } else {
      await expect(client.generateImage({ prompt: '猫' })).rejects.toThrow(/出图数量不符/);
    }
    expect(requests.filter(r => r.url === '/mweb/v1/aigc_draft/generate')).toHaveLength(1);
  });

  it('reports four completed outputs as a mismatch, without hiding extra images', async () => {
    await client.generateImage({ prompt: '猫', async: true });
    record = {
      status: 50, total_image_count: 4, finished_image_count: 4,
      item_list: Array.from({ length: 4 }, (_, i) => ({ image_url: `https://example.test/${i}.png` })),
    };
    const result = await client.getImageResult(historyId);
    expect(result.status).toBe('failed');
    expect(result.imageUrls).toHaveLength(4);
    expect(result.error).toContain('请求 1 张');
  });

  it('returns one completed image in synchronous mode', async () => {
    record = { status: 50, total_image_count: 1, finished_image_count: 1, item_list: [{ image_url: 'https://example.test/one.png' }] };
    await expect(client.generateImage({ prompt: '猫' })).resolves.toEqual(['https://example.test/one.png']);
    expect(requests).toHaveLength(2);
  });

  it('retains continuation only for an explicitly requested matching batch', async () => {
    await client.generateImage({ prompt: '猫', count: 8, async: true });
    record = { status: 42, total_image_count: 8, finished_image_count: 4, item_list: [] };
    await client.getImageResult(historyId);
    await client.getImageResult(historyId);
    const submissions = requests.filter(r => r.url === '/mweb/v1/aigc_draft/generate');
    expect(submissions).toHaveLength(2);
    expect(submissions[1].data.action).toBe(2);
    expect(submissions[1].data.draft_content).toBe(submissions[0].data.draft_content);
  });

  it('carries MCP defaults, explicit counts and batch sizes into real request construction', async () => {
    const server = createServer();
    const mcp = new Client({ name: 'offline-count-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await mcp.connect(clientTransport);
      const tools = await mcp.listTools();
      const schema = tools.tools.find(t => t.name === 'image')!.inputSchema.properties!.count;
      expect(schema).toEqual(expect.objectContaining({ default: 1, minimum: 1, maximum: 8 }));
      for (const [name, args, expected] of [
        ['image', { prompt: '猫', async: true }, 1],
        ['image', { prompt: '猫', count: 3, async: true }, 3],
        ['image_batch', { prompts: ['正面', '侧面'], async: true }, 2],
      ] as const) {
        requests.length = 0;
        const response = await mcp.callTool({ name, arguments: args });
        expect(response.isError).not.toBe(true);
        expect(submittedAbilities().gen_option.gen_count).toBe(expected);
      }
      for (const args of [{ count: 9 }, { count: 0 }, { count: 1.5 }]) {
        requests.length = 0;
        await expect(mcp.callTool({ name: 'image', arguments: { prompt: '猫', ...args } })).rejects.toThrow(/Invalid arguments/);
        expect(requests).toHaveLength(0);
      }
      requests.length = 0;
      await expect(mcp.callTool({ name: 'image_batch', arguments: { prompts: Array(9).fill('猫') } })).rejects.toThrow(/Invalid arguments/);
      expect(requests).toHaveLength(0);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});
