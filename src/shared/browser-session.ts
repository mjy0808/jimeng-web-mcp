import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Open/reuse the dedicated login window; read only Jimeng's current login cookie. */
export const JIMENG_ORIGIN = 'https://jimeng.jianying.com'
export const DEFAULT_JIMENG_CDP_URL = 'http://127.0.0.1:9225'
const LOGIN_HELP = '请在自动打开的专用 Chrome 窗口登录即梦；登录后在调用项目中恢复原任务，无需复制 Cookie。'

export class JimengLoginRequiredError extends Error {
  override name = 'JimengLoginRequiredError'
}

export function jimengCdpEndpoint(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.port === '0' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('即梦 CDP 地址必须是本机回环 HTTP 地址与端口，例如 http://127.0.0.1:9225')
  }
  return url
}

function pageSocket(value: unknown, endpoint: URL): string {
  if (typeof value !== 'string') throw new Error('即梦页面没有可用的调试连接')
  const url = new URL(value)
  if (url.protocol !== 'ws:' || url.hostname !== endpoint.hostname || url.port !== endpoint.port
    || url.username || url.password || url.search || url.hash || !/^\/devtools\/page\/[^/]+$/u.test(url.pathname)) {
    throw new Error('即梦页面调试连接不是同一个本机浏览器，已停止读取')
  }
  return url.href
}

interface BrowserCookie { name?: string; value?: string; domain?: string; expires?: number; partitionKey?: unknown }
interface BrowserTarget { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string }

function isJimengPage(target: BrowserTarget): boolean {
  if (target?.type !== 'page' || typeof target.url !== 'string') return false
  try { return new URL(target.url).origin === JIMENG_ORIGIN } catch { return false }
}

async function browserTargets(endpoint: URL, signal: AbortSignal): Promise<BrowserTarget[] | undefined> {
  try {
    const response = await fetch(new URL('json/list', endpoint), { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) })
    if (!response.ok) throw new Error()
    const targets: unknown = await response.json()
    if (!Array.isArray(targets)) throw new Error()
    return targets as BrowserTarget[]
  } catch (error) {
    signal.throwIfAborted()
    // Only a closed port means the browser is absent. Don't launch Chrome over
    // another service or an unresponsive existing browser.
    if ((error as { cause?: { code?: string } })?.cause?.code === 'ECONNREFUSED') return undefined
    throw new Error('无法连接即梦登录窗口；请检查本机 Chrome 调试连接或端口，原任务与提示词批准保持不变。')
  }
}

