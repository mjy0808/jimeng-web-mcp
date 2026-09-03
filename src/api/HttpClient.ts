/**
 * HttpClient - HTTP请求客户端
 * 整合auth.ts和a_bogus.ts中的认证逻辑
 * 提供统一的HTTP请求接口
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { generateCookie } from '../utils/auth.js';
import { DEFAULT_ASSISTANT_ID, UA, WEB_ID } from '../types/models.js';
import { generateUuid, jsonEncode, toUrlParams, generateMsToken, unixTimestamp } from '../utils/index.js';
import { generate_a_bogus } from '../utils/a_bogus.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

export interface RequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: any;
  headers?: Record<string, string>;
  params?: Record<string, any>;
  timeout?: number;
}

export interface AuthParams {
  timestamp: number;
  nonce: string;
  path: string;
}

/**
 * HttpClient类
 * 使用组合模式，独立于继承体系
 */
export class HttpClient {
  private refreshToken: string;

  constructor(token?: string) {
    this.refreshToken = token || process.env.JIMENG_API_TOKEN || '';
    if (!this.refreshToken) {
      throw new Error('JIMENG_API_TOKEN 环境变量未设置');
    }
  }

  /**
   * 生成请求签名
   * 根据DevTools验证的签名算法：MD5("9e2c|{uri最后7字符}|7|8.4.0|{时间戳}||11ac")
   * Appvr请求头和sign计算都使用8.4.0版本
   */
  private generateSign(uri: string, deviceTime: number): string {
    const PLATFORM_CODE = "7";
    const VERSION_CODE = "8.4.0";  // DevTools验证：浏览器使用8.4.0计算sign
    const PREFIX = "9e2c";
    const SUFFIX = "11ac";

    // 获取URI的最后7个字符
    const uriSuffix = uri.slice(-7);

    // 构建签名字符串: 9e2c|{uri最后7字符}|7|8.4.0|{时间戳}||11ac
    const signString = `${PREFIX}|${uriSuffix}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||${SUFFIX}`;

    // MD5哈希
    const sign = crypto.createHash('md5').update(signString).digest('hex');

    logger.debug(`[HttpClient] Sign string: ${signString} => ${sign}`);

    return sign;
  }

