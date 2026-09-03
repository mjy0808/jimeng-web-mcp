/**
 * JimengClient - 重构后的主客户端（组合模式）
 *
 * 架构变更：
 * - 移除 extends BaseClient 继承
 * - 使用组合模式：注入 HttpClient, ImageUploader, NewCreditService, VideoService
 * - 保持所有现有API签名不变（100%向后兼容）
 * - 旧方法静默重定向到新方法（无警告）
 */

import { HttpClient } from "./HttpClient.js";
import { ImageUploader } from "./ImageUploader.js";
import { NewCreditService } from "./NewCreditService.js";
import { VideoService } from "./VideoService.js";
import { CacheManager } from "../utils/cache-manager.js";
import { logger } from "../utils/logger.js";
import { PromptValidator } from "../utils/prompt-validator.js";
import {
  getModel,
  DEFAULT_MODEL,
  DRAFT_VERSION,
  WEB_ID,
} from "../types/models.js";
import { generateUuid, jsonEncode, urlEncode } from "../utils/index.js";
import { ImageDimensionCalculator } from "../utils/dimensions.js";
import {
  MAX_IMAGES_PER_REQUEST,
  MAX_IMAGE_COUNT,
  STATUS_CODES,
  POLLING,
  CONTINUATION_ACTION,
} from "../types/constants.js";
import type {
  ImageGenerationParams,
  VideoGenerationParams,
  MainReferenceVideoParams,
} from "../types/api.types.js";

/**
 * JimengClient - 组合模式实现
 */
export class NewJimengClient {
  // 组合的服务类
  private httpClient: HttpClient;
  private imageUploader: ImageUploader;
  private creditService: NewCreditService;
  private videoService: VideoService;
  private promptValidator: PromptValidator;

  constructor(token?: string) {
    // 初始化所有服务（组合模式）
    this.httpClient = new HttpClient(token);
    this.imageUploader = new ImageUploader(this.httpClient);
    this.creditService = new NewCreditService(this.httpClient);
    this.videoService = new VideoService(this.httpClient, this.imageUploader);
    this.promptValidator = new PromptValidator();
  }

  // ==================== 图片生成功能 ====================

  /**
   * 图片生成（保持100%向后兼容）
   * 支持继续生成功能（>4张自动触发）
   */
  async generateImage(
    params: ImageGenerationParams & { async: true },
  ): Promise<string>;
  async generateImage(
    params: ImageGenerationParams & { async?: false },
  ): Promise<string[]>;
  async generateImage(
    params: ImageGenerationParams,
  ): Promise<string[] | string> {
    const {
      prompt,
      model = DEFAULT_MODEL,
      aspectRatio = "auto",
      resolution = "2k",
      filePath,
      reference_strength,
      sample_strength,
      negative_prompt,
      frames,
      async: asyncMode = false,
    } = params;

    // 处理frames参数（与旧代码一致）
    const validFrames = this.validateAndFilterFrames(frames);
    const count = params.count === undefined ? (validFrames.length || 1) : params.count;
    if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGE_COUNT) {
      throw new Error(`count 必须是 1–${MAX_IMAGE_COUNT} 的整数`);
    }
    if (validFrames.length > 0 && count !== validFrames.length) {
      throw new Error("count 必须与有效 frames 的数量一致");
    }
    const finalPrompt = this.buildPromptWithFrames(prompt, validFrames);

    // 处理参考图
    let uploadedImages: any[] = [];
    if (filePath && filePath.length > 0) {
      logger.debug(`[参考图] 开始上传 ${filePath.length} 张参考图`);
      uploadedImages = await this.imageUploader.uploadBatch(filePath);
      logger.debug(`[参考图] 上传完成:`, uploadedImages);
    }

    // 构建API参数
    const apiParams: any = {
      prompt: finalPrompt, // 使用处理后的prompt
      model_name: getModel(model),
      aspect_ratio: aspectRatio,
      resolution: resolution, // 传递resolution用于buildAbilities计算dimensions
      negative_prompt: negative_prompt || "",
      draft_version: DRAFT_VERSION,
      count,
    };

    // 添加参考图参数（包含完整的图片元数据）
    if (uploadedImages.length > 0) {
      apiParams.reference_images = uploadedImages.map((img, idx) => ({
        uri: img.uri,
        width: img.width,
        height: img.height,
        format: img.format,
        strength: reference_strength?.[idx] ?? sample_strength ?? 0.5,
      }));
    }

