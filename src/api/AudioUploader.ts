import { HttpClient } from './HttpClient.js';
import { VodMediaUploader } from './VodMediaUploader.js';
export interface UploadedAudio { vid: string; durationMs: number }
export class AudioUploader {
  constructor(private readonly http: HttpClient) {}
  async upload(path: string, sha256: string): Promise<UploadedAudio> {
    const result = await new VodMediaUploader(this.http).upload(path, sha256, 'audio');
    if (result.durationMs < 2000 || result.durationMs > 30000) throw new Error('音频参考须为 2–30 秒，未提交生成');
    return { vid: result.vid, durationMs: result.durationMs };
  }
}
