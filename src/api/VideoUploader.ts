import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import axios from 'axios';
// @ts-ignore
import crc32 from 'crc32';
import { HttpClient } from './HttpClient.js';

export interface UploadedVideo { vid: string; width: number; height: number; durationMs: number; fps: number }

/** VOD multipart upload used by the Jimeng web uploader. No session cookie goes to storage. */
export class VideoUploader {
  constructor(private readonly http: HttpClient) {}

  async upload(path: string, expectedSha256: string): Promise<UploadedVideo> {
    if (!isAbsolute(path) || !['.mp4', '.mov'].includes(extname(path).toLowerCase())) throw new Error('编辑源视频必须是本地 MP4/MOV 文件');
    const info = await stat(path);
    if (!info.isFile() || info.size < 12 || info.size > 200 * 1024 * 1024) throw new Error('编辑源视频必须为 200 MB 以内的文件');
    const bytes = await readFile(path);
    if (bytes.length > 200 * 1024 * 1024 || bytes.subarray(4, 8).toString() !== 'ftyp'
      || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('编辑源视频与审核时的文件不一致');
    const auth = await this.http.request({ url: '/mweb/v1/get_upload_token', data: { scene: 1 } });
    const token = auth?.data;
    if (String(auth?.ret) !== '0' || !token?.access_key_id || !token.secret_access_key || !token.session_token || !token.space_name) throw new Error('无法取得视频上传凭证，请检查即梦登录');
    if (token.region && !['cn', 'cn-north-1'].includes(token.region)) throw new Error('当前视频上传地区不受支持');
    const vod = async (action: string, extra: Record<string, unknown> = {}, data?: Record<string, unknown>) => {
      const params = { Action: action, Version: '2020-11-19', SpaceName: token.space_name, ...extra };
      const headers = await this.http.generateAuthorizationAndHeader(token.access_key_id, token.secret_access_key,
        token.session_token, 'cn-north-1', 'vod', data ? 'POST' : 'GET', params, data);
      // Do not expose Axios errors: they can contain temporary signing credentials.
      try {
        const response = await axios({ url: 'https://vod.bytedanceapi.com/', method: data ? 'POST' : 'GET', params, data,
          headers, timeout: 60_000, maxRedirects: 0, family: 4 });
        if (response.data?.ResponseMetadata?.Error || !response.data?.Result) throw new Error('invalid response');
        return response.data.Result;
      } catch { throw new Error('视频上传服务请求失败（' + action + '），未提交生成'); }
    };
    const applied = await vod('ApplyUploadInner', { FileType: 'video', IsInner: 1, FileSize: bytes.length });
    const node = applied.InnerUploadAddress?.UploadNodes?.[0];
    const store = node?.StoreInfos?.[0];
    if (!node?.UploadHost || !store?.StoreUri || !store.Auth || !node.SessionKey) throw new Error('视频上传地址不完整');
    const host = new URL('https://' + node.UploadHost);
    const domains = ['bytedanceapi.com', 'bytecdn.cn', 'byteimg.com', 'volces.com', 'snssdk.com', 'douyinvod.com', 'bytedance.com', 'zijieapi.com'];
    if (host.username || host.password || host.port || host.pathname !== '/' || host.search || host.hash
      || !domains.some(d => host.hostname === d || host.hostname.endsWith('.' + d))) throw new Error('视频上传返回非可信存储地址');
    if (!/^[a-zA-Z0-9/_.-]+$/.test(store.StoreUri) || store.StoreUri.includes('..')) throw new Error('视频上传存储路径无效');
    const url = host.origin + '/upload/v1/' + store.StoreUri;
    const storage = async (params: Record<string, string | number>, data?: Buffer | string, checksum?: string) => {
      try {
        const response = await axios.post(url, data, { params, headers: { ...node.UploadHeader, Authorization: store.Auth,
          'Content-Type': 'application/octet-stream', ...(checksum ? { 'Content-CRC32': checksum } : {}) },
          timeout: 120_000, maxRedirects: 0, maxBodyLength: 200 * 1024 * 1024, family: 4 });
        if (response.data?.code !== 2000) throw new Error('invalid response');
        return response.data.data;
      } catch { throw new Error('视频文件上传失败（' + params.phase + '），未提交生成'); }
    };
    const uploadid = store.UploadID ?? (await storage({ uploadmode: 'part', phase: 'init' }))?.uploadid;
    if (typeof uploadid !== 'string' || !uploadid) throw new Error('视频上传会话无效');
    const checksums: string[] = [];
    const size = 5 * 1024 * 1024;
    for (let offset = 0; offset < bytes.length; offset += size) {
      const chunk = bytes.subarray(offset, offset + size);
      const checksum = crc32(chunk).toString(16).padStart(8, '0');
      checksums.push(checksum);
      await storage({ uploadid, part_number: checksums.length, phase: 'transfer' }, chunk, checksum);
    }
    await storage({ uploadmode: 'part', phase: 'finish', uploadid }, checksums.map((sum, i) => (i + 1) + ':' + sum).join(','));
    const committed = await vod('CommitUploadInner', {}, { SessionKey: node.SessionKey, Functions: [] });
    const result = committed.Results?.[0];
    const meta = result?.VideoMeta;
    if (!result?.Vid || !meta?.Width || !meta.Height || !(meta.Duration > 0)) throw new Error('视频上传后缺少可用媒体信息');
    return { vid: result.Vid, width: meta.Width, height: meta.Height, durationMs: Math.round(meta.Duration * 1000), fps: meta.Fps ?? meta.FPS ?? 24 };
  }
}
