/**
 * 认证相关工具函数
 * 从api.ts中提取的认证和Cookie生成功能
 */

import * as crypto from 'crypto';
import { generateMsToken, toUrlParams, generateUuid, jsonEncode, urlEncode, unixTimestamp } from './index.js';
// @ts-ignore
import crc32 from 'crc32';
import { generate_a_bogus } from './a_bogus.js';

/**
 * 生成Cookie字符串
 * @param refreshToken 刷新令牌
 * @returns Cookie字符串
 */
export function generateCookie(refreshToken: string): string {
  const sessionid = refreshToken.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionid)) {
    throw new Error('sessionid 格式无效：请仅提供 Cookie 中 sessionid 的值');
  }
  // 仅使用当前调用者的登录态，不混入其他账号的固定 Cookie。
  return `sessionid=${sessionid}; sessionid_ss=${sessionid}; sid_tt=${sessionid}`;
}

/**
 * 生成随机字符串
 */
export function generateRandomString(length: number): string {
  const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

/**
 * 添加请求头
 */
export function addHeaders(headers: Record<string, any>, addedHeaders: Record<string, any>): Record<string, any> {
  return { ...headers, ...addedHeaders };
}

/**
 * 生成认证信息和请求头
 */
export async function generateAuthorizationAndHeader(
  method: string,
  uri: string,
  params?: Record<string, any>,
  data?: Record<string, any>
): Promise<Record<string, any>> {
  const timestamp = unixTimestamp();
  
  const requestHeaders = {
    'Host': 'imagex.bytedanceapi.com',
    'Authorization': await generateAuthorization(method, uri, params, data, timestamp),
    'X-Date': timestamp,
    'Content-Type': 'application/json'
  };

  return requestHeaders;
}

/**
 * 生成Authorization头
 */
async function generateAuthorization(
  method: string,
  uri: string,
  params?: Record<string, any>,
  data?: Record<string, any>,
  timestamp?: number
): Promise<string> {
  timestamp = timestamp || unixTimestamp();
  
  const accessKey = ""; // 需要从环境变量获取
  const secretKey = ""; // 需要从环境变量获取
  
  const credString = credentialString(timestamp);
  const signedHeaders = generateSignedHeaders({});
  const canonString = canonicalString(method, uri, params || {}, {}, signedHeaders);
  const signingKey = await generateSigningKey(secretKey, credString);
  const sig = await signature(canonString, signingKey);

  return `HMAC-SHA256 Credential=${accessKey}/${credString}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
}

/**
 * 生成credential字符串
 */
function credentialString(timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().split('T')[0].replace(/-/g, '');
  return `${date}/cn-north-1/imagex/request`;
}

/**
 * HTTP查询字符串构建
 */
function httpBuildQuery(params: any): string {
  return Object.keys(params)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
}

/**
 * 生成签名头列表
 */
function generateSignedHeaders(requestHeaders: any): string {
  const headers = Object.keys(requestHeaders).map(h => h.toLowerCase()).sort();
  return headers.join(';');
}

/**
 * 生成规范字符串
 */
function canonicalString(
  method: string,
  uri: string,
  params: Record<string, any>,
  requestHeaders: Record<string, any>,
  signedHeaders: string
): string {
  const lines = [
    method.toUpperCase(),
    uri,
    httpBuildQuery(params),
    Object.keys(requestHeaders)
      .sort()
      .map(key => `${key.toLowerCase()}:${requestHeaders[key]}`)
      .join('\n'),
    '',
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ];
  
  return lines.join('\n');
}

/**
 * 生成签名密钥
 */
async function generateSigningKey(secretKey: string, credString: string): Promise<Buffer> {
  const parts = credString.split('/');
  const date = parts[0];
  const region = parts[1];
  const service = parts[2];
  
  const kDate = crypto.createHmac('sha256', secretKey).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
  
  return kSigning;
}

/**
 * 生成签名
 */
async function signature(canonString: string, signingKey: Buffer): Promise<string> {
  const hash = crypto.createHash('sha256').update(canonString).digest('hex');
  const stringToSign = `HMAC-SHA256\n${unixTimestamp()}\n${credentialString(unixTimestamp())}\n${hash}`;
  
  return crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}
