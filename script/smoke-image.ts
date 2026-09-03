/** Opt-in live MCP test. Never loads the repository's tracked .env. */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { HttpClient } from '../src/api/HttpClient.js';
import { NewCreditService } from '../src/api/NewCreditService.js';

const [envFile, outputDirectory, mode] = process.argv.slice(2);
if (!envFile || !outputDirectory || !['--allow-generate-one', '--resume'].includes(mode)) {
  throw new Error('Usage: tsx script/smoke-image.ts <credentials.env> <output-directory> --allow-generate-one|--resume. A new generation spends image credits; count=1 is checked before submission.');
}
const token = dotenv.parse(fs.readFileSync(envFile)).JIMENG_API_TOKEN?.trim();
if (!token || !/^[a-zA-Z0-9_-]+$/.test(token)) throw new Error('Missing or invalid sessionid in the explicitly selected file');
process.env.JIMENG_API_TOKEN = token;
process.env.DEBUG = 'false';
const output = path.resolve(outputDirectory);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const stateFile = path.join(output, 'task.json');
let state: Record<string, any> = {};
if (fs.existsSync(stateFile)) {
  if (mode !== '--resume') throw new Error('Existing test attempt; use --resume to query it without generating again');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!state.historyId) throw new Error('No confirmed task ID. Inspect the previous attempt before making another request');
  if (state.phase === 'completed' && state.imageFile && fs.existsSync(state.imageFile)) {
    console.log(JSON.stringify({ event: 'already-completed', historyId: state.historyId, imageFile: state.imageFile }));
    process.exit(0);
  }
} else if (mode === '--resume') {
  throw new Error('No previous test task to resume');
}
const persist = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
const sanitize = (value: string) => value.split(token).join('[REDACTED]');
const report = (event: string, details: Record<string, unknown>) => console.log(JSON.stringify({ event, ...details }));

// Local test guard only: one initial submit; no retries, continuations, uploads,
// daily-credit claims, other origins, or unrelated history requests.
const request = HttpClient.prototype.request;
let generationRequests = mode === '--resume' ? 1 : 0;
HttpClient.prototype.request = async function (options) {
  const url = new URL(options.url, 'https://jimeng.jianying.com');
  if (url.origin !== 'https://jimeng.jianying.com') throw new Error('Test guard: unexpected origin');
  if (url.pathname === '/mweb/v1/aigc_draft/generate') {
    if (generationRequests || options.data?.action || options.data?.history_id) throw new Error('Test guard: extra generation blocked');
    if (options.data?.extend?.root_model !== 'high_aes_general_v50') throw new Error('Test guard: wrong model');
    const components = JSON.parse(options.data.draft_content).component_list;
    const genOption = components?.[0]?.abilities?.gen_option;
    if (components?.length !== 1 || genOption?.gen_count !== 1 || genOption?.generate_all !== false) {
      throw new Error('Test guard: request must explicitly generate one image');
    }
    generationRequests++;
    state.phase = 'submitting';
    state.submitId = options.data.submit_id;
    persist();
  } else if (url.pathname === '/mweb/v1/get_history_by_ids') {
    const ids = options.data?.history_ids;
    if (!state.historyId || ids?.length !== 1 || ids[0] !== state.historyId) throw new Error('Test guard: unrelated task query blocked');
  } else if (url.pathname !== '/commerce/v1/benefits/user_credit') {
    throw new Error('Test guard: endpoint not allowed');
  }
  return request.call(this, { ...options, timeout: 20000 }) as any;
};

const server = createServer();
const client = new Client({ name: 'guarded-image-live-smoke', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const credits = new NewCreditService(new HttpClient(token));
const call = async (name: string, args: Record<string, unknown>) => {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  const content = reply.content as Array<{ type: string; text?: string }>;
  const text = content.filter(item => item.type === 'text').map(item => item.text || '').join('\n');
  if (reply.isError) throw new Error(sanitize(text));
  return text;
};
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  if (!state.historyId) {
    const before = await credits.getCredit();
    state = { model: 'jimeng-5.0-lite', requestedCount: 1, prompt: '一只橘猫安静地坐在窗边，窗外是绿色花园，柔和晨光，温暖细腻的插画。', creditsBefore: before.totalCredit, startedAt: new Date().toISOString() };
    report('authenticated', { totalCredit: before.totalCredit, model: state.model });
    const id = (await call('image', { prompt: state.prompt, model: state.model, count: 1, aspectRatio: '1:1', resolution: '2k', async: true })).trim();
    if (!/^[0-9]+$/.test(id)) throw new Error('Unexpected submission response; no automatic retry');
    state.historyId = id;
    state.phase = 'submitted';
    persist();
    report('submitted', { historyId: id });
  }
  for (let poll = 0; poll < 30; poll++) {
    const text = await call('query', { historyId: state.historyId });
    const urls = text.match(/https:\/\/[^\s]+/g) || [];
    report('query', { historyId: state.historyId, status: text.match(/状态: (\w+)/)?.[1], returnedImages: urls.length });
    const firstUrl = urls[0];
    if (firstUrl) {
      state.returnedImages = urls.length;
      if (state.requestedCount === 1 && urls.length !== 1) {
        throw new Error(`Expected one image but received ${urls.length}. Inspect this task; do not automatically resubmit`);
      }
      const response = await fetch(firstUrl, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !type.startsWith('image/')) throw new Error('Image download did not return an image');
      const extension = type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : 'webp';
      const file = path.join(output, `result.${extension}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      state.phase = 'completed';
      state.returnedImages = urls.length;
      state.imageFile = file;
      state.creditsAfter = (await credits.getCredit()).totalCredit;
      state.creditDifference = state.creditsBefore - state.creditsAfter;
      persist();
      report('completed', { ...state, prompt: undefined });
      break;
    }
    if (poll === 29) throw new Error('Polling timed out. Resume this task; do not submit another');
    await delay(10000);
  }
} catch (error) {
  state.error = sanitize(error instanceof Error ? error.message : 'Unknown failure');
  persist();
  report('stopped', { historyId: state.historyId, phase: state.phase, error: state.error });
  process.exitCode = 1;
} finally {
  await client.close();
  await server.close();
  HttpClient.prototype.request = request;
  delete process.env.JIMENG_API_TOKEN;
}
