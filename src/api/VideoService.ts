/**
 * VideoService - 统一视频生成服务
 * 合并4个独立生成器的功能（TextToVideo, MultiFrame, MainReference）
 * 内联轮询逻辑（≤30行），移除timeout.ts依赖
 * 使用组合模式，依赖HttpClient和ImageUploader
 */

import { HttpClient } from './HttpClient.js';
import { ImageUploader } from './ImageUploader.js';
import { DEFAULT_VIDEO_MODEL, getVideoModel } from '../types/models.js';
import { logger } from '../utils/logger.js';
import { unifiedImageInput, queryProductionTask } from './ProductionTasks.js';

// ==================== 类型定义 ====================

export interface VideoResult {
  videoUrl?: string;
  taskId?: string;
  metadata: {
    model: string;
    resolution: string;
    duration: number;
    fps: number;
  };
}

/** A conclusive pre-submit failure or provider refusal: no task was created. */
export class VideoSubmissionRejectedError extends Error {
  override name = 'VideoSubmissionRejectedError';
}

export interface TextToVideoParams {
  submitId?: string;
  draft?: boolean;
  referenceImages?: string[];
  prompt: string;
  model?: string;
  resolution?: '480p' | '720p' | '1080p';
  fps?: number;
  duration?: number;
  async?: boolean;
  firstFrameImage?: string;
  lastFrameImage?: string;
  videoAspectRatio?: string;
}

export interface FrameConfig {
  idx: number;
  imagePath: string;
  duration_ms: number;
  prompt: string;
}

export interface MultiFrameParams {
  frames: FrameConfig[];
  model?: string;
  resolution?: '720p' | '1080p';
  fps?: number;
  async?: boolean;
  videoAspectRatio?: string;
}

export interface MainReferenceParams {
  referenceImages: string[];
  prompt: string;
  model?: string;
  resolution?: '720p' | '1080p';
  fps?: number;
  duration?: number;
  async?: boolean;
  videoAspectRatio?: string;
}

/**
 * VideoService类
 * 整合所有视频生成功能
 */
export class VideoService {
  constructor(
    private httpClient: HttpClient,
    private imageUploader: ImageUploader
  ) {}

  // ==================== 公共方法：三种视频生成模式 ====================

