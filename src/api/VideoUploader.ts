import { HttpClient } from './HttpClient.js';
import { VodMediaUploader } from './VodMediaUploader.js';
export interface UploadedVideo { vid: string; width: number; height: number; durationMs: number; fps: number }
export class VideoUploader {
  constructor(private readonly http: HttpClient) {}
  upload(path: string, sha256: string): Promise<UploadedVideo> { return new VodMediaUploader(this.http).upload(path, sha256, 'video'); }
}
