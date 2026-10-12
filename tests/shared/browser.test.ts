import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { DEFAULT_JIMENG_CDP_URL, JIMENG_ORIGIN, JimengLoginRequiredError, jimengCdpEndpoint, readJimengBrowserSession } from '../../src/shared/browser-session.js'

const TOKEN_A = 'test_session_a_012345'
const TOKEN_B = 'test_session_b_012345'

function browser(t: TestContext) {
  const state = {
    cookies: [{ name: 'sessionid', value: TOKEN_A, domain: '.jianying.com', expires: -1 }] as Array<Record<string, unknown>>,
    pageUrl: `${JIMENG_ORIGIN}/ai-tool/image/generate`,
    socketUrl: 'ws://127.0.0.1:9225/devtools/page/jimeng',
    response: 'cookies', closed: 0, reads: 0, online: true, opened: 0, activated: 0,
  }
  const fetched = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.redirect, 'error')
    if (!state.online) throw new Error('browser closed', { cause: { code: 'ECONNREFUSED' } })
    if (String(url) === `${DEFAULT_JIMENG_CDP_URL}/json/activate/jimeng`) {
      state.activated++
      return new Response('Target activated')
    }
    if (String(url).startsWith(`${DEFAULT_JIMENG_CDP_URL}/json/new?`)) {
      assert.equal(decodeURIComponent(new URL(String(url)).search.slice(1)), JIMENG_ORIGIN)
      assert.equal(options?.method, 'PUT')
      state.opened++
      state.pageUrl = JIMENG_ORIGIN
      return new Response(JSON.stringify({ id: 'jimeng', type: 'page', url: state.pageUrl, webSocketDebuggerUrl: state.socketUrl }))
    }
    assert.equal(String(url), `${DEFAULT_JIMENG_CDP_URL}/json/list`)
    return new Response(JSON.stringify([
      { type: 'page', url: 'https://unrelated.example/', webSocketDebuggerUrl: 'ws://unrelated.example' },
      { id: 'jimeng', type: 'page', url: state.pageUrl, webSocketDebuggerUrl: state.socketUrl },
    ]), { headers: { 'content-type': 'application/json' } })
  })
  class FakeSocket extends EventTarget {
    constructor(url: string) {
      super()
      assert.equal(url, state.socketUrl)
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(data: string) {
      assert.deepEqual(JSON.parse(data), { id: 1, method: 'Network.getCookies', params: { urls: [`${JIMENG_ORIGIN}/`] } })
      state.reads++
      if (state.response === 'never') return
      const message = state.response === 'cookies' ? { id: 1, result: { cookies: state.cookies } }
        : { id: 1, error: { message: TOKEN_A } }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })))
    }
    close() { state.closed++ }
  }
  t.mock.method(globalThis, 'WebSocket', function (url: string | URL) { return new FakeSocket(String(url)) } as unknown as typeof WebSocket)
  return { state, fetched }
}

test('reads the current Jimeng cookie each time, including HttpOnly cookies, without touching other sites', async t => {
  const { state, fetched } = browser(t)
  state.cookies.push({ name: 'other-cookie', value: 'irrelevant', domain: '.jianying.com' })
  state.cookies[0]!.httpOnly = true
  assert.equal(await readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), TOKEN_A)
  state.cookies[0]!.value = TOKEN_B
  assert.equal(await readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), TOKEN_B)
  assert.equal(fetched.mock.callCount(), 2)
  assert.equal(state.reads, 2)
  assert.equal(state.closed, 2)
})

test('rejects missing, expired, ambiguous, invalid or wrongly scoped cookies without an old-token fallback', async t => {
  const { state } = browser(t)
  for (const cookies of [
    [],
    [{ name: 'sessionid', value: TOKEN_A, domain: '.jianying.com', expires: 1 }],
    [{ name: 'sessionid', value: TOKEN_A, domain: '.unrelated.example', expires: -1 }],
    [{ name: 'sessionid', value: TOKEN_A, domain: '.jianying.com', partitionKey: { topLevelSite: 'https://unrelated.example' } }],
    [{ name: 'sessionid', value: `${TOKEN_A};`, domain: '.jianying.com', expires: -1 }],
    [{ name: 'sessionid', value: TOKEN_A, domain: '.jianying.com' }, { name: 'sessionid', value: TOKEN_B, domain: 'jimeng.jianying.com' }],
  ]) {
    state.cookies = cookies
    await assert.rejects(readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), error => {
      assert(error instanceof Error)
      assert.doesNotMatch(error.message, new RegExp(`${TOKEN_A}|${TOKEN_B}`))
      return true
    })
  }
  state.response = 'error'
  await assert.rejects(readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), /无效的 Cookie 响应/)
})