async function launchLoginBrowser(endpoint: URL, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (process.platform !== 'darwin' || endpoint.hostname !== '127.0.0.1') throw new Error('自动打开即梦仅支持 Mac 的 127.0.0.1；请先启动已配置的本机 Chrome 调试窗口。')
  const chrome = process.env.JIMENG_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = process.env.JIMENG_PROFILE_DIR ?? join(homedir(), 'Library/Application Support/AI Film Studio/Jimeng')
  if (!isAbsolute(chrome) || !isAbsolute(profile)) throw new Error('JIMENG_CHROME_PATH 和 JIMENG_PROFILE_DIR 必须使用完整路径。')
  await fs.access(chrome).catch(() => { throw new Error('未找到 Google Chrome，请先安装或配置 JIMENG_CHROME_PATH 后重试。') })
  await fs.mkdir(profile, { recursive: true, mode: 0o700 })
  await fs.chmod(profile, 0o700)
  signal.throwIfAborted()
  const browser = childProcess.spawn(chrome, [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${endpoint.port}`,
    '--no-first-run', '--no-default-browser-check', JIMENG_ORIGIN,
  ], { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    browser.once('spawn', () => resolve())
    browser.once('error', () => reject(new Error('无法打开即梦登录窗口，请检查 Chrome 安装。')))
  })
  browser.unref()
}

async function ensureLoginPage(endpoint: URL, signal: AbortSignal): Promise<BrowserTarget> {
  let targets = await browserTargets(endpoint, signal)
  if (targets === undefined) {
    await launchLoginBrowser(endpoint, signal)
    for (let attempt = 0; attempt < 30; attempt++) {
      targets = await browserTargets(endpoint, signal)
      if (targets !== undefined) break
      await delay(250, undefined, { signal })
    }
    if (targets === undefined) throw new Error('独立即梦 Chrome 已尝试启动，但调试端口未就绪；请检查该专用窗口是否正在使用其他端口，不必退出日常 Chrome。')
  }
  const existing = targets.find(isJimengPage)
  if (existing) return existing
  // A user may close only the Jimeng tab. Open that site, without navigating or
  // closing any other tabs. A new tab is not a new generation task.
  try {
    const response = await fetch(new URL(`json/new?${encodeURIComponent(JIMENG_ORIGIN)}`, endpoint), { method: 'PUT', redirect: 'error', signal })
    if (!response.ok) throw new Error()
    const page = await response.json() as BrowserTarget
    if (!isJimengPage(page)) throw new Error()
    pageSocket(page.webSocketDebuggerUrl, endpoint)
    return page
  } catch {
    signal.throwIfAborted()
    throw new Error('无法自动打开即梦页面，请在独立 Chrome 窗口打开 https://jimeng.jianying.com 后继续。')
  }
}

async function activateLoginPage(endpoint: URL, page: BrowserTarget, signal: AbortSignal): Promise<void> {
  if (!page.id) return
  await fetch(new URL(`json/activate/${encodeURIComponent(page.id)}`, endpoint), {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
  }).catch(() => undefined)
}

/** Cookie values are never included in errors, returned metadata or logs. */
function sessionCookie(cookies: BrowserCookie[]): string {
  const values = new Set(cookies.filter(cookie => {
    const domain = cookie.domain?.replace(/^\./u, '')
    return cookie.name === 'sessionid' && cookie.partitionKey === undefined
      && (domain === 'jimeng.jianying.com' || domain === 'jianying.com')
      && (cookie.expires === undefined || cookie.expires === -1 || cookie.expires > Date.now() / 1000)
  }).map(cookie => cookie.value))
  if (values.size === 0) throw new JimengLoginRequiredError(`即梦需要登录：浏览器未登录或登录已过期。${LOGIN_HELP}`)
  if (values.size !== 1) throw new JimengLoginRequiredError(`即梦登录态冲突，请在专用窗口退出并重新登录。${LOGIN_HELP}`)
  const token = [...values][0]
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{10,1024}$/u.test(token)) throw new JimengLoginRequiredError(`即梦登录态无效，需要重新登录。${LOGIN_HELP}`)
  return token
}

function readCookie(socketUrl: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl)
    let done = false
    const finish = (error?: Error, token?: string) => {
      if (done) return
      done = true
      signal.removeEventListener('abort', aborted)
      socket.close()
      if (error) reject(error)
      else resolve(token!)
    }
    const aborted = () => finish(new Error(`读取即梦登录态已取消或超时。${LOGIN_HELP}`))
    signal.addEventListener('abort', aborted, { once: true })
    socket.addEventListener('open', () => {
      if (!done) socket.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [`${JIMENG_ORIGIN}/`] } }))
    })
    socket.addEventListener('error', () => finish(new Error(`即梦浏览器连接失败。${LOGIN_HELP}`)))
    socket.addEventListener('close', () => finish(new Error(`即梦浏览器连接已关闭。${LOGIN_HELP}`)))
    socket.addEventListener('message', event => {
      if (done) return
      try {
        if (typeof event.data !== 'string' || event.data.length > 1_000_000) throw new Error()
        const message = JSON.parse(event.data) as { id?: number; error?: unknown; result?: { cookies?: BrowserCookie[] } }
        if (message.id !== 1) return
        if (message.error || !Array.isArray(message.result?.cookies)) throw new Error()
        const cookies = message.result.cookies
        if (!cookies.every(cookie => typeof cookie === 'object' && cookie !== null)) throw new Error()
        try { finish(undefined, sessionCookie(cookies)) } catch (error) { finish(error as Error) }
      } catch { finish(new Error('即梦浏览器返回无效的 Cookie 响应；已停止，不使用旧凭据。')) }
    })
    if (signal.aborted) aborted()
  })
}

export async function readJimengBrowserSession(endpointValue: string, signal?: AbortSignal): Promise<string> {
  const endpoint = jimengCdpEndpoint(endpointValue)
  const timeout = AbortSignal.timeout(15_000)
  const bounded = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  bounded.throwIfAborted()
  const page = await ensureLoginPage(endpoint, bounded)
  try { return await readCookie(pageSocket(page.webSocketDebuggerUrl, endpoint), bounded) }
  catch (error) {
    if (error instanceof JimengLoginRequiredError) await activateLoginPage(endpoint, page, bounded)
    throw error
  }
}