  /**
   * 文本生成视频（支持首尾帧）
   */
  async generateTextToVideo(params: TextToVideoParams): Promise<VideoResult> {
    const {
      prompt,
      firstFrameImage,
      lastFrameImage,
      async: asyncMode = false,
      resolution = '720p',
      videoAspectRatio = '16:9',
      fps = 24,
      duration = 5000,
      model = DEFAULT_VIDEO_MODEL
    } = params;

    // 在上传/提交前检查模型能力；不能静默改模型、分辨率或时长。
    const actualModel = getVideoModel(model);
    const isSeedance = model === 'seedance-2.0' || model === 'seedance-2.5';
    const references = params.referenceImages ?? [];
    if (references.length && (!isSeedance || firstFrameImage || lastFrameImage)) {
      throw new Error('全能参考仅支持 Seedance 2.0/2.5，不能与首尾帧模式混用');
    }
    if ((firstFrameImage || lastFrameImage) && /@(?:图片|视频|音频)\d+/u.test(prompt)) {
      throw new Error('首尾帧模式不支持 @图片/视频/音频 编号；请使用首帧/尾帧的普通文字描述');
    }
    if (references.length > (model === 'seedance-2.5' ? 30 : 9)) throw new Error('参考图数量超过模型上限');
    // Validate indices before uploading anything.
    if (references.length) unifiedImageInput(prompt, references.map(() => ({})));
    const minDuration = isSeedance ? 4000 : 3000;
    const maxDuration = model === 'seedance-2.5' ? 30000 : 15000;
    if (!Number.isInteger(duration) || duration < minDuration || duration > maxDuration || (isSeedance && duration % 1000 !== 0)) {
      throw new Error(`${model}: duration必须在${minDuration}-${maxDuration}毫秒之间${isSeedance ? '，且为整秒' : ''}`);
    }
    if (!Number.isInteger(fps) || (isSeedance ? fps !== 24 : fps < 12 || fps > 30)) {
      throw new Error(`${model}: fps必须为${isSeedance ? '24' : '12-30之间的整数'}`);
    }
    const resolutions = model === 'seedance-2.0' ? ['720p'] : model === 'seedance-2.5' ? ['480p', '720p', '1080p'] : ['720p', '1080p'];
    if (!resolutions.includes(resolution)) {
      throw new Error(`${model}: resolution仅支持${resolutions.join('/')}`);
    }
    if (params.draft && (model !== 'seedance-2.5' || resolution !== '480p')) {
      throw new Error('Seedance 2.5 样片模式仅支持 480p');
    }

    // 网页按输出秒数计量；本接口无输入视频，2.5 使用 no_input_video 计费项。
    const commerceInfo = {
      benefit_type: model === 'seedance-2.0' ? 'dreamina_video_seedance_20_pro'
        : model === 'seedance-2.5' ? `seedance_25_${resolution}_no_input_video_output`
        : 'basic_video_operation_vgfm_v_three',
      resource_id: 'generate_video',
      resource_id_type: 'str',
      resource_sub_type: 'aigc',
      ...(isSeedance ? { amount: duration / 1000 } : {})
    };

    if (params.draft) {
      // Sample commerce keys come from the current account configuration.
      // Resolve them before any reference upload or billable submission.
      const config = await this.httpClient.request({
        url: '/mweb/v1/video_generate/get_common_config',
        data: { scene: 'generate_video', params: { needCache: true } },
      });
      const current = config?.data?.model_list?.find((item: any) => item.model_req_key === actualModel);
      const available = current?.options?.find((item: any) => item.key === 'resolution' && !item.forbidden_display)
        ?.enum_val?.string_value;
      const price = current?.commercial_config?.resolution_price_configs
        ?.find((item: any) => item.resolution === resolution)?.price;
      if (String(config?.ret) !== '0' || current?.model_status !== 0
        || !Array.isArray(available) || !available.includes(resolution)
        || typeof price?.benefit_type !== 'string' || !price.benefit_type) {
        throw new VideoSubmissionRejectedError('即梦当前未开放所选 Seedance 2.5 样片规格或未返回计费配置；未上传参考图、未提交生成');
      }
      Object.assign(commerceInfo, price, { amount: duration / 1000 });
    }

    const unifiedInput = references.length
      ? unifiedImageInput(prompt, await Promise.all(references.map(path => this.imageUploader.upload(path))))
      : undefined;

    // 上传首尾帧图片
    let first_frame_image = undefined;
    let end_frame_image = undefined;

    if (firstFrameImage || lastFrameImage) {
      const uploadResults: any[] = [];

      if (firstFrameImage) {
        const result = await this.imageUploader.upload(firstFrameImage);
        uploadResults.push(result);
      }

      if (lastFrameImage) {
        const result = await this.imageUploader.upload(lastFrameImage);
        if (!firstFrameImage) uploadResults.unshift(null as any);
        uploadResults.push(result);
      }

      if (uploadResults[0]) {
        first_frame_image = {
          format: uploadResults[0].format,
          height: uploadResults[0].height,
          id: this.generateUuid(),
          image_uri: uploadResults[0].uri,
          name: "",
          platform_type: 1,
          source_from: "upload",
          type: "image",
          uri: uploadResults[0].uri,
          width: uploadResults[0].width,
        };
      }

      if (uploadResults[1]) {
        end_frame_image = {
          format: uploadResults[1].format,
          height: uploadResults[1].height,
          id: this.generateUuid(),
          image_uri: uploadResults[1].uri,
          name: "",
          platform_type: 1,
          source_from: "upload",
          type: "image",
          uri: uploadResults[1].uri,
          width: uploadResults[1].width,
        };
      }
    }

    // 构建 draft_content 请求体
    const componentId = this.generateUuid();
    const submitId = params.submitId ?? this.generateUuid();
    const metricsExtra = JSON.stringify({
      "enterFrom": "click",
      "isDefaultSeed": 1,
      "promptSource": "custom",
      "isRegenerate": false,
      "originSubmitId": this.generateUuid(),
      "functionMode": unifiedInput ? 'omni_reference' : 'first_last_frames',
    });

    const requestBody = {
      "extend": {
        "root_model": actualModel,
        "m_video_commerce_info": commerceInfo,
        "m_video_commerce_info_list": [commerceInfo]
      },
      "submit_id": submitId,
      "metrics_extra": metricsExtra,
      "draft_content": JSON.stringify({
        "type": "draft",
        "id": this.generateUuid(),
        "min_version": params.draft ? "3.3.28" : unifiedInput ? "3.3.9" : "3.0.5",
        ...(unifiedInput ? { min_features: ['AIGC_Video_UnifiedEdit'] } : {}),
        "is_from_tsn": true,
        "version": params.draft ? "3.3.28" : unifiedInput ? "3.3.9" : "3.3.2",
        "main_component_id": componentId,
        "component_list": [{
          "type": "video_base_component",
          "id": componentId,
          "min_version": "1.0.0",
          "metadata": {
            "type": "",
            "id": this.generateUuid(),
            "created_platform": 3,
            "created_platform_version": "",
            "created_time_in_ms": Date.now(),
            "created_did": ""
          },
          "generate_type": "gen_video",
          "aigc_mode": "workbench",
          "abilities": {
            "type": "",
            "id": this.generateUuid(),
            "gen_video": {
              "id": this.generateUuid(),
              "type": "",
              "text_to_video_params": {
                "type": "",
                "id": this.generateUuid(),
                "model_req_key": actualModel,
                "priority": 0,
                "seed": Math.floor(Math.random() * 100000000) + 2500000000,
                "video_aspect_ratio": videoAspectRatio,
                "video_gen_inputs": [{
                  duration_ms: duration,
                  first_frame_image: first_frame_image,
                  end_frame_image: end_frame_image,
                  ...(end_frame_image ? { ending_control: '1.0' } : {}),
                  fps: fps,
                  id: this.generateUuid(),
                  min_version: params.draft ? "3.3.28" : unifiedInput ? "3.3.9" : "3.0.5",
                  ...(params.draft ? { is_draft_mode: true } : {}),
                  prompt: unifiedInput ? '' : prompt,
                  ...(unifiedInput ? { unified_edit_input: unifiedInput } : {}),
                  resolution: resolution,
                  type: "",
                  video_mode: 2
                }]
              },
              "video_task_extra": metricsExtra,
            }
          }
        }],
      }),
    };

    // 提交任务
    const taskId = await this.submitTaskWithDraft(requestBody);

    if (asyncMode) {
      return {
        taskId,
        metadata: { model, resolution, duration, fps }
      };
    }

    // 同步模式：轮询
    const videoUrl = await this.pollUntilComplete(taskId);
    return {
      videoUrl,
      metadata: { model, resolution, duration, fps }
    };
  }

