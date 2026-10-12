import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connection, connectService, ensureService, projectId, serviceDirectory } from './shared/runtime.js';

/** A per-project stdio bridge. Its lifetime does not control the shared service lifetime. */
async function main(): Promise<void> {
  const command = process.argv[2];
  const directory = serviceDirectory();
  if (command === 'status' || command === 'stop') {
    const existing = await connection(directory, true);
    if (!existing) { console.log('即梦共享服务未运行。'); return; }
    if (command === 'stop') {
      const response = await fetch(new URL('/stop', existing.url), { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${existing.token}` } });
      if (!response.ok) throw new Error('停止共享服务失败。');
      console.log('即梦共享服务正在停止；已提交的生成任务仍可在下次启动后查询。');
    } else console.log(JSON.stringify({ url: existing.url, pid: existing.pid, status: existing.status === 'stopping' ? 'stopping' : 'running' }));
    return;
  }
  if (command && command !== 'login') throw new Error('支持的命令：login、status、stop；不传命令时为 MCP stdio 入口。');
  const project = projectId(process.env.JIMENG_PROJECT_ID ?? (command === 'login' ? 'login' : undefined));
  const upstream = await connectService(await ensureService(directory), project);
  if (command === 'login') {
    try {
      const reply = await upstream.callTool({ name: 'service_check_login', arguments: {} }, undefined, { timeout: 30_000 });
      if (reply.isError) throw new Error((Array.isArray(reply.content) ? reply.content as Array<{ type?: string; text?: string }> : []).filter(item => item.type === 'text').map(item => item.text ?? '').join(' '));
      console.log('共享即梦登录态已就绪，所有项目可以继续调用。');
    } finally { await upstream.close(); }
    return;
  }
  const server = new Server({ name: 'jimeng-shared-client', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, async request => {
    // No automatic replay on HTTP disconnect: callers query the original submitId.
    return upstream.callTool(request.params, undefined, { timeout: 120_000 });
  });
  server.onclose = () => { void upstream.close(); };
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => { void server.close(); });
}
main().catch(error => { console.error(String((error as Error).message)); process.exitCode = 1; });
