import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
test('concurrent calling processes start one service; disconnect keeps it alive; manual stop permits restart', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jimeng-bootstrap-'));
  const entry = resolve('lib/shared-client.js');
  const baseEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JIMENG_SERVICE_DIR: directory, DEBUG: 'false' };
  const clients: Client[] = [];
  const connect = async (project: string) => {
    const client = new Client({ name: project, version: '1.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...baseEnv, JIMENG_PROJECT_ID: project }, stderr: 'ignore' }));
    const { tools } = await client.listTools();
    assert(tools.some(tool => tool.name === 'production_image_edit' && tool.inputSchema.properties?.maskImage), 'the compiled stdio bridge exposes native masked image editing');
    const submit = tools.find(tool => tool.name === 'production_submit')!;
    assert.match(JSON.stringify(submit.inputSchema.properties?.model), /seedance-2.0-fast-vip/);
    assert.match(JSON.stringify(submit.inputSchema.properties?.resolution), /4k/);
    return client;
  };
  try {
    const [a, b] = await Promise.all([connect('project-a'), connect('project-b')]);
    const first = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
    const [sa, sb] = await Promise.all([a.callTool({ name: 'service_status', arguments: {} }), b.callTool({ name: 'service_status', arguments: {} })]);
    assert.equal((sa.structuredContent as { projectId: string }).projectId, 'project-a');
    assert.equal((sb.structuredContent as { projectId: string }).projectId, 'project-b');
    await a.close(); await b.close();
    const status = await exec(process.execPath, [entry, 'status'], { env: baseEnv });
    assert.equal(JSON.parse(status.stdout).pid, first.pid, 'both projects reused a service that survives disconnected clients');
    await exec(process.execPath, [entry, 'stop'], { env: baseEnv });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const stopped = await exec(process.execPath, [entry, 'status'], { env: baseEnv });
      if (stopped.stdout.includes('未运行')) break;
      if (Date.now() > deadline) throw new Error('共享服务未停止');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await connect('project-c');
    const next = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
    assert.notEqual(next.instance, first.instance);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await exec(process.execPath, [entry, 'stop'], { env: baseEnv }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 100));
    await rm(directory, { recursive: true, force: true });
  }
});