  /**
   * 生成UUID（本地方法）
   */
  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * 多帧视频生成（2-10帧）
   */
  async generateMultiFrame(params: MultiFrameParams): Promise<VideoResult> {
    const {
      frames,
      async: asyncMode = false,
      resolution = '720p',
      fps = 24,
      model = 'jimeng-video-3.0',
      videoAspectRatio = '16:9'
    } = params;

    // 验证参数
    if (frames.length < 2 || frames.length > 10) {
      throw new Error('帧数量必须在2-10之间');
    }
    const actualModel = getVideoModel(model, false);

    // 按索引排序
    const sortedFrames = [...frames].sort((a, b) => a.idx - b.idx);

    // 计算总时长
    const totalDuration = sortedFrames.reduce((sum, f) => sum + f.duration_ms, 0);

    // 上传所有帧图片
    const uploadedFrames = await this.uploadFrames(sortedFrames.map(f => f.imagePath));

    // 构建完整的multiFrames数组（包含media_info结构）
    const multiFrames = sortedFrames.map((frame, index) => ({
      type: "",
      id: this.generateUuid(),
      idx: frame.idx,
      duration_ms: frame.duration_ms,
      prompt: frame.prompt,
      media_info: {
        type: "",
        id: this.generateUuid(),
        media_type: 1,
        image_info: {
          type: "image",
          id: this.generateUuid(),
          source_from: "upload",
          platform_type: 1,
          name: "",
          image_uri: uploadedFrames[index].uri,
          width: uploadedFrames[index].width,
          height: uploadedFrames[index].height,
          format: uploadedFrames[index].format,
          uri: uploadedFrames[index].uri
        }
      }
    }));

    const componentId = this.generateUuid();
    const submitId = this.generateUuid();

    // 构建metrics_extra
    const metricsExtra = {
      isDefaultSeed: 1,
      originSubmitId: submitId,
      isRegenerate: false,
      enterFrom: "result_click_reference",
      functionMode: "multi_frame"
    };

    // 构建draft_content（完整结构）
    const draftContent = {
      type: "draft",
      id: this.generateUuid(),
      min_version: "3.0.5",
      min_features: ["AIGC_GenerateType_VideoMultiFrame"],
      is_from_tsn: true,
      version: "3.3.3",
      main_component_id: componentId,
      component_list: [{
        type: "video_base_component",
        id: componentId,
        min_version: "1.0.0",
        aigc_mode: "workbench",
        metadata: {
          type: "",
          id: this.generateUuid(),
          created_platform: 3,
          created_platform_version: "",
          created_time_in_ms: Date.now().toString(),
          created_did: ""
        },
        generate_type: "gen_video",
        abilities: {
          type: "",
          id: this.generateUuid(),
          gen_video: {
            type: "",
            id: this.generateUuid(),
            text_to_video_params: {
              type: "",
              id: this.generateUuid(),
              video_gen_inputs: [{
                type: "",
                id: this.generateUuid(),
                min_version: "3.0.5",
                prompt: "",
                video_mode: 1,
                fps: fps,
                duration_ms: totalDuration,
                resolution: resolution,
                multi_frames: multiFrames
              }],
              video_aspect_ratio: videoAspectRatio,
              seed: Math.floor(Math.random() * 100000000) + 2500000000,
              model_req_key: actualModel,
              priority: 0
            },
            video_task_extra: JSON.stringify(metricsExtra)
          }
        },
        process_type: 1
      }]
    };

    // 构建完整请求体
    const requestBody = {
      extend: {
        root_model: actualModel,
        m_video_commerce_info: {
          benefit_type: "basic_video_operation_vgfm_v_three",
          resource_id: "generate_video",
          resource_id_type: "str",
          resource_sub_type: "aigc"
        },
        m_video_commerce_info_list: [{
          benefit_type: "basic_video_operation_vgfm_v_three",
          resource_id: "generate_video",
          resource_id_type: "str",
          resource_sub_type: "aigc"
        }]
      },
      submit_id: submitId,
      metrics_extra: JSON.stringify(metricsExtra),
      draft_content: JSON.stringify(draftContent),
      http_common_info: { aid: 513695 }
    };

    // 提交任务
    const taskId = await this.submitTaskWithDraft(requestBody);

    if (asyncMode) {
      return {
        taskId,
        metadata: { model, resolution, duration: totalDuration, fps }
      };
    }

    // 同步模式：轮询
    const videoUrl = await this.pollUntilComplete(taskId);
    return {
      videoUrl,
      metadata: { model, resolution, duration: totalDuration, fps }
    };
  }

