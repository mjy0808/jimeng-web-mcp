import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { readJimengBrowserSession, DEFAULT_JIMENG_CDP_URL } from './browser-session.js';
import type { Args, Backend, Data } from './queue.js';

/** Each provider call gets fresh credentials in an isolated process, never global token mutation. */
export function providerBackend(): Backend {
  let reading: Promise<string> | undefined;
  return {
    async login() {
      if (process.env.JIMENG_API_TOKEN) return process.env.JIMENG_API_TOKEN;
      if (!reading) reading = readJimengBrowserSession(process.env.JIMENG_CDP_URL ?? DEFAULT_JIMENG_CDP_URL)
        .finally(() => { reading = undefined; });
      return reading;
    },
    async call(name: string, args: Args, token: string): Promise<Data> {
      const client = new Client({ name: 'jimeng-shared-provider', version: '1.0.0' });
      const env: Record<string, string> = { JIMENG_API_TOKEN: token, DEBUG: 'false' };
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key]!;
      const entry = join(dirname(process.argv[1]), 'server.js');
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: dirname(entry), env, stderr: 'ignore' });
      try {
        await client.connect(transport);
        const reply = await client.callTool({ name, arguments: args }, undefined, {
          timeout: name === 'task_query' ? 30_000 : 600_000,
        });
        if (reply.isError) {
          const detail = (Array.isArray(reply.content) ? reply.content as Array<{ type?: string; text?: string }> : []).filter(item => item.type === 'text').map(item => item.text ?? '').join(' ');
          throw new Error(detail.split(token).join('[redacted]').slice(0, 800));
        }
        const result = reply.structuredContent;
        if (typeof result !== 'object' || result === null) throw new Error('本地 MCP 缺少结构化结果，请重新构建。');
        return JSON.parse(JSON.stringify(result).split(token).join('[redacted]')) as Data;
      } catch (error) { throw new Error(String((error as Error).message).split(token).join('[redacted]').slice(0, 800)); }
      finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
    },
  };
}
