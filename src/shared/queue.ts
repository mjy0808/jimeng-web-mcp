import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './runtime.js';

export type Args = Record<string, unknown>;
export type Data = Record<string, unknown>;
export type Phase = 'queued' | 'submitting' | 'submitted' | 'unknown' | 'rejected' | 'completed' | 'failed';
export interface Task {
  version: 1; id: string; project: string; tool: string; args: Args; fingerprint: string;
  mediaType: 'image' | 'video'; phase: Phase; createdAt: number; result?: Data; error?: string;
  files: Record<string, string>;
}
export interface Backend {
  login(): Promise<string>;
  call(name: string, args: Args, token: string): Promise<Data>;
}
const idSchema = z.string().uuid();
const taskSchema = z.object({
  version: z.literal(1), id: idSchema, project: z.string().min(1), tool: z.string().min(1),
  args: z.record(z.unknown()), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.enum(['image', 'video']), phase: z.enum(['queued', 'submitting', 'submitted', 'unknown', 'rejected', 'completed', 'failed']),
  createdAt: z.number().int().nonnegative(), result: z.record(z.unknown()).optional(), error: z.string().optional(),
  files: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
});
const active = (task: Task) => ['submitting', 'submitted', 'unknown'].includes(task.phase);
const terminal = (task: Task) => ['rejected', 'completed', 'failed'].includes(task.phase);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'object' && item !== null && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