  /**
   * 主参考视频生成（2-4张参考图）
   */
  async generateMainReference(params: MainReferenceParams): Promise<VideoResult> {
    const {
      referenceImages,
      prompt,
      async: asyncMode = false,
      resolution = '720p',
      fps = 24,
      duration = 5000,
      model = 'jimeng-video-3.0',
      videoAspectRatio = '16:9'
    } = params;

    // 验证参数
    if (referenceImages.length < 2 || referenceImages.length > 4) {
      throw new Error('参考图片数量必须在2-4之间');
    }

    if (!prompt.includes('[图')) {
      throw new Error('必须包含至少一个图片引用（如[图0]）');
    }

    const actualModel = getVideoModel(model, false);

    // 上传参考图片
    const uploadedImages = await this.uploadFrames(referenceImages);

    // 解析提示词，提取[图N]引用
    const { textSegments, imageRefs } = this.parseMainReferencePrompt(prompt, referenceImages.length);

    // 构建idip_meta_list
    const idip_meta_list = this.buildIdipMetaList(textSegments, imageRefs);

    // 构建idip_frames（完整图片对象）
    const idip_frames = uploadedImages.map(img => ({
      format: img.format,
      height: img.height,
      id: this.generateUuid(),
      image_uri: img.uri,
      name: "",
      platform_type: 1,
      source_from: "upload",
      type: "image",
      uri: img.uri,
      width: img.width,
    }));

    // 构建draft_content请求体
    const componentId = this.generateUuid();
    const submitId = this.generateUuid();
    const metricsExtra = {
      "isDefaultSeed": 1,
      "originSubmitId": submitId,
      "isRegenerate": false,
      "enterFrom": "click",
      "functionMode": "main_reference"
    };

    const draftContent = {
        "type": "draft",
        "id": this.generateUuid(),
        "min_version": "3.0.5",
        "min_features": ["AIGC_GenerateType_VideoIdipFrame"],
        "is_from_tsn": true,
        "version": "3.3.3",
        "main_component_id": componentId,
        "component_list": [{
          "type": "video_base_component",
          "id": componentId,
          "min_version": "1.0.0",
          "aigc_mode": "workbench",
          "metadata": {
            "type": "",
            "id": this.generateUuid(),
            "created_platform": 3,
            "created_platform_version": "",
            "created_time_in_ms": Date.now().toString(),
            "created_did": ""
          },
          "generate_type": "gen_video",
          "abilities": {
            "type": "",
            "id": this.generateUuid(),
            "gen_video": {
              "type": "",
              "id": this.generateUuid(),
              "text_to_video_params": {
                "type": "",
                "id": this.generateUuid(),
                "video_gen_inputs": [{
                  "type": "",
                  "id": this.generateUuid(),
                  "min_version": "3.0.5",
                  "prompt": "",
                  "video_mode": 2,
                  "fps": fps,
                  "duration_ms": duration,
                  "resolution": resolution,
                  "idip_frames": idip_frames,
                  "idip_meta_list": idip_meta_list
                }],
                "video_aspect_ratio": videoAspectRatio,
                "seed": Math.floor(Math.random() * 100000000) + 2500000000,
                "model_req_key": actualModel,
                "priority": 0
              },
              "video_task_extra": JSON.stringify(metricsExtra)
            }
          },
          "process_type": 1
        }]
    };

    const requestBody = {
      "extend": {
        "root_model": actualModel,
        "m_video_commerce_info": {
          "benefit_type": "basic_video_operation_vgfm_v_three",
          "resource_id": "generate_video",
          "resource_id_type": "str",
          "resource_sub_type": "aigc"
        },
        "m_video_commerce_info_list": [{
          "benefit_type": "basic_video_operation_vgfm_v_three",
          "resource_id": "generate_video",
          "resource_id_type": "str",
          "resource_sub_type": "aigc"
        }]
      },
      "submit_id": submitId,
      "metrics_extra": JSON.stringify(metricsExtra),
      "draft_content": JSON.stringify(draftContent),
      "http_common_info": { "aid": 513695 }
    };

    // 调试：打印请求体
    // console.log('🔍 [主体参考] 请求体:', JSON.stringify(requestBody, null, 2));

    // 提交任务
    const taskId = await this.submitTaskWithDraft(requestBody);

    if (asyncMode) {
      return {
        taskId,
        metadata: { model, resolution, duration, fps }
      };
    }

    // 同步模式：轮询
    const videoUrl = await this.pollUntilComplete(taskId);
    return {
      videoUrl,
      metadata: { model, resolution, duration, fps }
    };
  }