    if (asyncMode) {
      // 异步模式：提交任务并缓存参数（用于智能继续生成）
      // Cache will be created inside submitImageTask with full data including requestBody
      const historyId = await this.submitImageTask(
        apiParams,
        params,
        uploadedImages,
      );

      logger.debug(
        `💾 [异步生成] CacheManager已缓存参数, historyId: ${historyId}`,
      );

      return historyId;
    }

    // 同步模式：等待完成
    const historyId = await this.submitImageTask(
      apiParams,
      params,
      uploadedImages,
    );

    logger.debug(
      `💾 [同步生成] CacheManager已缓存参数, historyId: ${historyId}`,
    );

    try {
      let firstBatch = await this.waitForImageCompletion(historyId);

      // 🔥 继续生成逻辑
      // 当 totalCount > 4 且完成了第4张时，API 会暂停等待用户确认
      // 需要发送一次"继续生成"请求，告诉 API 继续完成所有剩余图片

      const targetCount = firstBatch.totalCount || 1; // 默认1张（单图场景）
      logger.debug(
        `[同步模式检测] 目标数量=${targetCount}, 已获得=${firstBatch.imageUrls.length}, 是否部分完成=${firstBatch.isPartial}`,
      );

      // 如果检测到部分完成（API 在等待确认）
      if (firstBatch.isPartial && targetCount > MAX_IMAGES_PER_REQUEST) {
        logger.debug(`[继续生成] API 暂停等待确认，发送继续生成请求`);
        logger.debug(
          `[继续生成] 目标${targetCount}张，已完成${firstBatch.imageUrls.length}张，还需${targetCount - firstBatch.imageUrls.length}张`,
        );

        // 发送一次继续生成请求（使用原 historyId + action=2）
        await this.performSyncContinueGeneration(historyId);

        // 继续轮询原任务，等待所有剩余图片完成
        logger.debug(`[继续生成] 继续生成请求已发送，等待所有剩余图片完成...`);

        let attempts = 0;
        const maxAttempts = POLLING.MAX_ATTEMPTS * 2; // 给更多时间等待剩余图片

        while (attempts < maxAttempts) {
          await this.sleep(POLLING.INTERVAL_MS);
          const result = await this.getImageResult(historyId);

          logger.debug(
            `[继续生成轮询] 第${attempts + 1}次，状态=${result.status}, 已完成=${result.finishedCount}/${result.totalCount}, 当前返回=${result.imageUrls?.length || 0}张`,
          );

          // 所有图片都完成了
          if (
            result.status === "completed" &&
            result.imageUrls &&
            result.imageUrls.length >= targetCount
          ) {
            logger.debug(
              `[继续生成] 全部完成！共获得${result.imageUrls.length}张图片`,
            );
            return result.imageUrls;
          }

          // 检查是否已经完成了所有图片（即使 status 不是 completed）
          if (
            result.finishedCount &&
            result.finishedCount >= targetCount &&
            result.imageUrls &&
            result.imageUrls.length > 0
          ) {
            logger.debug(
              `[继续生成] 检测到所有图片已完成（finished=${result.finishedCount}/${targetCount}），返回${result.imageUrls.length}张`,
            );
            return result.imageUrls;
          }

          if (result.status === "failed") {
            throw new Error(result.error || "继续生成失败");
          }

          attempts++;
        }

        throw new Error(
          `继续生成超时: 目标${targetCount}张，超时前已获得${firstBatch.imageUrls.length}张`,
        );
      }

      // 没有继续生成需求，直接返回
      return firstBatch.imageUrls;
    } finally {
      // 🔥 确保清理原始任务的缓存（延迟到此处以支持手动继续生成）
      CacheManager.cleanup(historyId);
      logger.debug(`[Cleanup] 同步生成完成，已清理缓存: ${historyId}`);
    }
  }

  /**
   * 异步提交图像生成任务
   */
  async generateImageAsync(params: ImageGenerationParams): Promise<string> {
    return this.generateImage({ ...params, async: true }) as Promise<string>;
  }

  /**
   * 查询图像/视频生成结果
   * 自动判断ID类型：UUID格式使用submit_ids，数字格式使用history_ids
   */
  async getImageResult(historyId: string): Promise<any> {
    const requestParams = this.httpClient.generateRequestParams();

    // UUID格式（如1e06b3c9-bd41-46dd-8889-70f2c61f66bb）使用submit_ids（视频）
    // 数字格式（如4722540945676）使用history_ids（图片）
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        historyId,
      );
    const idField = isUUID ? "submit_ids" : "history_ids";

    logger.debug(
      `[getImageResult] ID类型: ${isUUID ? "UUID(视频)" : "数字(图片)"}, 使用字段: ${idField}`,
    );

    const response = await this.httpClient.request({
      method: "POST",
      url: "/mweb/v1/get_history_by_ids",
      params: requestParams,
      data: {
        [idField]: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: { aid: 513695 },
      },
    });

    // 解析响应
    const record = response?.data?.[historyId];
    if (!record) {
      return { status: "failed", error: "记录不存在" };
    }

    // 解析基础结果
    const result = this.parseQueryResult(record, historyId);
    if (result.status === "failed") return result;

    // 🔥 智能继续生成逻辑（修复：不管status是什么都检查，参考旧代码）
    // 检测是否需要触发继续生成（仅对图片任务）
    if (!isUUID) {
      const statusCode = record.status;
      const totalCount = record.total_image_count || 0;
      const finishedCount = record.finished_image_count || 0;
      const itemCount = record.item_list?.length || 0;

      logger.debug(
        `[智能继续生成检测] historyId=${historyId}, status=${result.status}(${statusCode}), total=${totalCount}, finished=${finishedCount}, items=${itemCount}`,
      );

      const cacheEntry = CacheManager.get(historyId);
      logger.debug(
        `[缓存检查] 是否有缓存: ${!!cacheEntry}, 是否已发送: ${cacheEntry?.continuationSent || false}`,
      );

      // 判断是否需要继续生成
      // 1. totalCount > MAX_IMAGES_PER_REQUEST - 需要生成超过4张
      // 2. finishedCount === MAX_IMAGES_PER_REQUEST - 精确等于4张（避免重复触发）
      // 3. cacheEntry - 必须有缓存才能构建继续生成请求
      // 4. 未发送过继续生成请求（防重复）
      const needsContinuation =
        totalCount > MAX_IMAGES_PER_REQUEST &&
        finishedCount === MAX_IMAGES_PER_REQUEST &&
        cacheEntry &&
        cacheEntry.apiParams.count === totalCount &&
        !cacheEntry.continuationSent;

      logger.debug(
        `[判断结果] needsContinuation=${needsContinuation} (total>${MAX_IMAGES_PER_REQUEST}: ${totalCount > MAX_IMAGES_PER_REQUEST}, finished===${MAX_IMAGES_PER_REQUEST}: ${finishedCount === MAX_IMAGES_PER_REQUEST}, hasCache: ${!!cacheEntry}, notSent: ${!cacheEntry?.continuationSent})`,
      );

      if (needsContinuation && cacheEntry) {
        logger.debug(
          `[智能继续生成] 检测到需要继续: 目标${totalCount}张, 已完成${finishedCount}张, 当前${itemCount}张`,
        );

        // 标记为已处理，防止重复（更新CacheEntry）
        cacheEntry.continuationSent = true;

        // 异步发送继续生成请求（不等待完成，与旧代码一致）
        this.performAsyncContinueGeneration(historyId).catch((err) => {
          logger.error(`❌ [智能继续生成] 失败:`, err);
          // 失败时清除标记，允许重试
          const entry = CacheManager.get(historyId);
          if (entry) {
            entry.continuationSent = false;
          }
        });

        // 提示用户需要再次查询
        result.needs_more = true;
        result.message = `已触发继续生成（${finishedCount}/${totalCount}），请稍后再次查询以获取所有图片`;
      } else if (
        result.status === "completed" &&
        totalCount > itemCount &&
        finishedCount === totalCount
      ) {
        // 所有图片已完成，但item_list不完整（可能需要多次查询）
        result.needs_more = true;
        result.message = `生成完成（${totalCount}张），但当前只返回${itemCount}张，可能需要再次查询`;
      }
    }

    return result;
  }

  /**
   * 批量查询任务结果（真正的批量API）
   * 自动按ID类型分组：图片用history_ids，视频用submit_ids
   */
  async getBatchResults(ids: string[]): Promise<Record<string, any>> {
    if (!ids || ids.length === 0) {
      return {};
    }

    // 按ID类型分组
    const imageIds: string[] = [];
    const videoIds: string[] = [];

    for (const id of ids) {
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      ) {
        videoIds.push(id);
      } else {
        imageIds.push(id);
      }
    }

    const results: Record<string, any> = {};

    // 批量查询图片
    if (imageIds.length > 0) {
      try {
        const requestParams = this.httpClient.generateRequestParams();
        const response = await this.httpClient.request({
          method: "POST",
          url: "/mweb/v1/get_history_by_ids",
          params: requestParams,
          data: {
            history_ids: imageIds,
            image_info: {
              width: 2048,
              height: 2048,
              format: "webp",
            },
          },
        });

        // 解析图片结果
        for (const id of imageIds) {
          const record = response?.data?.[id];
          if (record) {
            results[id] = this.parseQueryResult(record, id);
          } else {
            results[id] = { status: "failed", error: "记录不存在" };
          }
        }
      } catch (error) {
        for (const id of imageIds) {
          results[id] = { status: "failed", error: String(error) };
        }
      }
    }

    // 批量查询视频
    if (videoIds.length > 0) {
      try {
        const requestParams = this.httpClient.generateRequestParams();
        const response = await this.httpClient.request({
          method: "POST",
          url: "/mweb/v1/get_history_by_ids",
          params: requestParams,
          data: {
            submit_ids: videoIds,
          },
        });

        // 解析视频结果
        for (const id of videoIds) {
          const record = response?.data?.[id];
          if (record) {
            results[id] = this.parseQueryResult(record, id);
          } else {
            results[id] = { status: "failed", error: "记录不存在" };
          }
        }
      } catch (error) {
        for (const id of videoIds) {
          results[id] = { status: "failed", error: String(error) };
        }
      }
    }

    return results;
  }

  /**
   * 解析查询结果（提取公共逻辑）
   */
  private parseQueryResult(record: any, id: string): any {
    const statusCode = record.status;
    const finishedCount = record.finished_image_count || 0;
    const totalCount = record.total_image_count || 1;

    // 映射状态码
    let status: string;
    if (statusCode === STATUS_CODES.COMPLETED) {
      status = "completed";
    } else if (statusCode === STATUS_CODES.FAILED) {
      status = "failed";
    } else if (
      statusCode === STATUS_CODES.PENDING ||
      statusCode === 42 ||
      statusCode === 45
    ) {
      status = finishedCount === 0 ? "pending" : "processing";
    } else {
      status = "processing";
    }

    const result: any = {
      status,
      progress:
        totalCount > 0 ? Math.round((finishedCount / totalCount) * 100) : 0,
      // 🔥 添加调试信息
      totalCount,
      finishedCount,
      itemCount: record.item_list?.length || 0,
      // 🔧 智能继续生成调试信息
      _debug: {
        hasCacheEntry: !!CacheManager.get(id),
        continuationSent: CacheManager.get(id)?.continuationSent || false,
        shouldTriggerContinuation:
          totalCount > MAX_IMAGES_PER_REQUEST &&
          finishedCount === MAX_IMAGES_PER_REQUEST &&
          CacheManager.get(id)?.apiParams.count === totalCount &&
          !CacheManager.get(id)?.continuationSent,
      },
    };

    // 提取URLs
    if (
      status === "completed" &&
      record.item_list &&
      record.item_list.length > 0
    ) {
      const firstItem = record.item_list[0];

      if (firstItem.video) {
        result.videoUrl =
          firstItem.video?.transcoded_video?.origin?.video_url ||
          firstItem.video?.video_url ||
          firstItem.video?.origin?.video_url;
      } else if (firstItem.image || firstItem.image_url) {
        result.imageUrls = record.item_list
          .map(
            (item: any) =>
              item.image?.large_images?.[0]?.image_url ||
              item.image_url ||
              item.image?.url,
          )
          .filter((url: any) => url);
      }
    }

    // 处理失败状态
    if (status === "failed") {
      const failCode = record.fail_code;
      result.error =
        failCode === "2038"
          ? "内容被过滤"
          : failCode
            ? `生成失败 (错误码: ${failCode})`
            : "生成失败";
    }

    // Never let a server-inferred count authorize extra generation. Keep all
    // returned URLs/counts for diagnosis; do not slice a four-image bill into one.
    const requestedCount = CacheManager.get(id)?.apiParams.count;
    if (requestedCount !== undefined && (
      record.total_image_count > requestedCount ||
      finishedCount > requestedCount ||
      (result.imageUrls?.length || 0) > requestedCount ||
      (status === "completed" && record.total_image_count > 0 && totalCount !== requestedCount)
    )) {
      result.status = "failed";
      result.error = `出图数量不符：请求 ${requestedCount} 张，任务报告 ${totalCount} 张、完成 ${finishedCount} 张。已停止自动续生成；请核对任务 ${id}，不要自动重新提交。`;
      result._debug.shouldTriggerContinuation = false;
    }

    return result;
  }

  /**
   * 执行同步继续生成（用于同步模式）
   * 发送一次继续生成确认，告诉 API 继续完成所有剩余图片
   * 不等待完成，让调用者继续轮询原始 historyId
   */
  private async performSyncContinueGeneration(
    historyId: string,
  ): Promise<void> {
    logger.debug(`[SyncContinue] 发送继续生成确认, historyId: ${historyId}`);

    // 从CacheManager获取原始参数
    const cacheEntry = CacheManager.get(historyId);

    if (!cacheEntry) {
      logger.error(`❌ [SyncContinue] 未找到缓存参数, historyId: ${historyId}`);
      throw new Error(`无法找到historyId对应的原始参数: ${historyId}`);
    }

    // 构建继续生成请求（action=2，告诉 API 继续完成剩余图片）
    const continueParams = {
      ...cacheEntry.apiParams,
      history_id: historyId, // 关键：使用原始 historyId
    };

    logger.debug(
      `[SyncContinue] 提交继续生成确认请求, history_id=${historyId}`,
    );

    try {
      // 提交继续生成任务，不等待结果
      await this.submitImageTask(continueParams);
      logger.debug(
        `[SyncContinue] 继续生成确认已发送，API 将继续生成所有剩余图片`,
      );
    } catch (error) {
      logger.error(`❌ [SyncContinue] 提交失败`, error as Record<string, any>);
      throw error;
    }
  }

  /**
   * 执行异步继续生成（智能继续生成核心方法）
   * [CONSTITUTION-EXCEPTION: Tech Debt] 重构以使用CacheManager
   */
  private async performAsyncContinueGeneration(
    historyId: string,
  ): Promise<void> {
    logger.debug(`[AsyncContinue] 开始执行继续生成, historyId: ${historyId}`);

    // 从CacheManager获取原始参数
    const cacheEntry = CacheManager.get(historyId);

    if (!cacheEntry) {
      logger.error(
        `❌ [AsyncContinue] 未找到缓存参数, historyId: ${historyId}`,
      );
      throw new Error(`无法找到historyId对应的原始参数: ${historyId}`);
    }

    logger.debug(
      `💾 [AsyncContinue] 从CacheManager获取参数成功`,
    );

    // 构建继续生成请求 - API会根据原始prompt中的totalCount自动完成剩余所有图片
    const continueParams = {
      ...cacheEntry.apiParams,
      history_id: historyId, // 关键：使用原始historyId触发继续生成
    };

    logger.debug(
      `[AsyncContinue] 提交继续生成请求 (action=2), history_id=${historyId}`,
    );

    // 提交继续生成任务 - 一次性完成所有剩余图片
    try {
      await this.submitImageTask(continueParams);
      logger.debug(
        `✅ [AsyncContinue] 继续生成请求已提交 (API将自动完成所有剩余图片)`,
      );
    } catch (error) {
      logger.error(`❌ [AsyncContinue] 提交失败`, error as Record<string, any>);
      throw error;
    }
  }

  // ==================== 视频生成功能 ====================

  /**
   * 旧视频生成API（向后兼容，静默重定向）
   */
  async generateVideo(params: VideoGenerationParams): Promise<string> {
    // 根据参数类型重定向到新方法
    if (params.multiFrames && params.multiFrames.length > 0) {
      // 多帧模式
      const result = await this.videoService.generateMultiFrame({
        frames: params.multiFrames as any, // Type compatibility
        resolution: params.resolution as "720p" | "1080p" | undefined,
        fps: params.fps,
        model: params.model,
        async: false,
      });
      return result.videoUrl!;
    }

    // 文生视频模式
    const result = await this.videoService.generateTextToVideo({
      prompt: params.prompt,
      firstFrameImage: params.filePath?.[0],
      lastFrameImage: params.filePath?.[1],
      resolution: params.resolution as "480p" | "720p" | "1080p" | undefined,
      fps: params.fps,
      duration: params.duration_ms,
      model: params.model,
      async: false,
    });
    return result.videoUrl!;
  }

  /**
   * 文生视频（新API）
   */
  async generateTextToVideo(params: any): Promise<any> {
    return this.videoService.generateTextToVideo(params);
  }

  /**
   * 多帧视频（新API）
   */
  async generateMultiFrameVideo(params: any): Promise<any> {
    return this.videoService.generateMultiFrame(params);
  }

  /**
   * 主参考视频（新API）
   */
  async generateMainReferenceVideo(
    params: MainReferenceVideoParams,
  ): Promise<string> {
    const result = await this.videoService.generateMainReference({
      referenceImages: params.referenceImages,
      prompt: params.prompt,
      resolution: params.resolution,
      fps: params.fps,
      duration: params.duration,
      model: params.model,
      async: false,
    });
    return result.videoUrl!;
  }

  /**
   * 主参考视频（统一API）
   */
  async generateMainReferenceVideoUnified(params: any): Promise<any> {
    return this.videoService.generateMainReference(params);
  }

  /**
   * 查询视频生成结果（单个）
   */
  async queryVideoResult(submitId: string): Promise<any> {
    return this.videoService.queryVideo(submitId);
  }

  /**
   * 批量查询视频生成结果
   */
  async queryVideoResults(submitIds: string[]): Promise<Record<string, any>> {
    return this.videoService.queryVideoBatch(submitIds);
  }

  /**
   * 视频后处理（帧插值、超分辨率、音效）
   */
  async videoPostProcess(params: any): Promise<any> {
    // TODO: 实现视频后处理逻辑
    throw new Error("视频后处理功能待实现");
  }

  /**
   * 帧插值（视频后处理）
   */
  async frameInterpolation(params: any): Promise<string> {
    // TODO: 实现帧插值逻辑
    throw new Error("帧插值功能待实现");
  }

  /**
   * 超分辨率（视频后处理）
   */
  async superResolution(params: any): Promise<string> {
    // TODO: 实现超分辨率逻辑
    throw new Error("超分辨率功能待实现");
  }

  /**
   * 音效生成（视频后处理）
   */
  async generateAudioEffect(params: any): Promise<string> {
    // TODO: 实现音效生成逻辑
    throw new Error("音效生成功能待实现");
  }

  // ==================== 积分管理 ====================

  /**
   * 获取积分
   */
  async getCredits(): Promise<number> {
    return this.creditService.getBalance();
  }

  /**
   * 获取详细积分信息
   */
  async getCredit(): Promise<any> {
    return this.creditService.getCredit();
  }

  /**
   * 领取积分
   */
  async receiveCredit(): Promise<void> {
    return this.creditService.receiveCredit();
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 提交图片生成任务
   *
   * [CONSTITUTION-EXCEPTION: Tech Debt] 重构以使用CacheManager
   * @param apiParams - API parameters for request
   * @param originalParams - Optional original user parameters (for cache)
   * @param uploadedImages - Optional uploaded images (for cache)
   */
  private async submitImageTask(
    apiParams: any,
    originalParams?: ImageGenerationParams,
    uploadedImages?: any[],
  ): Promise<string> {
    const hasRefImage = !!(uploadedImages && uploadedImages.length > 0);
    const requestParams = this.httpClient.generateRequestParams(apiParams.model_name, hasRefImage);

    // 🔥 关键修复：继续生成必须重用原始请求参数
    const isContinuation =
      apiParams.history_id && CacheManager.has(apiParams.history_id);
    const requestBody = isContinuation
      ? this.buildContinuationRequest(apiParams)
      : this.buildInitialRequest(apiParams);

    const response = await this.httpClient.request({
      method: "POST",
      url: "/mweb/v1/aigc_draft/generate",
      params: requestParams,
      data: requestBody,
    });

    const historyId = response?.data?.aigc_data?.history_record_id;
    if (!historyId) {
      throw new Error(response?.errmsg || "提交图片任务失败");
    }

    // 🔥 使用CacheManager缓存首次请求的完整参数（用于继续生成）
    if (!apiParams.history_id && originalParams) {
      CacheManager.set(historyId, {
        historyId,
        params: originalParams,
        uploadedImages: uploadedImages || [],
        apiParams,
        requestBody: {
          submitId: requestBody.submit_id,
          draftContent: requestBody.draft_content,
          metricsExtra: requestBody.metrics_extra,
          extend: requestBody.extend,
        },
        continuationSent: false,
      });
      logger.debug(`💾 [CacheManager] 已保存完整缓存, historyId: ${historyId}`);
    }

    return historyId;
  }

  /**
   * 构建初始请求参数（首次生成）
   *
   * [CONSTITUTION-EXCEPTION: Tech Debt] 提取自submitImageTask方法以降低复杂度
   * @param params - API parameters
   */
  private buildInitialRequest(params: any): any {
    const hasRefImages = !!(
      params.reference_images && params.reference_images.length > 0
    );
    const submitId = generateUuid();
    const componentId = generateUuid();

    const extend = {
      root_model: params.model_name,
    };

    // This is a telemetry attempt counter, NOT the number of output images.
    const metricsExtra = jsonEncode({
      generateCount: 1,
      promptSource: "custom",
      templateSource: "",
      lastRequestId: "",
      originRequestId: "",
    });

    const draftContent = jsonEncode({
      type: "draft",
      id: generateUuid(),
      min_version: params.draft_version || DRAFT_VERSION,
      min_features: [],
      is_from_tsn: true,
      version: "3.0.2",
      main_component_id: componentId,
      component_list: [
        {
          type: "image_base_component",
          id: componentId,
          min_version: hasRefImages
            ? "3.0.2"
            : params.draft_version || DRAFT_VERSION,
          generate_type: hasRefImages ? "blend" : "generate",
          aigc_mode: "workbench",
          abilities: {
            type: "",
            id: generateUuid(),
            ...this.buildAbilities(params, hasRefImages),
            // Matches the web text-to-image and reference-image converters.
            gen_option: {
              type: "",
              id: generateUuid(),
              generate_all: false,
              gen_count: params.count ?? 1,
            },
          },
        },
      ],
    });

    return {
      extend,
      submit_id: submitId,
      metrics_extra: metricsExtra,
      draft_content: draftContent,
      http_common_info: {
        aid: 513695,
      },
    };
  }

  /**
   * 构建继续生成请求参数
   *
   * [CONSTITUTION-EXCEPTION: Tech Debt] 提取自submitImageTask方法以降低复杂度
   */
  private buildContinuationRequest(params: any): any {
    const cacheEntry = CacheManager.get(params.history_id);
    if (!cacheEntry) {
      throw new Error(
        `Cache entry not found for history_id: ${params.history_id}`,
      );
    }

    const cached = cacheEntry.requestBody;
    logger.debug(
      `[继续生成] 重用原始请求参数, historyId: ${params.history_id}`,
    );

    // 继续生成直接使用原始的metrics_extra，不需要更新generateCount
    // 数量由原始 draft 的 gen_option.gen_count 限定，不从提示词推断
    const updatedMetricsExtra = cached.metricsExtra;

    return {
      extend: cached.extend,
      submit_id: cached.submitId, // ⚠️ 使用原始submit_id
      metrics_extra: updatedMetricsExtra, // ⚠️ 使用更新后的metrics_extra
      draft_content: cached.draftContent, // ⚠️ 使用原始draft_content
      http_common_info: {
        aid: 513695,
      },
      action: CONTINUATION_ACTION.CONTINUE, // ✅ 继续生成标识
      history_id: params.history_id, // ✅ 原始任务ID
    };
  }

  /**
   * 构建abilities结构
   */
  private buildAbilities(params: any, hasRefImages: boolean): any {
    const {
      prompt,
      model_name,
      aspect_ratio,
      resolution = '2k',
      negative_prompt,
      reference_images,
    } = params;

    // 使用ImageDimensionCalculator获取正确的尺寸和imageRatio（支持2k/4k分辨率）
    const dimensions = ImageDimensionCalculator.calculateDimensions(
      aspect_ratio || "auto",
      undefined,
      undefined,
      resolution,
    );
    const aspectRatioPreset = ImageDimensionCalculator.getAspectRatioPreset(
      aspect_ratio || "auto",
      resolution,
    );
    const imageRatio = aspectRatioPreset?.imageRatio || 1; // 默认1:1的imageRatio

    if (hasRefImages) {
      // blend模式（与旧代码完全一致）
      const promptPrefix = reference_images.length === 1 ? "##" : "####";

      const blendData: any = {
        type: "",
        id: generateUuid(),
        blend: {
          type: "",
          id: generateUuid(),
          min_features: [],
          core_param: {
            type: "",
            id: generateUuid(),
            model: model_name,
            prompt: promptPrefix + prompt,
            sample_strength: params.sample_strength || 0.5,
            image_ratio: imageRatio,
            intelligent_ratio: false, // Match cURL
            large_image_info: {
              type: "",
              id: generateUuid(),
              height: dimensions.height,
              width: dimensions.width,
              resolution_type: resolution, // Match cURL '2k' or '4k'
            },
          },
          ability_list: reference_images.map((ref: any, index: number) => ({
            type: "",
            id: generateUuid(),
            name: "byte_edit",
            image_uri_list: [ref.uri],
            image_list: [
              {
                type: "image",
                id: generateUuid(),
                source_from: "upload",
                platform_type: 1,
                name: "",
                image_uri: ref.uri,
                width: ref.width,
                height: ref.height,
                format: ref.format,
                uri: ref.uri,
              },
            ],
            strength: ref.strength,
          })),
          prompt_placeholder_info_list: reference_images.map(
            (_: any, index: number) => ({
              type: "",
              id: generateUuid(),
              ability_index: index,
            }),
          ),
          postedit_param: {
            type: "",
            id: generateUuid(),
            generate_type: 0,
          },
        },
      };

      // 多参考图需要添加 min_version
      if (reference_images.length > 1) {
        blendData.blend.min_version = "3.2.9";
      }

      return blendData;
    } else {
      // generate模式（与旧代码完全一致）
      return {
        type: "",
        id: generateUuid(),
        generate: {
          type: "",
          id: generateUuid(),
          core_param: {
            type: "",
            id: generateUuid(),
            model: model_name,
            prompt: prompt,
            negative_prompt: negative_prompt || "",
            seed: Math.floor(Math.random() * 100000000) + 2500000000,
            sample_strength: params.sample_strength || 0.5,
            image_ratio: imageRatio,
            intelligent_ratio: false, // Match cURL
            large_image_info: {
              type: "",
              id: generateUuid(),
              height: dimensions.height,
              width: dimensions.width,
              resolution_type: resolution, // Match cURL '2k' or '4k'
            },
          },
          history_option: {
            type: "",
            id: generateUuid(),
          },
        },
      };
    }
  }

  /**
   * 等待图片生成完成
   * 注意：缓存清理延迟到 generateImage 末尾，以支持手动继续生成
   *
   * @returns { imageUrls, totalCount, isPartial }
   *   - imageUrls: 已生成的图片URL数组
   *   - totalCount: API返回的总目标数量
   *   - isPartial: 是否为部分完成（需要继续生成）
   */
  private async waitForImageCompletion(historyId: string): Promise<{
    imageUrls: string[];
    totalCount?: number;
    isPartial: boolean;
  }> {
    let attempts = 0;

    while (attempts < POLLING.MAX_ATTEMPTS) {
      const result = await this.getImageResult(historyId);

      if (
        result.status === "completed" &&
        result.imageUrls &&
        result.imageUrls.length > 0
      ) {
        return {
          imageUrls: result.imageUrls,
          totalCount: result.totalCount,
          isPartial: false,
        };
      }

      // 🔥 检测部分完成场景（继续生成场景）
      // 当totalCount>4且finishedCount===4时，API不会返回completed
      // 但已有4张图片可以返回，让手动继续生成接管
      if (
        result.totalCount &&
        result.finishedCount &&
        result.totalCount > MAX_IMAGES_PER_REQUEST &&
        result.finishedCount === MAX_IMAGES_PER_REQUEST &&
        result.imageUrls &&
        result.imageUrls.length > 0
      ) {
        logger.debug(
          `[部分完成] 检测到继续生成场景: total=${result.totalCount}, finished=${result.finishedCount}, 返回${result.imageUrls.length}张图片，标记为部分完成`,
        );
        return {
          imageUrls: result.imageUrls,
          totalCount: result.totalCount,
          isPartial: true,
        };
      }

      if (result.status === "failed") {
        throw new Error(result.error || "图片生成失败");
      }

      await this.sleep(POLLING.INTERVAL_MS);
      attempts++;
    }

    throw new Error(`图片生成超时: historyId=${historyId}`);
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 验证并过滤frames数组（与旧代码一致）
   */
  private validateAndFilterFrames(frames?: string[]): string[] {
    if (!frames || !Array.isArray(frames)) {
      return [];
    }

    // 过滤无效元素
    const valid = frames
      .filter((f) => f != null && typeof f === "string" && f.trim() !== "")
      .map((f) => f.trim());

    if (valid.length > MAX_IMAGE_COUNT) {
      throw new Error(`frames 最多 ${MAX_IMAGE_COUNT} 张；请显式拆分任务`);
    }

    return valid;
  }

  /**
   * 构建包含frames的最终prompt（与旧代码一致）
   */
  private buildPromptWithFrames(basePrompt: string, frames: string[]): string {
    if (frames.length === 0) {
      return basePrompt;
    }

    // 给每个frame加上序号
    const numberedFrames = frames.map(
      (frame, index) => `第${index + 1}张：${frame}`,
    );
    const framesText = numberedFrames.join(" ");
    // 使用frames的数量，而不是count参数
    return `${basePrompt} ${framesText}，一共${frames.length}张图`;
  }

  /**
   * 获取refresh token
   */
  getRefreshToken(): string {
    return this.httpClient.getRefreshToken();
  }
}
