import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProductionQueue, type Args, type Backend, type Data } from '../../src/shared/queue.js';

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('等待测试条件超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function fixture(call: Backend['call']) {
  return { login: async () => 'private-test-token', call };
}
const args = (id = randomUUID()): Args => ({ submitId: id, mediaType: 'image', references: [], prompt: 'one image' });

test('simultaneous projects share generation capacity; duplicate IDs do not submit twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-queue-'));
  const submitted: string[] = [];
  const complete = new Set<string>();
  const backend = fixture(async (name, request) => {
    const id = (request.submitId ?? request.taskId) as string;
    if (name === 'task_query') return { taskId: id, mediaType: 'image', status: complete.has(id) ? 'completed' : 'processing', outputs: complete.has(id) ? [{ url: 'https://example.test/result', mediaType: 'image' }] : [] };
    submitted.push(id); return { taskId: id, mediaType: 'image', status: 'submitted' };
  });
  const queue = new ProductionQueue(root, backend, 1);
  try {
    await queue.load();
    const first = args(), second = args();
    await Promise.all([queue.submit('a', 'production_submit', first), queue.submit('a', 'production_submit', first), queue.submit('b', 'production_submit', second)]);
    await waitFor(() => submitted.length === 1);
    await queue.tick();
    assert.equal(submitted.length, 1, 'upstream processing retains its capacity slot');
    const pending = await queue.query('b', second.submitId as string, 'image');
    assert.equal(pending.serviceStatus, 'queued');
    await assert.rejects(queue.submit('b', 'production_submit', first), /其他项目/);
    await assert.rejects(queue.submit('a', 'production_submit', { ...first, prompt: 'different' }), /不同参数/);
    await assert.rejects(queue.query('b', first.submitId as string, 'image'), /其他项目/);
    complete.add(first.submitId as string);
    await queue.tick();
    await waitFor(() => submitted.length === 2);
    assert.equal((await queue.query('a', first.submitId as string, 'image')).status, 'completed');
  } finally { await queue.stop(); await rm(root, { recursive: true, force: true }); }
});

test('lost submission response and restart never replay generation; not_found retains capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-recovery-'));
  let submissions = 0;
  const backend = fixture(async (name, request) => {
    if (name !== 'task_query') { submissions++; throw new Error('response lost private-test-token'); }
    return { taskId: request.taskId, mediaType: 'image', status: 'not_found', outputs: [] };
  });
  const first = args();
  let queue = new ProductionQueue(root, backend, 1);
  try {
    await queue.load(); await queue.submit('a', 'production_submit', first);
    await waitFor(() => (queue.status('a').tasks as Data[])[0]?.status === 'unknown');
    await queue.stop();
    const durable = JSON.parse(await readFile(join(root, `${first.submitId}.json`), 'utf8'));
    assert(!JSON.stringify(durable).includes('private-test-token'));
    // Simulate process death while the durable state was still submitting.
    durable.phase = 'submitting'; await writeFile(join(root, `${first.submitId}.json`), JSON.stringify(durable));
    queue = new ProductionQueue(root, backend, 1);
    await queue.load(); await queue.submit('a', 'production_submit', first);
    await queue.submit('b', 'production_submit', args());
    await queue.tick();
    assert.equal(submissions, 1);
    assert.equal((queue.status('a').tasks as Data[])[0].status, 'unknown');
    assert.equal((queue.status('b').tasks as Data[])[0].status, 'queued');
  } finally { await queue.stop(); await rm(root, { recursive: true, force: true }); }
});

test('queued files cannot silently change; unavailable login leaves tasks safely queued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-material-'));
  let loggedIn = false, submissions = 0;
  const backend: Backend = {
    login: async () => { if (!loggedIn) throw new Error('login required'); return 'token'; },
    call: async (_name, request) => { submissions++; return { taskId: request.submitId, mediaType: 'image', status: 'submitted' }; },
  };
  const queue = new ProductionQueue(join(root, 'tasks'), backend);
  try {
    const path = join(root, 'reference.bin'); await writeFile(path, 'approved');
    const request = { ...args(), references: [path] };
    await queue.load(); await queue.submit('a', 'production_submit', request);
    await waitFor(() => Boolean((queue.status('a').tasks as Data[])[0]?.error));
    assert.equal((queue.status('a').tasks as Data[])[0].status, 'queued');
    await writeFile(path, 'changed'); loggedIn = true;
    await queue.tick();
    assert.equal(submissions, 0);
    assert.equal((await queue.query('a', request.submitId as string, 'image')).status, 'failed');
  } finally { await queue.stop(); await rm(root, { recursive: true, force: true }); }
});

test('a queued accepted task survives stopping and dispatches once after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jimeng-queued-restart-'));
  const request = args();
  let submissions = 0;
  const backend = fixture(async (name, input) => {
    if (name === 'task_query') return { taskId: input.taskId, mediaType: 'image', status: 'processing', outputs: [] };
    submissions++; return { taskId: input.submitId, mediaType: 'image', status: 'submitted' };
  });
  let queue = new ProductionQueue(root, backend);
  try {
    await queue.load(); await queue.submit('a', 'production_submit', request);
    await queue.stop();
    assert.equal(submissions, 0);
    queue = new ProductionQueue(root, backend);
    await queue.load(); await queue.tick();
    await waitFor(() => submissions === 1);
    await queue.submit('a', 'production_submit', request);
    assert.equal(submissions, 1);
  } finally { await queue.stop(); await rm(root, { recursive: true, force: true }); }
});