  // ==================== 私有方法：共享逻辑 ====================

  /**
   * 上传多个帧图片
   */
  private async uploadFrames(imagePaths: string[]): Promise<any[]> {
    return this.imageUploader.uploadBatch(imagePaths);
  }

  /**
   * 提交draft格式的视频生成任务
   */
  private async submitTaskWithDraft(requestBody: any): Promise<string> {
    const requestParams = this.httpClient.generateRequestParams();

    const response = await this.httpClient.request({
      method: 'POST',
      url: '/mweb/v1/aigc_draft/generate',
      params: requestParams,
      data: requestBody
    });

    // 视频生成需要使用submit_id进行轮询（与图片不同！）
    const submitId = response?.data?.aigc_data?.task?.submit_id ||
                     response?.data?.aigc_data?.submit_id ||
                     response?.data?.submit_id ||
                     response?.submit_id;

    if (response?.ret !== undefined && String(response.ret) !== '0') {
      throw new VideoSubmissionRejectedError(`即梦明确拒绝视频提交 (${response.ret})：${response.errmsg || response.message || '参数无效'}`);
    }
    if (!submitId) {
      if (response?.errmsg) throw new VideoSubmissionRejectedError(`即梦明确拒绝视频提交：${response.errmsg}`);
      throw new Error('提交视频任务失败：未返回 submit_id；请查询原任务，不要再次提交');
    }

    return submitId;
  }

