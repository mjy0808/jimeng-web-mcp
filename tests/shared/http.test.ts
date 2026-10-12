import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startSharedHttp } from '../../src/shared/http.js';
import { connectService } from '../../src/shared/runtime.js';
import { ProductionQueue, type Backend } from '../../src/shared/queue.js';

test('two HTTP clients share one service; auth, project ownership and production schemas are enforced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-http-'));
  const backend: Backend = { login: async () => 'test-token', call: async (_name, args) => ({ taskId: args.submitId ?? args.taskId, mediaType: 'image', status: 'processing', outputs: [] }) };
  const queue = new ProductionQueue(root, backend);
  await queue.load();
  const service = await startSharedHttp(queue, backend);
  const a = await connectService(service.connection, 'project-a');
  const b = await connectService(service.connection, 'project-b');
  try {
    const tools = await a.listTools();
    assert(tools.tools.some(tool => tool.name === 'production_submit'));
    assert(tools.tools.some(tool => tool.name === 'service_check_login'));
    assert(!tools.tools.some(tool => tool.name === 'image'), 'legacy generation cannot bypass queue');
    const request = { submitId: randomUUID(), mediaType: 'image', prompt: 'one', model: 'jimeng-5.0-lite', references: [], ratio: '1:1', resolution: '2k' };
    const [first, duplicate] = await Promise.all([a.callTool({ name: 'production_submit', arguments: request }), a.callTool({ name: 'production_submit', arguments: request })]);
    assert.deepEqual(first.structuredContent, duplicate.structuredContent);
    const other = await b.callTool({ name: 'task_query', arguments: { taskId: request.submitId, mediaType: 'image' } });
    assert.equal(other.isError, true);
    const invalid = await a.callTool({ name: 'production_submit', arguments: { ...request, submitId: 'invalid' } }, undefined, { timeout: 2_000 });
    assert.equal(invalid.isError, true);
    const unsupported = await a.callTool({ name: 'production_submit', arguments: { ...request, submitId: randomUUID(), resolution: '720p' } });
    assert.equal(unsupported.isError, true);
    const health = new URL('/health', service.connection.url);
    assert.equal((await fetch(health)).status, 403);
    assert.equal((await fetch(health, { headers: { authorization: `Bearer ${service.connection.token}`, origin: 'https://untrusted.test' } })).status, 403);
  } finally { await a.close(); await b.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