test('only connects to the configured local browser and the real Jimeng page', async t => {
  const { state, fetched } = browser(t)
  for (const value of ['https://127.0.0.1:9225', 'http://192.168.1.2:9225', 'http://localhost:9225', 'http://127.0.0.1', 'http://127.0.0.1:9225/?token=secret', 'http://user:password@127.0.0.1:9225']) {
    assert.throws(() => jimengCdpEndpoint(value), /本机回环/)
  }
  assert.equal(fetched.mock.callCount(), 0)
  for (const socket of ['ws://evil.example:9225/devtools/page/id', 'ws://127.0.0.1:9333/devtools/page/id', 'ws://127.0.0.1:9225/devtools/browser/id']) {
    state.socketUrl = socket
    await assert.rejects(readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), /不是同一个本机浏览器/)
  }
  assert.equal(state.reads, 0)
})

test('opens only a missing Jimeng tab, focuses it when login is required, then reuses it after login', async t => {
  const { state } = browser(t)
  state.pageUrl = 'https://jiment.jianying.com/'
  state.cookies = []
  await assert.rejects(readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), error => error instanceof JimengLoginRequiredError && /即梦需要登录/.test(error.message))
  assert.equal(state.opened, 1)
  assert.equal(state.activated, 1)
  state.cookies = [{ name: 'sessionid', value: TOKEN_A, domain: '.jianying.com' }]
  assert.equal(await readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), TOKEN_A)
  assert.equal(state.opened, 1, 'reuse the tab instead of repeatedly opening Jimeng')
  assert.equal(state.activated, 1, 'authenticated queries must not steal focus')
})

test('uses configured Chrome and dedicated profile paths when launching the login browser', async t => {
  const { state } = browser(t)
  state.online = false
  const keys = ['JIMENG_CHROME_PATH', 'JIMENG_PROFILE_DIR'] as const
  for (const key of keys) {
    const previous = process.env[key]
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
  const chrome = join(tmpdir(), 'film-browser', 'Chrome')
  const profile = join(tmpdir(), 'film-browser', 'Jimeng Profile')
  process.env.JIMENG_CHROME_PATH = chrome
  process.env.JIMENG_PROFILE_DIR = 'relative-profile'
  await assert.rejects(readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), /必须使用完整路径/u)
  process.env.JIMENG_PROFILE_DIR = profile
  t.mock.method(fs, 'access', async (path: unknown) => { assert.equal(path, chrome) })
  t.mock.method(fs, 'mkdir', async (path: unknown) => { assert.equal(path, profile); return undefined })
  t.mock.method(fs, 'chmod', async (path: unknown) => { assert.equal(path, profile) })
  t.mock.method(childProcess, 'spawn', ((command: string, args: string[]) => {
    assert.equal(command, chrome)
    assert(args.includes(`--user-data-dir=${profile}`))
    const child = new EventEmitter() as childProcess.ChildProcess
    child.unref = () => undefined
    queueMicrotask(() => { state.online = true; child.emit('spawn') })
    return child
  }) as typeof childProcess.spawn)
  assert.equal(await readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), TOKEN_A)
})

test('automatically launches the dedicated Chrome after it closes, preserving its profile and sandbox', async t => {
  const { state } = browser(t)
  state.online = false
  t.mock.method(fs, 'access', async () => {})
  t.mock.method(fs, 'mkdir', async () => undefined)
  const chmod = t.mock.method(fs, 'chmod', async () => {})
  const starts: string[][] = []
  const spawn = t.mock.method(childProcess, 'spawn', ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    assert.deepEqual(options, { detached: true, stdio: 'ignore' })
    starts.push(args)
    const child = new EventEmitter() as childProcess.ChildProcess
    child.unref = () => undefined
    queueMicrotask(() => { state.online = true; child.emit('spawn') })
    return child
  }) as typeof childProcess.spawn)
  assert.equal(await readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), TOKEN_A)
  assert.equal(await readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), TOKEN_A)
  assert.equal(spawn.mock.callCount(), 1)
  state.online = false
  assert.equal(await readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), TOKEN_A)
  assert.equal(spawn.mock.callCount(), 2)
  assert.deepEqual(starts[0], starts[1])
  assert(starts[0]!.some(arg => arg.startsWith('--user-data-dir=') && arg.endsWith('/Library/Application Support/AI Film Studio/Jimeng')))
  assert(starts[0]!.includes('--remote-debugging-address=127.0.0.1'))
  assert(starts[0]!.includes('--remote-debugging-port=9225'))
  assert(!starts[0]!.includes('--no-sandbox'))
  assert.equal(chmod.mock.calls[0]!.arguments[1], 0o700)
})

test('does not spawn over an unresponsive browser or consume a cancelled request', async t => {
  const { state } = browser(t)
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('must not launch') })
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }))
  await assert.rejects(readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL), /无法连接即梦登录窗口/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL, controller.signal))
  assert.equal(spawn.mock.callCount(), 0)
  assert.equal(state.reads, 0)
})

test('closing or cancelling a browser read returns without retaining its connection', async t => {
  const { state } = browser(t)
  state.response = 'never'
  const controller = new AbortController()
  const pending = readJimengBrowserSession(DEFAULT_JIMENG_CDP_URL, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, /取消或超时/)
  assert.equal(state.closed, 1)
})
