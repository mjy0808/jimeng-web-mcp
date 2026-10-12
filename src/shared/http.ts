import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerProductionTools, productionSubmitSchema, validateProductionSubmit } from '../production-tools.js';
import { projectId, type Connection } from './runtime.js';
import type { Args, Backend, Data } from './queue.js';
import { ProductionQueue } from './queue.js';

interface Definition { name: string; description: string; schema: z.ZodRawShape }
/** Reuse provider schemas; never expose the legacy tools that can bypass the account queue. */
function definitions(): Definition[] {
  const result: Definition[] = [];
  registerProductionTools({ tool(name: string, description: string, schema: z.ZodRawShape) {
    result.push({ name, description, schema });
  } } as unknown as McpServer);
  return result;
}
function response(value: Data) {
  return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
function authenticated(value: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(value ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface SharedHttpService { server: HttpServer; connection: Connection; close(): Promise<void> }

/** Loopback-only, stateless Streamable HTTP; one durable queue serves all client connections. */
export async function startSharedHttp(queue: ProductionQueue, backend: Backend, port = 0): Promise<SharedHttpService> {
  const token = randomBytes(32).toString('hex');
  const instance = randomUUID();
  const catalog = definitions();
  let stopping = false;
  let close: () => Promise<void>;
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
      if (req.headers.host !== expectedHost || req.headers.origin !== undefined
        || !authenticated(req.headers.authorization, token)) { res.writeHead(403).end(); return; }
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ instance, status: stopping ? 'stopping' : 'ready' })); return;
      }
      if (req.url === '/stop' && req.method === 'POST') {
        res.writeHead(202).end();
        setImmediate(() => { void close(); }); return;
      }
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      if (stopping) { res.writeHead(503).end(); return; }
      const project = projectId(typeof req.headers['x-jimeng-project'] === 'string' ? req.headers['x-jimeng-project'] : undefined);
      const mcp = new McpServer({ name: 'jimeng-shared-service', version: '1.0.0' });
      for (const definition of catalog) {
        mcp.tool(definition.name, definition.description, definition.schema, async (args: Args) => {
          try {
            if (definition.name === 'task_query') return response(await queue.query(project, args.taskId as string, args.mediaType as 'image' | 'video'));
            if (definition.name === 'production_submit') validateProductionSubmit(productionSubmitSchema.parse(args));
            if (definition.name === 'production_edit' && (Number(args.startMs) >= Number(args.endMs) || Number(args.endMs) > Number(args.sourceDurationMs))) throw new Error('编辑时间范围必须在源视频内。');
            if (definition.name === 'production_promote_check') {
              // Validate ownership of the source if known; an old task is queried read-only.
              await queue.query(project, args.draftTaskId as string, 'video');
              return response(await backend.call(definition.name, args, await backend.login()));
            }
            if (definition.name === 'production_promote') {
              if (args.submitId === args.draftTaskId) throw new Error('升清任务编号必须区别于原始样片任务。');
              await queue.query(project, args.draftTaskId as string, 'video');
            }
            return response(await queue.submit(project, definition.name, args));
          } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String((error as Error).message).split(token).join('[redacted]').slice(0, 800) }] }; }
        });
      }
      mcp.tool('service_check_login', '检查共享即梦登录态；必要时打开专用 Chrome，不提交生成任务。', {}, async () => {
        try { return response(await queue.checkLogin()); }
        catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String((error as Error).message).slice(0, 800) }] }; }
      });
      mcp.tool('service_status', '查询本项目的共享服务队列与任务状态。', {}, async () => response(queue.status(project)));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void mcp.close().catch(() => undefined); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(400).end(JSON.stringify({ error: '无效的共享服务请求。' }));
      else res.end();
    }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('共享服务监听失败。');
  let closing: Promise<void> | undefined;
  close = () => closing ??= (async () => {
    stopping = true;
    await queue.stop();
    await new Promise<void>(accept => server.close(() => accept()));
  })();
  return { server, connection: { url: `http://127.0.0.1:${address.port}/mcp`, token, instance, pid: process.pid }, close };
}
