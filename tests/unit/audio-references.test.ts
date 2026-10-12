import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { AudioUploader } from '../../src/api/AudioUploader.js';
import { ImageUploader } from '../../src/api/ImageUploader.js';
import { HttpClient } from '../../src/api/HttpClient.js';
import { NewJimengClient } from '../../src/api/NewJimengClient.js';
import { unifiedReferenceInput } from '../../src/api/ProductionTasks.js';
import { productionSubmitSchema, validateProductionSubmit } from '../../src/production-tools.js';
import { CacheManager } from '../../src/utils/cache-manager.js';
afterEach(() => { jest.restoreAllMocks(); CacheManager.clear(); CacheManager.stopPeriodicEviction(); });
describe('Seedance audio reference transport', () => {
  it('binds independent audio numbering to the correct unified material indexes', () => {
    const input = unifiedReferenceInput('@音频2音色，@图片1人物，@音频1风声。', [{ uri: 'image' }], undefined, [{ vid: 'wind', durationMs: 2000 }, { vid: 'voice', durationMs: 3000 }]);
    expect(input.material_list.map(item => item.material_type)).toEqual(['image', 'audio', 'audio']);
    expect(input.meta_list.filter(item => item.meta_type !== 'text').map(item => [item.meta_type, item.material_ref.material_idx])).toEqual([['audio', 2], ['image', 0], ['audio', 1]]);
    expect(input.material_list[1].audio_info).toMatchObject({ vid: 'wind', duration: 2000 });
    expect(() => unifiedReferenceInput('@音频1', [], undefined, [{ vid: 'a', durationMs: 2000 }, { vid: 'b', durationMs: 2000 }])).toThrow(/每段音频/);
    expect(() => unifiedReferenceInput('@音频2', [], undefined, [{ vid: 'a', durationMs: 2000 }])).toThrow(/越界/);
  });
  it('forwards reviewed audio into the real generation payload and rejects invalid inputs before uploading', async () => {
    const audio = jest.spyOn(AudioUploader.prototype, 'upload').mockResolvedValue({ vid: 'voice', durationMs: 2000 });
    jest.spyOn(ImageUploader.prototype, 'upload').mockResolvedValue({ uri: 'scene', width: 1280, height: 720, format: 'png' } as any);
    const request = jest.spyOn(HttpClient.prototype, 'request').mockResolvedValue({ ret: '0', data: { aigc_data: { submit_id: 'test' } } } as any);
    const input = { submitId: randomUUID(), model: 'seedance-2.5', prompt: '@图片1人物，@音频1仅参考声线。', referenceImages: ['/person.png'], referenceAudios: [{ path: '/voice.wav', sha256: 'a'.repeat(64), durationMs: 2000 }], async: true };
    await new NewJimengClient('offline-only').generateTextToVideo(input);
    expect(audio).toHaveBeenCalledWith('/voice.wav', 'a'.repeat(64));
    const payload = JSON.parse(request.mock.calls[0]![0].data.draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
    expect(payload.unified_edit_input.material_list.map((item: any) => item.material_type)).toEqual(['image', 'audio']);
    expect(payload.unified_edit_input.material_list[1].audio_info.vid).toBe('voice');
    audio.mockClear(); request.mockClear();
    for (const patch of [{ model: 'seedance-2.0' }, { prompt: '@图片1人物' }, { referenceAudios: [{ ...input.referenceAudios[0], durationMs: 31000 }] }]) {
      await expect(new NewJimengClient('offline-only').generateTextToVideo({ ...input, ...patch })).rejects.toThrow();
      expect(audio).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    }
    const schema = productionSubmitSchema.parse({ submitId: randomUUID(), mediaType: 'video', model: 'seedance-2.5', prompt: '@音频1@音频2', references: [], referenceAudios: [20000, 20000].map(durationMs => ({ path: '/sample.wav', sha256: 'a'.repeat(64), durationMs })), ratio: '16:9', resolution: '720p', durationSeconds: 5 });
    expect(() => validateProductionSubmit(schema)).toThrow(/30 秒/);
  });
});