  /**
   * 轮询直到任务完成（内联实现，≤30行）
   */
  private async pollUntilComplete(taskId: string): Promise<string> {
    const startTime = Date.now();
    const timeout = 600000; // 600秒
    let pollCount = 0;

    while (Date.now() - startTime < timeout) {
      pollCount++;

      // 第一次等待60秒，后续等待5秒（与旧代码一致）
      const waitTime = pollCount === 1 ? 60000 : 5000;
      // console.log(`🔄 [轮询${pollCount}] 等待 ${waitTime/1000}秒...`);
      await this.sleep(waitTime);

      const status = await this.checkTaskStatus(taskId);

      // 关键修改：参考旧代码逻辑
      // 只要有video_url就返回，不强制要求status='completed'
      // 因为有时候视频已经生成完成，但状态字段还没更新
      if (status.video_url) {
        // console.log(`✅ [轮询${pollCount}] 成功获取到视频URL`);
        return status.video_url;
      }

      // 检查失败状态
      if (status.status === 'failed') {
        throw new Error(status.error || '视频生成失败');
      }

      // 如果status是completed但没有URL，报错
      if (status.status === 'completed' && !status.video_url) {
        logger.debug(`❌ 视频生成完成但未找到URL，完整状态: ${JSON.stringify(status, null, 2)}`);
        throw new Error('视频生成完成但未返回URL');
      }

      // 继续下一轮轮询
      // console.log(`⏳ [轮询${pollCount}] 状态=${status.status}, 继续等待...`);
    }

    throw new Error(`视频生成超时: taskId=${taskId}`);
  }

