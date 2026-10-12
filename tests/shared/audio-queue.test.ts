import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProductionQueue, type Backend } from '../../src/shared/queue.js';
test('queued audio inputs are checksum-bound before scheduling and never silently replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-audio-queue-'));
  let submitted = 0, login = false;
  const backend: Backend = { login: async () => { if (!login) throw new Error('not logged in'); return 'offline'; }, call: async (_name, args) => { submitted++; return { taskId: args.submitId, mediaType: 'video', status: 'submitted' }; } };
  const queue = new ProductionQueue(root, backend, 1);
  try {
    const path = join(root, 'voice.wav'); await writeFile(path, 'sample');
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    const args = { submitId: randomUUID(), mediaType: 'video', references: [], referenceAudios: [{ path, sha256: hash, durationMs: 2000 }], prompt: '@音频1' };
    await queue.load(); await queue.submit('film', 'production_submit', args);
    await writeFile(path, 'changed'); login = true; await queue.tick();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(submitted, 0);
    const bad = { ...args, submitId: randomUUID() };
    await assert.rejects(queue.submit('film', 'production_submit', bad), /审核|摘要|变化/);
  } finally { await queue.stop(); await rm(root, { recursive: true, force: true }); }
});