async function fileHash(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('共享服务的参考素材必须使用本机绝对路径。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function snapshot(args: Args): Promise<Record<string, string>> {
  const paths = new Set<string>(Array.isArray(args.references) ? args.references as string[] : []);
  for (const key of ['firstFrameImage', 'sourceVideo']) if (typeof args[key] === 'string') paths.add(args[key] as string);
  const video = args.referenceVideo as { path?: string } | undefined;
  if (video?.path) paths.add(video.path);
  const result: Record<string, string> = {};
  for (const path of paths) result[path] = await fileHash(path);
  return result;
}

/** One persistent account queue. Uncertain submissions are queried, never replayed. */
export class ProductionQueue {
  private tasks = new Map<string, Task>();
  private serial: Promise<unknown> = Promise.resolve();
  private jobs = new Set<Promise<void>>();
  private ticking = false;
  private running = true;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private directory: string, private backend: Backend, readonly concurrency = 3) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('JIMENG_MAX_CONCURRENT 必须是 1–8 的整数。');
  }
  private locked<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.catch(() => undefined);
    return next;
  }
  private save(task: Task) { return atomicJson(join(this.directory, `${task.id}.json`), task); }
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const parsed = taskSchema.safeParse(JSON.parse(await readFile(join(this.directory, name), 'utf8')));
      if (!parsed.success || name !== `${parsed.data.id}.json`) {
        throw new Error(`任务记录无效：${name}；已停止启动，避免重复提交。`);
      }
      const task: Task = parsed.data;
      if (task.phase === 'submitting') { task.phase = 'unknown'; await this.save(task); }
      this.tasks.set(task.id, task);
    }
  }
  start(interval = 10_000): void {
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, interval);
    void this.tick().catch(() => undefined);
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    await this.serial;
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 20));
    await Promise.allSettled([...this.jobs]);
  }
  async submit(project: string, tool: string, args: Args): Promise<Data> {
    const id = idSchema.parse(args.submitId);
    const fingerprint = digest({ tool, args });
    return this.locked(async () => {
      if (!this.running) throw new Error('共享服务正在停止，尚未接收任务。');
      const existing = this.tasks.get(id);
      if (existing) {
        if (existing.project !== project || existing.fingerprint !== fingerprint) throw new Error('submitId 已被其他项目或不同参数使用，禁止覆盖或重新提交。');
        return this.receipt(existing);
      }
      const files = await snapshot(args);
      if (typeof args.sourceVideo === 'string' && files[args.sourceVideo] !== args.sourceSha256) throw new Error('源视频与审核时的 SHA256 不匹配，未入队。');
      const video = args.referenceVideo as { path?: string; sha256?: string } | undefined;
      if (video?.path && files[video.path] !== video.sha256) throw new Error('参考视频与审核时的 SHA256 不匹配，未入队。');
      const task: Task = { version: 1, id, project, tool, args, fingerprint, files,
        mediaType: tool === 'production_submit' && args.mediaType === 'image' ? 'image' : 'video',
        phase: 'queued', createdAt: Date.now() };
      await this.save(task);
      this.tasks.set(id, task);
      // Dispatch is asynchronous; returning this receipt never depends on upstream latency.
      setImmediate(() => { void this.tick().catch(() => undefined); });
      return this.receipt(task);
    });
  }
  private receipt(task: Task): Data {
    return { taskId: task.id, mediaType: task.mediaType,
      status: task.phase === 'rejected' ? 'rejected' : 'submitted', serviceStatus: task.phase,
      ...(task.phase === 'rejected' ? { error: task.error } : {}) };
  }
  status(project: string): Data {
    const rows = [...this.tasks.values()].filter(task => task.project === project);
    return { projectId: project, maxConcurrent: this.concurrency,
      tasks: rows.map(task => ({ taskId: task.id, mediaType: task.mediaType, status: task.phase, ...(task.error ? { error: task.error } : {}) })) };
  }
  async query(project: string, id: string, mediaType: 'image' | 'video'): Promise<Data> {
    const task = this.tasks.get(id);
    if (task && (task.project !== project || task.mediaType !== mediaType)) throw new Error('任务属于其他项目或媒体类型不匹配。');
    if (!task) {
      // Existing callers may have generated this task before the shared service existed.
      // Unknown IDs are queried read-only, without reserving capacity or claiming ownership.
      const token = await this.backend.login();
      return this.backend.call('task_query', { taskId: id, mediaType }, token);
    }
    if (terminal(task)) return task.result ?? { taskId: id, mediaType, status: 'failed', outputs: [], error: task.error };
    const pending = [...this.tasks.values()].filter(item => item.phase === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    return { taskId: id, mediaType, status: 'processing', outputs: [], serviceStatus: task.phase,
      ...(task.phase === 'queued' ? { progress: { queuePosition: pending.indexOf(task) + 1, queueLength: pending.length } }
        : task.result?.progress ? { progress: task.result.progress } : {}),
      ...(task.error ? { error: task.error } : {}) };
  }
  async checkLogin(): Promise<Data> { await this.backend.login(); return { status: 'ready' }; }
  private job(run: () => Promise<void>): void {
    const promise = run().catch(() => undefined);
    this.jobs.add(promise);
    void promise.finally(() => this.jobs.delete(promise));
  }
  async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      // Refresh only previously submitted tasks, including uncertainty after a crash.
      for (const task of [...this.tasks.values()].filter(item => active(item) && item.phase !== 'submitting')) {
        if (!this.running) return;
        try {
          const token = await this.backend.login();
          const result = await this.backend.call('task_query', { taskId: task.id, mediaType: task.mediaType }, token);
          if (result.taskId !== task.id || result.mediaType !== task.mediaType) throw new Error('任务查询回执不匹配。');
          if (!['not_found', 'processing', 'completed', 'failed'].includes(String(result.status))) throw new Error('任务查询状态无效。');
          task.result = result;
          if (result.status === 'completed' || result.status === 'failed') task.phase = result.status;
          task.error = result.status === 'not_found' ? '原任务暂未找到；保留并发位置，只查询，不重新提交。' : undefined;
          await this.save(task);
        } catch (error) { task.error = String((error as Error).message).slice(0, 800); await this.save(task); }
      }
      while (this.running && [...this.tasks.values()].filter(active).length < this.concurrency) {
        const task = [...this.tasks.values()].filter(item => item.phase === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!task) break;
        let token: string;
        try {
          token = await this.backend.login();
        } catch (error) { task.error = String((error as Error).message).slice(0, 800); await this.save(task); break; }
        try {
          for (const [path, hash] of Object.entries(task.files)) if (await fileHash(path) !== hash) throw new Error('排队期间参考素材发生变化，已拒绝提交；请重新审核素材后创建新任务。');
        } catch (error) { task.phase = 'rejected'; task.error = String((error as Error).message).slice(0, 800); await this.save(task); continue; }
        if (!this.running) break;
        task.phase = 'submitting'; task.error = undefined;
        // Persist BEFORE the only generation call. A crash can never replay this task.
        await this.save(task);
        this.job(async () => {
          try {
            const result = await this.backend.call(task.tool, task.args, token);
            if (result.taskId !== task.id || result.mediaType !== task.mediaType || !['submitted', 'rejected'].includes(String(result.status))) throw new Error('提交回执不匹配，请查询原任务。');
            task.phase = result.status === 'rejected' ? 'rejected' : 'submitted';
            task.error = result.status === 'rejected' ? String(result.error ?? '即梦拒绝本次提交') : undefined;
          } catch (error) { task.phase = 'unknown'; task.error = String((error as Error).message).split(token).join('[redacted]').slice(0, 800); }
          await this.save(task);
        });
      }
    } finally { this.ticking = false; }
  }
}