  /**
   * 检查任务状态
   */
  private async checkTaskStatus(taskId: string): Promise<any> {
    const task = await queryProductionTask(taskId, 'video', this.httpClient);
    return { status: task.status === 'not_found' ? 'processing' : task.status, video_url: task.outputs[0]?.url ?? null, error: task.error ?? null };
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 查询视频生成结果（单个）
   */
  async queryVideo(submitId: string): Promise<any> {
    const status = await this.checkTaskStatus(submitId);
    return status;
  }

  /**
   * 批量查询视频生成结果
   */
  async queryVideoBatch(submitIds: string[]): Promise<Record<string, any>> {
    const requestParams = this.httpClient.generateRequestParams();

    const response = await this.httpClient.request({
      method: 'POST',
      url: '/mweb/v1/get_history_by_ids',
      params: requestParams,
      data: { submit_ids: submitIds }
    });

    const results: Record<string, any> = {};

    for (const submitId of submitIds) {
      const record = response?.data?.[submitId];

      if (!record) {
        results[submitId] = { status: 'not_found', error: '记录不存在' };
        continue;
      }

      // 解析状态
      const statusCode = record.status;
      let mappedStatus: string;

      if (statusCode === 50) {
        mappedStatus = 'completed';
      } else if (statusCode === 30) {
        mappedStatus = 'failed';
      } else if (statusCode === 20 || statusCode === 42 || statusCode === 45) {
        mappedStatus = 'processing';
      } else {
        mappedStatus = 'unknown';
      }

      // 提取视频URL（与checkTaskStatus保持一致）
      let videoUrl = null;
      if (record.item_list && record.item_list.length > 0) {
        const item = record.item_list[0];
        videoUrl = item?.video?.transcoded_video?.origin?.video_url ||
                  item?.video?.video_url ||
                  item?.video?.origin?.video_url;
      }

      results[submitId] = {
        status: mappedStatus,
        video_url: videoUrl,
        error: statusCode === 30 ? (record.fail_code || '生成失败') : null,
        raw_status: statusCode
      };
    }

    return results;
  }

  /**
   * 解析主参考提示词（提取[图N]引用）
   */
  private parseMainReferencePrompt(prompt: string, imageCount: number): {
    textSegments: string[];
    imageRefs: number[];
  } {
    const regex = /\[图(\d+)\]/g;
    const textSegments: string[] = [];
    const imageRefs: number[] = [];

    let lastIndex = 0;
    let match;

    while ((match = regex.exec(prompt)) !== null) {
      // 添加前面的文本段
      if (match.index > lastIndex) {
        textSegments.push(prompt.substring(lastIndex, match.index));
      }

      // 添加图片引用索引
      const imageIndex = parseInt(match[1]);
      if (imageIndex >= imageCount) {
        throw new Error(`图片引用[图${imageIndex}]超出范围（0-${imageCount - 1}）`);
      }
      imageRefs.push(imageIndex);

      lastIndex = regex.lastIndex;
    }

    // 添加最后的文本段
    if (lastIndex < prompt.length) {
      textSegments.push(prompt.substring(lastIndex));
    }

    return { textSegments, imageRefs };
  }

  /**
   * 构建idip_meta_list（主参考模式参数）
   * 正确格式参考: generate_zhuti_request.json
   */
  private buildIdipMetaList(textSegments: string[], imageRefs: number[]): any[] {
    const metaList: any[] = [];

    for (let i = 0; i < Math.max(textSegments.length, imageRefs.length); i++) {
      // 先添加图片引用
      if (i < imageRefs.length) {
        metaList.push({
          type: "",
          id: this.generateUuid(),
          meta_type: "idip_frame",
          text: "",
          frame_info: {
            type: "",
            id: this.generateUuid(),
            image_idx: imageRefs[i]
          }
        });
      }

      // 后添加文本段
      if (i < textSegments.length && textSegments[i].trim()) {
        metaList.push({
          type: "",
          id: this.generateUuid(),
          meta_type: "text",
          text: textSegments[i].trim()
        });
      }
    }

    return metaList;
  }
}
