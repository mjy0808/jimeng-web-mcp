import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface Connection { url: string; token: string; instance: string; pid: number; status?: string }

/** Service data is independent of all consuming projects. */
export function serviceDirectory(): string {
  return resolve(process.env.JIMENG_SERVICE_DIR ?? join(dirname(process.argv[1]), '../.jimeng-service'));
}

/** Flush before rename: a submitting record must survive a process crash. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temp, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temp, { force: true }); }
}

export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function connection(directory: string, includeStopping = false): Promise<Connection | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) as Connection;
    const url = new URL(value.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp'
      || url.username || url.password || url.search || url.hash || typeof value.token !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.instance !== 'string' || !alive(value.pid)) return;
    const response = await fetch(new URL('/health', url), {
      headers: { authorization: `Bearer ${value.token}` }, redirect: 'error', signal: AbortSignal.timeout(1_000),
    });
    const health = await response.json() as { instance?: string; status?: string };
    if (response.ok && health.instance === value.instance && (health.status === 'ready' || (includeStopping && health.status === 'stopping'))) return { ...value, status: health.status };
  } catch { /* An absent or stale registry is not a usable service. */ }
  return;
}

/** Concurrent callers use an exclusive startup file; never kill an unrelated PID. */
export async function ensureService(directory = serviceDirectory()): Promise<Connection> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'startup.lock');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const existing = await connection(directory);
    if (existing) return existing;
    let owned = false;
    try {
      const file = await open(lock, 'wx', 0o600);
      owned = true;
      try { await file.writeFile(JSON.stringify({ pid: process.pid })); } finally { await file.close(); }
      const retry = await connection(directory);
      if (retry) return retry;
      // A previous service may be draining uploads after a manual stop. Wait
      // for its lock to become stale rather than launching another process.
      for (;;) {
        let running = false;
        try { running = alive((JSON.parse(await readFile(join(directory, 'server.lock'), 'utf8')) as { pid: number }).pid); } catch { /* no service lock */ }
        if (!running) break;
        const ready = await connection(directory);
        if (ready) return ready;
        if (Date.now() >= deadline) throw new Error('即梦共享服务尚未停止或暂不可用，请等待正在进行的请求结束。');
        await delay(100);
      }
      const log = await open(join(directory, 'service.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, [join(dirname(process.argv[1]), 'shared-service.js')], {
          detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, JIMENG_SERVICE_DIR: directory, DEBUG: 'false' },
        });
        await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
        child.unref();
        while (Date.now() < deadline) {
          const ready = await connection(directory);
          if (ready) return ready;
          await delay(100);
        }
        throw new Error(`即梦共享服务启动失败，请检查 ${join(directory, 'service.log')}`);
      } finally { await log.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number };
        if (!alive(owner.pid)) await rm(lock, { force: true });
      } catch {
        // Recover a crash between exclusive creation and writing the owner.
        // A live caller writes it immediately, before it starts the service.
        const info = await stat(lock).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 5_000) await rm(lock, { force: true });
      }
      await delay(100);
    } finally { if (owned) await rm(lock, { force: true }); }
  }
  throw new Error('即梦共享服务启动等待超时；请检查服务状态，不要重复提交生成任务。');
}

export function projectId(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error('必须设置 JIMENG_PROJECT_ID（1–128 位字母、数字、点、下划线、冒号或短横线）。');
  return value;
}

export async function connectService(value: Connection, project: string): Promise<Client> {
  const client = new Client({ name: projectId(project), version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(value.url), {
    requestInit: { headers: { authorization: `Bearer ${value.token}`, 'x-jimeng-project': project }, redirect: 'error' },
  });
  try { await client.connect(transport); return client; }
  catch (error) { await client.close().catch(() => undefined); throw error; }
}
