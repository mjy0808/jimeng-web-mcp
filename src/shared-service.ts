import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { alive, atomicJson, serviceDirectory } from './shared/runtime.js';
import { ProductionQueue } from './shared/queue.js';
import { providerBackend } from './shared/provider.js';
import { startSharedHttp } from './shared/http.js';

/** Internal launcher. Consumers normally launch shared-client.js, which starts/reuses this process. */
async function main(): Promise<void> {
  const directory = serviceDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'server.lock');
  try {
    const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number };
    if (alive(owner.pid)) throw new Error('即梦共享服务已经运行。');
    await rm(lock);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(lock, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ pid: process.pid })); } finally { await file.close(); }
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const backend = providerBackend();
    const queue = new ProductionQueue(join(directory, 'tasks'), backend, Number(process.env.JIMENG_MAX_CONCURRENT ?? 3));
    await queue.load();
    const port = Number(process.env.JIMENG_SERVICE_PORT ?? 0);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('JIMENG_SERVICE_PORT 必须是 0–65535 的整数。');
    const http = await startSharedHttp(queue, backend, port);
    cleanup = async () => { await http.close(); };
    await atomicJson(join(directory, 'connection.json'), http.connection);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await http.close();
    };
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGINT', () => { void shutdown(); });
    http.server.once('close', () => {
      void (async () => { await rm(join(directory, 'connection.json'), { force: true }); await rm(lock, { force: true }); })();
    });
    queue.start();
    console.error(`即梦共享服务已就绪：${http.connection.url}（并发 ${queue.concurrency}，手动停止）`);
  } catch (error) {
    await cleanup?.();
    await rm(lock, { force: true });
    throw error;
  }
}
main().catch(error => { console.error(String((error as Error).message)); process.exitCode = 1; });