  /**
   * 执行HTTP请求
   */
  async request<T = any>(options: RequestOptions): Promise<T> {
    const {
      url,
      method = 'POST',
      data = {},
      headers = {},
      params = {},
      timeout = 120000 // 增加超时时间到120秒
    } = options;

    const baseUrl = 'https://jimeng.jianying.com';
    const fullUrl = url.includes('https://') ? url : `${baseUrl}${url}`;

    // 提取URI路径用于签名计算
    const uri = url.startsWith('/') ? url : new URL(fullUrl).pathname;

    // 生成设备时间戳和签名
    const deviceTime = Math.floor(Date.now() / 1000);
    const sign = this.generateSign(uri, deviceTime);

    const FAKE_HEADERS = {
      Accept: "application/json, text/plain, */*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-language": "zh-CN,zh;q=0.9",
      "Cache-control": "no-cache",
      "Content-Type": "application/json",
      Appid: DEFAULT_ASSISTANT_ID,
      Appvr: "8.4.0",  // DevTools抓取的版本，sign仍使用5.8.0
      "device-time": deviceTime.toString(),
      "sign-ver": "1",
      sign: sign,  // 添加sign签名头
      loc: "cn",
      "app-sdk-version": "48.0.0",
      tdid: "",
      lan: "zh-Hans",
      Origin: "https://jimeng.jianying.com",
      Pragma: "no-cache",
      Priority: "u=1, i",
      Referer: "https://jimeng.jianying.com",
      Pf: "7",
      "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": UA
    };

    const requestHeaders = {
      ...FAKE_HEADERS,
      ...(new URL(fullUrl).origin === baseUrl ? { Cookie: generateCookie(this.refreshToken) } : {}),
      ...headers
    };

    logger.debug(`[HttpClient] Request: ${method} ${fullUrl}`);

    try {
      const response: AxiosResponse<T> = await axios({
        method: method.toLowerCase(),
        url: fullUrl,
        data: method.toUpperCase() !== 'GET' ? data : undefined,
        params: method.toUpperCase() === 'GET' ? { ...data, ...params } : params,
        headers: requestHeaders,
        // The web endpoints have IPv4. Avoid a stalled IPv6 route in Node's
        // HTTP adapter (reproduced on macOS/Node 26; fetch raced successfully).
        family: 4,
        timeout,
        maxRedirects: 0
      });

      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError);
    }
  }

  /**
   * 生成请求认证参数（用于图片上传等）
   * @param model - 可选模型名称，用于babi_param
   * @param hasRefImage - 是否有参考图，用于babi_param
   */
  generateRequestParams(model?: string, hasRefImage?: boolean): any {
    const actualModel = model || 'jimeng-4.0';

    // 构建babi_param（参考jimeng-free-api-all）
    const babiParam = {
      "scenario": "image_video_generation",
      "feature_key": hasRefImage ? "to_image_referenceimage_generate" : "aigc_to_image",
      "feature_entrance": "to_image",
      "feature_entrance_detail": hasRefImage
        ? "to_image-referenceimage-byte_edit"
        : `to_image-${actualModel}`,
    };

    // 完全按照jimeng-free-api-all的简化参数结构
    const rqParams: any = {
      "aid": parseInt("513695"),
      "device_platform": "web",
      "region": "CN",  // 注意大写
      "web_id": WEB_ID,  // 注意是web_id不是webId
      "babi_param": encodeURIComponent(JSON.stringify(babiParam)),
    };

    return rqParams;
  }

  /**
   * 生成认证头和签名（用于ImageX API）
   */
  async generateAuthorizationAndHeader(
    accessKeyId: string,
    secretAccessKey: string,
    sessionToken: string,
    region: string,
    service: string,
    method: string,
    params?: Record<string, any>,
    data?: Record<string, any>
  ): Promise<Record<string, string>> {
    // 生成ISO 8601格式的时间戳
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const uri = '/';

    // 计算Body SHA256
    const bodyHash = data && Object.keys(data).length > 0 ?
      crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex') :
      crypto.createHash('sha256').update('').digest('hex');

    // 计算请求签名
    const authorization = await this.generateAuthorization(
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
      service,
      method,
      uri,
      params,
      data,
      timestamp
    );

    return {
      'X-Amz-Date': timestamp,
      'X-Amz-Security-Token': sessionToken,
      'X-Amz-Content-Sha256': bodyHash,
      'Authorization': authorization
    };
  }

  /**
   * 生成Authorization签名（完整AWS4-HMAC-SHA256算法）
   */
  private async generateAuthorization(
    accessKeyId: string,
    secretAccessKey: string,
    sessionToken: string,
    region: string,
    service: string,
    method: string,
    uri: string,
    params?: Record<string, any>,
    data?: Record<string, any>,
    timestamp?: string
  ): Promise<string> {
    const amzDate = timestamp || new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const amzDay = amzDate.substring(0, 8);

    // 构建请求头（包含所有需要签名的header）
    const requestHeaders: Record<string, string> = {
      'x-amz-date': amzDate,
      'x-amz-security-token': sessionToken,
    };

    if (data && Object.keys(data).length > 0) {
      requestHeaders['x-amz-content-sha256'] = crypto
        .createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex');
    }

    // 1. 生成 Canonical Request
    const canonicalQueryString = params ? this.httpBuildQuery(params) : '';
    const canonicalHeaders = this.buildCanonicalHeaders(requestHeaders);
    const signedHeaders = this.buildSignedHeaders(requestHeaders);
    const bodyHash = data && Object.keys(data).length > 0 ?
      crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex') :
      crypto.createHash('sha256').update('').digest('hex');

    const canonicalRequest = [
      method.toUpperCase(),
      uri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      bodyHash
    ].join('\n');

    // 2. 生成 String To Sign
    const credentialScope = `${amzDay}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    ].join('\n');

    // 3. 计算签名
    const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(amzDay).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const signingKey = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    // 4. 构建 Authorization Header
    const authorizationParams = [
      'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + credentialScope,
      'SignedHeaders=' + signedHeaders,
      'Signature=' + signature
    ];

    return authorizationParams.join(', ');
  }

  /**
   * 构建规范化的请求头字符串
   */
  private buildCanonicalHeaders(headers: Record<string, string>): string {
    const headerKeys = Object.keys(headers).sort();
    const canonicalHeaders: string[] = [];

    for (const key of headerKeys) {
      canonicalHeaders.push(key.toLowerCase() + ':' + headers[key]);
    }

    return canonicalHeaders.join('\n') + '\n';
  }

  /**
   * 构建已签名的请求头列表
   */
  private buildSignedHeaders(headers: Record<string, string>): string {
    const headerKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    return headerKeys.join(';');
  }

  /**
   * HTTP查询字符串构建
   */
  httpBuildQuery(params: Record<string, any>): string {
    return Object.keys(params)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');
  }

  /**
   * 生成随机字符串
   */
  generateRandomString(length: number): string {
    const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  /**
   * 获取refresh token
   */
  getRefreshToken(): string {
    return this.refreshToken;
  }

  /**
   * 统一错误处理
   */
  private handleError(error: AxiosError): never {
    if (error.response) {
      throw new Error(`即梦API请求错误: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      throw new Error(`即梦网络连接失败 (${error.code ?? 'NO_RESPONSE'})；查询原任务，不要重复提交`);
    } else {
      throw new Error(`即梦API请求失败: ${error.message}`);
    }
  }
}
