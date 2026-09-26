import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { HttpClient } from '../../src/api/HttpClient.js';
import { VideoUploader } from '../../src/api/VideoUploader.js';
import { ImageUploader } from '../../src/api/ImageUploader.js';
import { submitVideoEdit, unifiedVideoEditInput, videoEditDraft, type VideoEditParams } from '../../src/api/VideoEditService.js';

const video = { vid: 'source-video', width: 1280, height: 720, durationMs: 10000, fps: 24 };
const params: VideoEditParams = { submitId: randomUUID(), sourceVideo: '/project/source.mp4', sourceSha256: 'a'.repeat(64),
  sourceDurationMs: 10000, startMs: 3000, endMs: 7000, prompt: '编辑@视频1的3–7秒，按@图片1保留人物，固定机位。', references: ['/person.png'], resolution: '720p' };
afterEach(() => jest.restoreAllMocks());

describe('source video editing protocol', () => {
  it('binds exact source and timestamp range without first/last frames or ordinary generation', () => {
    const input = unifiedVideoEditInput(params, video, [{ uri: 'person' }]);
    expect(input.material_list.map(m => m.material_type)).toEqual(['video', 'image']);
    expect(input.edit_input).toEqual({ enable: true, edit_from_material_idx: 0, start_timestamp_ms: 3000, end_timestamp_ms: 7000 });
    expect(input.meta_list.map(m => m.meta_type === 'text' ? m.text : m.meta_type === 'video' ? '@视频1' : '@图片' + m.material_ref.material_idx).join('')).toBe(params.prompt);
    const body = videoEditDraft(params, video, [{ uri: 'person' }], { benefit_type: 'seedance_25_720p_output', amount: 4 });
    const p = JSON.parse(body.draft_content).component_list[0].abilities.gen_video.text_to_video_params;
    expect(p.video_aspect_ratio).toBe('adaptive');
    expect(p.video_gen_inputs[0].duration_ms).toBe(-1);
    expect(p.video_gen_inputs[0].first_frame_image).toBeUndefined();
    expect(body.submit_id).toBe(params.submitId);
    expect(body.metrics_extra).toContain('video_edit');
    const maxPrompt = '@视频1 @图片1' + '字'.repeat(16000 - '@视频1 @图片1'.length);
    expect(unifiedVideoEditInput({ ...params, prompt: maxPrompt }, video, [{ uri: 'person' }]).meta_list.at(-1)?.text).toContain('字');
  });

  it.each([{ startMs: -1 }, { endMs: 11000 }, { startMs: 7000 }, { startMs: 1.5 }, { prompt: '@视频2 @图片1' },
    { prompt: '@视频1' }, { prompt: '@音频1 @图片1' }, { prompt: 'x'.repeat(16001) }])('rejects invalid input before any HTTP call: %j', async patch => {
    const http = new HttpClient('offline-only');
    const request = jest.spyOn(http, 'request');
    await expect(submitVideoEdit({ ...params, ...patch }, http)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('checks current edit capability, uploads source, uses input-video commerce and never retries an uncertain submission', async () => {
    const http = new HttpClient('offline-only');
    const request = jest.spyOn(http, 'request').mockImplementation(async input => {
      if (input.url.includes('get_common_config')) return { ret: '0', data: { model_list: [{
        model_req_key: 'dreamina_seedance_45_pro', model_status: 0,
        options: [{ key: 'edit_config', edit_config_val: { duration_mode: 'adaptive', video_aspect_ratio_mode: 'adaptive',
          default_model_req_key: 'dreamina_seedance_45_pro', edit_min_video_duration: 4, edit_max_video_duration: 30 } }],
        commercial_config: { resolution_price_configs: [{ resolution: '720p', price: { benefit_type: 'seedance_25_720p_output' } }] },
      }] } } as any;
      throw new Error('uncertain submission');
    });
    const upload = jest.spyOn(VideoUploader.prototype, 'upload').mockResolvedValue(video);
    jest.spyOn(ImageUploader.prototype, 'upload').mockResolvedValue({ uri: 'person' } as any);
    await expect(submitVideoEdit(params, http)).rejects.toThrow('uncertain submission');
    expect(upload).toHaveBeenCalledWith(params.sourceVideo, params.sourceSha256);
    const calls = request.mock.calls.filter(([r]) => r.url.includes('/generate'));
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data.extend.m_video_commerce_info).toEqual({ benefit_type: 'seedance_25_720p_output', amount: 4 });
    expect(calls[0][0].params?.commerce_with_input_video).toBe('1');
  });

  it('uploads verified local bytes through isolated signed VOD and multipart requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jimeng-upload-test-'));
    const oldAdapter = axios.defaults.adapter;
    try {
      const bytes = Buffer.concat([Buffer.from([0,0,0,32]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
      const path = join(root, 'source.mp4');
      await writeFile(path, bytes);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const http = new HttpClient('secret-session');
      jest.spyOn(http, 'request').mockResolvedValue({ ret: '0', data: { access_key_id: 'temporary-ak', secret_access_key: 'temporary-sk', session_token: 'temporary-token', space_name: 'space' } });
      const calls: any[] = [];
      axios.defaults.adapter = async config => {
        calls.push(config);
        let data: any;
        if (config.params?.Action === 'ApplyUploadInner') data = { Result: { InnerUploadAddress: { UploadNodes: [{
          UploadHost: 'upload.bytecdn.cn', StoreInfos: [{ StoreUri: 'tos/source', Auth: 'storage-only' }], SessionKey: 'upload-session',
        }] } } };
        else if (config.params?.phase === 'init') data = { code: 2000, data: { uploadid: 'upload-id' } };
        else if (config.params?.Action === 'CommitUploadInner') data = { Result: { Results: [{ Vid: video.vid, VideoMeta: { Width: 1280, Height: 720, Duration: 10, Fps: 24 } }] } };
        else data = { code: 2000, data: { key: 'source' } };
        return { data, config, status: 200, statusText: 'OK', headers: {} };
      };
      const uploader = new VideoUploader(http);
      expect(await uploader.upload(path, sha)).toEqual(video);
      expect(calls.map(c => c.params.Action ?? c.params.phase)).toEqual(['ApplyUploadInner', 'init', 'transfer', 'finish', 'CommitUploadInner']);
      expect(calls.every(c => c.maxRedirects === 0 && !c.headers.get('Cookie'))).toBe(true);
      expect(calls[2].headers.get('Authorization')).toBe('storage-only');
      expect(calls[2].headers.get('X-Amz-Security-Token')).toBeUndefined();
      expect(Buffer.from(calls[2].data)).toEqual(bytes);
      expect(calls[3].data).toMatch(/^1:[a-f0-9]{8}$/);
      const before = calls.length;
      await expect(uploader.upload(path, '0'.repeat(64))).rejects.toThrow('不一致');
      expect(calls).toHaveLength(before);
    } finally { axios.defaults.adapter = oldAdapter; await rm(root, { recursive: true, force: true }); }
  });
});
