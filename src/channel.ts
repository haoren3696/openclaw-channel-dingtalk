import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import FormData from 'form-data';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { buildChannelConfigSchema } from 'openclaw/plugin-sdk';
import { cleanupOrphanedTempFiles, retryWithBackoff, createLoggerWithLocation } from '../utils';
import { getDingTalkRuntime } from './runtime';
import { DingTalkConfigSchema } from './config-schema.js';
import type {
  DingTalkConfig,
  TokenInfo,
  DingTalkInboundMessage,
  MessageContent,
  RichTextContent,
  RichTextMediaFile,
  MergedMessageEntry,
  SendMessageOptions,
  SessionMediaFile,
  HandleDingTalkMessageParams,
  ProactiveMessagePayload,
  SessionWebhookResponse,
  AxiosResponse,
  Logger,
  GatewayStartContext,
  GatewayStopResult,
  InteractiveCardData,
  InteractiveCardSendRequest,
  InteractiveCardUpdateRequest,
  CardInstance,
  MediaUploadResponse,
  FileMessageWebhookResponse,
} from './types';

// Access Token cache
let accessToken: string | null = null;
let accessTokenExpiry = 0;

// Card instance cache for streaming updates
const cardInstances = new Map<string, CardInstance>();

// Card update throttling - track last update time per card
const cardUpdateTimestamps = new Map<string, number>();
const CARD_UPDATE_MIN_INTERVAL = 500; // Minimum 500ms between updates

// Card update timeout tracking - auto-finalize if no updates for a while
const cardUpdateTimeouts = new Map<string, NodeJS.Timeout>();
const CARD_UPDATE_TIMEOUT = 60000; // 60 seconds of inactivity = finalized

// Card cache TTL (1 hour)
const CARD_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Message merge cache for batch processing
const messageMergeCache = new Map<string, MergedMessageEntry>();
const MESSAGE_MERGE_WINDOW_MS = 2000; // 2 seconds merge window
const MESSAGE_MERGE_MAX_MESSAGES = 5; // Max 5 messages per merge

// Periodic cleanup of stale merge cache entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  // Clean up entries older than 10 seconds (buffer beyond 2s window)
  messageMergeCache.forEach((entry, key) => {
    // Clean up entries older than 10 seconds (5s buffer beyond 2s window + 3s processing)
    if (now - entry.startTime > 10000) {
      clearTimeout(entry.timer);
      messageMergeCache.delete(key);
      cleaned++;
    }
  });
  if (cleaned > 0) {
    console.log(`[DingTalk] Cleaned up ${cleaned} stale merge cache entries`);
  }
}, 300000);

// Authorization helpers
type NormalizedAllowFrom = {
  entries: string[];
  entriesLower: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

/**
 * Normalize allowFrom list to standardized format
 */
function normalizeAllowFrom(list?: Array<string>): NormalizedAllowFrom {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes('*');
  const normalized = entries
    .filter((value) => value !== '*')
    .map((value) => value.replace(/^(dingtalk|dd|ding):/i, ''));
  const normalizedLower = normalized.map((value) => value.toLowerCase());
  return {
    entries: normalized,
    entriesLower: normalizedLower,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
}

/**
 * Check if sender is allowed based on allowFrom list
 */
function isSenderAllowed(params: { allow: NormalizedAllowFrom; senderId?: string }): boolean {
  const { allow, senderId } = params;
  if (!allow.hasEntries) return true;
  if (allow.hasWildcard) return true;
  if (senderId && allow.entriesLower.includes(senderId.toLowerCase())) return true;
  return false;
}

// Clean up old card instances from cache
function cleanupCardCache() {
  const now = Date.now();
  for (const [cardBizId, instance] of cardInstances.entries()) {
    if (now - instance.lastUpdated > CARD_CACHE_TTL) {
      cardInstances.delete(cardBizId);
      cardUpdateTimestamps.delete(cardBizId);
      const timeout = cardUpdateTimeouts.get(cardBizId);
      if (timeout) {
        clearTimeout(timeout);
        cardUpdateTimeouts.delete(cardBizId);
      }
    }
  }
}

// Run cleanup periodically (every 30 minutes)
let cleanupIntervalId: NodeJS.Timeout | null = setInterval(cleanupCardCache, 30 * 60 * 1000);

// Cleanup function to stop the interval
function stopCardCacheCleanup() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  // Clear all pending timeouts
  for (const timeout of cardUpdateTimeouts.values()) {
    clearTimeout(timeout);
  }
  cardUpdateTimeouts.clear();
}

// Helper function to detect markdown and extract title
function detectMarkdownAndExtractTitle(
  text: string,
  options: SendMessageOptions,
  defaultTitle: string
): { useMarkdown: boolean; title: string } {
  const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes('\n');
  const useMarkdown = options.useMarkdown !== false && (options.useMarkdown || hasMarkdown);

  const title =
    options.title ||
    (useMarkdown
      ? text
          .split('\n')[0]
          .replace(/^[#*\s\->]+/, '')
          .slice(0, 20) || defaultTitle
      : defaultTitle);

  return { useMarkdown, title };
}

function getConfig(cfg: OpenClawConfig, accountId?: string): DingTalkConfig {
  const dingtalkCfg = cfg?.channels?.dingtalk;
  if (!dingtalkCfg) return {} as DingTalkConfig;

  if (accountId && dingtalkCfg.accounts?.[accountId]) {
    return dingtalkCfg.accounts[accountId];
  }

  return dingtalkCfg;
}

function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const config = getConfig(cfg, accountId);
  return Boolean(config.clientId && config.clientSecret);
}

// Get Access Token with retry logic
async function getAccessToken(config: DingTalkConfig, log?: Logger): Promise<string> {
  const now = Date.now();
  if (accessToken && accessTokenExpiry > now + 60000) {
    log?.debug?.(`[DingTalk] Using cached access token (expires at: ${new Date(accessTokenExpiry).toISOString()})`);
    return accessToken;
  }

  log?.info?.(`[DingTalk] Requesting new access token - clientId: ${config.clientId?.substring(0, 8)}...`);
  log?.debug?.(`[DingTalk] Access token URL: https://api.dingtalk.com/v1.0/oauth2/accessToken`);

  const token = await retryWithBackoff(
    async () => {
      const response = await axios.post<TokenInfo>('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        appKey: config.clientId,
        appSecret: config.clientSecret,
      });

      log?.debug?.(`[DingTalk] Access token response - expireIn: ${response.data.expireIn} seconds`);

      accessToken = response.data.accessToken;
      accessTokenExpiry = now + response.data.expireIn * 1000;
      log?.info?.(`[DingTalk] New access token obtained, expires at: ${new Date(accessTokenExpiry).toISOString()}`);

      return accessToken;
    },
    { maxRetries: 3, log }
  );

  return token;
}

// Send proactive message via DingTalk OpenAPI
async function sendProactiveMessage(
  config: DingTalkConfig,
  target: string,
  text: string,
  log?: Logger
): Promise<AxiosResponse>;
async function sendProactiveMessage(
  config: DingTalkConfig,
  target: string,
  text: string,
  options?: SendMessageOptions
): Promise<AxiosResponse>;
async function sendProactiveMessage(
  config: DingTalkConfig,
  target: string,
  text: string,
  optionsOrLog: SendMessageOptions | Logger | undefined = {} as SendMessageOptions
): Promise<AxiosResponse> {
  // Handle backward compatibility: support both Logger and SendMessageOptions
  let options: SendMessageOptions;
  if (!optionsOrLog) {
    options = {};
  } else if (
    typeof optionsOrLog === 'object' &&
    optionsOrLog !== null &&
    ('log' in optionsOrLog || 'useMarkdown' in optionsOrLog || 'title' in optionsOrLog || 'atUserId' in optionsOrLog)
  ) {
    options = optionsOrLog;
  } else {
    // Assume it's a Logger object
    options = { log: optionsOrLog as Logger };
  }

  const token = await getAccessToken(config, options.log);
  const isGroup = target.startsWith('cid');

  const url = isGroup
    ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
    : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

  // Use shared helper function for markdown detection and title extraction
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 提醒');

  // Choose msgKey based on whether we're sending markdown or plain text
  // Note: DingTalk's proactive message API uses predefined message templates
  // sampleMarkdown supports markdown formatting, sampleText for plain text
  const msgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText';

  const payload: ProactiveMessagePayload = {
    robotCode: config.robotCode || config.clientId,
    msgKey,
    msgParam: JSON.stringify({
      title,
      text,
    }),
  };

  if (isGroup) {
    payload.openConversationId = target;
  } else {
    payload.userIds = [target];
  }

  const result = await axios({
    url,
    method: 'POST',
    data: payload,
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
  });
  return result.data;
}

/**
 * 文件名安全化处理
 * 移除危险字符，保留合法文件名
 */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[\\/:*?"<>|]/g, '_').substring(0, 255);
}

/**
 * 清理会话中过期的媒体文件
 * 保留时间 = 会话超时时间 × 2
 * 仅清理当前会话的文件，不限制文件数量
 */
function cleanupSessionMedia(storePath: string, sessionKey: string, sessionTimeout: number, log?: Logger): void {
  const mediaDir = path.join(storePath, 'sessions', sessionKey, 'media');

  if (!fs.existsSync(mediaDir)) {
    return;
  }

  const retentionTime = sessionTimeout * 2;
  const cutoffTime = Date.now() - retentionTime;
  let cleanedCount = 0;

  try {
    const files = fs.readdirSync(mediaDir);

    for (const fileName of files) {
      const filePath = path.join(mediaDir, fileName);

      try {
        const stats = fs.statSync(filePath);
        const fileTime = stats.mtime.getTime();

        if (fileTime < cutoffTime) {
          fs.unlinkSync(filePath);
          cleanedCount++;
          log?.info?.(`[DingTalk] Cleaned up expired media file: ${fileName}`);
        }
      } catch (err: any) {
        log?.info?.(`[DingTalk] Failed to cleanup file ${fileName}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      log?.info?.(
        `[DingTalk] Media cleanup completed - removed ${cleanedCount} expired file(s) from session ${sessionKey}`
      );
    }
  } catch (err: any) {
    log?.info?.(`[DingTalk] Failed to cleanup session media: ${err.message}`);
  }
}

// Internal function to attempt a single download
async function attemptSingleDownload(
  config: DingTalkConfig,
  downloadCode: string,
  sessionKey: string,
  storePath: string,
  originalFileName: string,
  msgId: string,
  log?: Logger,
  isRetry: boolean = false
): Promise<SessionMediaFile | null> {
  if (!config.robotCode) {
    log?.info?.('[DingTalk] downloadMedia requires robotCode to be configured.');
    return null;
  }

  try {
    const token = await getAccessToken(config, log);

    // DEBUG: Log request details
    const attemptLabel = isRetry ? '[RETRY]' : '[PRIMARY]';
    log?.info?.(`[DingTalk] [DEBUG] Download media request ${attemptLabel}:`);
    log?.info?.(`[DingTalk] [DEBUG] - API URL: https://api.dingtalk.com/v1.0/robot/messageFiles/download`);
    log?.info?.(
      `[DingTalk] [DEBUG] - downloadCode: ${downloadCode.substring(0, 20)}... (${downloadCode.length} chars)`
    );
    log?.info?.(
      `[DingTalk] [DEBUG] - robotCode: ${config.robotCode ? config.robotCode.substring(0, 10) + '...' : 'NOT SET'}`
    );
    log?.info?.(`[DingTalk] [DEBUG] - sessionKey: ${sessionKey}`);
    log?.info?.(`[DingTalk] [DEBUG] - originalFileName: ${originalFileName}`);
    log?.info?.(`[DingTalk] [DEBUG] - Has access token: ${!!token}`);

    const response = await axios.post<{ downloadUrl?: string }>(
      'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
      { downloadCode, robotCode: config.robotCode },
      { headers: { 'x-acs-dingtalk-access-token': token } }
    );

    // DEBUG: Log response details
    log?.info?.(`[DingTalk] [DEBUG] Download media response ${attemptLabel} - status: ${response.status}`);
    log?.info?.(`[DingTalk] [DEBUG] Response data keys: ${Object.keys(response.data || {}).join(', ')}`);

    const downloadUrl = response.data?.downloadUrl;
    if (!downloadUrl) {
      log?.info?.(
        `[DingTalk] [DEBUG] No downloadUrl in response ${attemptLabel}. Full response: ${JSON.stringify(response.data)}`
      );
      return null;
    }

    log?.info?.(`[DingTalk] [DEBUG] Got downloadUrl ${attemptLabel}: ${downloadUrl.substring(0, 50)}...`);

    const mediaResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });

    const contentType = mediaResponse.headers['content-type'] || 'application/octet-stream';

    // 构建会话媒体目录路径
    const storeDir = path.dirname(storePath);
    const mediaDir = path.join(storeDir, 'media');
    let filePath: string;
    let isFallback = false;

    // 尝试创建会话目录，失败则回退到临时目录
    try {
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
        log?.info?.(`[DingTalk] Created session media directory: ${mediaDir}`);
      }

      // 使用原始文件名（同名直接覆盖）
      const safeFileName = sanitizeFileName(originalFileName);
      filePath = path.join(mediaDir, safeFileName);
      isFallback = false;
    } catch (dirErr: any) {
      // 目录创建失败，回退到临时目录
      log?.info?.(`[DingTalk] Failed to create session directory, falling back to temp: ${dirErr.message}`);
      // 使用原始文件名（确保已清理）
      const safeFileName = sanitizeFileName(originalFileName);
      filePath = path.join(os.tmpdir(), safeFileName);
      isFallback = true;
    }

    // 写入文件
    fs.writeFileSync(filePath, Buffer.from(mediaResponse.data as ArrayBuffer));

    // 计算过期时间：会话超时 × 2（默认值1小时，在调用处传入实际值）
    const sessionTimeout = 3600000; // 默认值
    const now = Date.now();

    log?.info?.(`[DingTalk] Media downloaded: ${filePath} (fallback: ${isFallback})`);

    return {
      path: filePath,
      mimeType: contentType,
      msgId,
      fileName: path.basename(filePath),
      downloadedAt: now,
      expiresAt: now + sessionTimeout * 2,
    };
  } catch (err: any) {
    // DEBUG: Enhanced error logging for HTTP 500
    const statusCode = err.response?.status;
    const responseData = err.response?.data;
    const errorCode = err.code;

    log?.info?.(`[DingTalk] [DEBUG] Download media FAILED:`);
    log?.info?.(`[DingTalk] [DEBUG] - Error message: ${err.message}`);
    log?.info?.(`[DingTalk] [DEBUG] - HTTP status: ${statusCode || 'N/A'}`);
    log?.info?.(`[DingTalk] [DEBUG] - Error code: ${errorCode || 'N/A'}`);
    log?.info?.(`[DingTalk] [DEBUG] - Response data: ${JSON.stringify(responseData) || 'N/A'}`);
    log?.info?.(
      `[DingTalk] [DEBUG] - Request config: ${JSON.stringify({
        url: err.config?.url,
        method: err.config?.method,
        hasToken: !!err.config?.headers?.['x-acs-dingtalk-access-token'],
      })}`
    );

    if (statusCode === 500) {
      log?.info?.(`[DingTalk] [DEBUG] HTTP 500 error - This usually means the downloadCode is expired or invalid`);
      log?.info?.(
        `[DingTalk] [DEBUG] Download code age: Code was generated when message was received, may have expired`
      );
    }

    log?.info?.(`[DingTalk] Failed to download media: ${err.message}`);
    return null;
  }
}

// Main download function
async function downloadMedia(
  config: DingTalkConfig,
  downloadCode: string,
  sessionKey: string,
  storePath: string,
  originalFileName: string,
  msgId: string,
  log?: Logger
): Promise<SessionMediaFile | null> {
  // Download with downloadCode
  log?.info?.(`[DingTalk] Starting media download...`);
  const result = await attemptSingleDownload(
    config,
    downloadCode,
    sessionKey,
    storePath,
    originalFileName,
    msgId,
    log,
    false
  );

  if (result) {
    log?.info?.(`[DingTalk] Media downloaded successfully`);
    return result;
  }

  log?.info?.(`[DingTalk] Download failed for code: ${downloadCode.substring(0, 20)}...`);
  return null;
}

// Upload media file to DingTalk
async function uploadMedia(
  config: DingTalkConfig,
  mediaPath: string,
  mediaType: string = 'file',
  log?: Logger
): Promise<MediaUploadResponse | null> {
  try {
    const fileName = path.basename(mediaPath);
    const fileExt = fileName.split('.').pop()?.toLowerCase() || '';

    let finalMediaType = mediaType;

    if (mediaType === 'file') {
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp'];
      const voiceExts = ['amr', 'mp3', 'wav'];
      const videoExts = ['mp4'];
      const fileExts = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'pdf', 'rar'];

      if (imageExts.includes(fileExt)) {
        finalMediaType = 'image';
      } else if (voiceExts.includes(fileExt)) {
        finalMediaType = 'voice';
      } else if (videoExts.includes(fileExt)) {
        finalMediaType = 'video';
      } else if (fileExts.includes(fileExt)) {
        finalMediaType = 'file';
      } else {
        finalMediaType = 'file';
      }
    }

    log?.debug?.(
      `[DingTalk] uploadMedia called - mediaPath: ${mediaPath}, mediaType: ${mediaType}, finalMediaType: ${finalMediaType}, fileExt: ${fileExt}`
    );

    const token = await getAccessToken(config, log);
    log?.debug?.(`[DingTalk] Access token obtained for media upload`);

    if (!fs.existsSync(mediaPath)) {
      if (log?.error) {
        log.error(`[DingTalk] File not found: ${mediaPath}`);
      }
      return null;
    }
    log?.debug?.(`[DingTalk] File exists: ${mediaPath}`);

    const fileStats = fs.statSync(mediaPath);
    const fileSize = fileStats.size;

    // 文件大小限制检查（根据钉钉API最新规范：2025年）
    const sizeLimits: Record<string, number> = {
      image: 2 * 1024 * 1024, // 2MB
      voice: 2 * 1024 * 1024, // 2MB
      video: 100 * 1024 * 1024, // 100MB
      file: 20 * 1024 * 1024, // 20MB
    };

    const limit = sizeLimits[finalMediaType] || 20 * 1024 * 1024;
    if (fileSize > limit) {
      log?.error?.(`[DingTalk] File size ${fileSize} bytes exceeds limit ${limit} bytes for type ${finalMediaType}`);
      return null;
    }

    log?.debug?.(`[DingTalk] File stats - fileName: ${fileName}, fileSize: ${fileSize} bytes, limit: ${limit} bytes`);

    // 钉钉最新API规范：使用 FormData 上传，字段名必须是 'media'
    const formData = new FormData();
    formData.append('media', fs.createReadStream(mediaPath), {
      filename: fileName,
      contentType: 'application/octet-stream',
    } as any);
    log?.debug?.(`[DingTalk] FormData created with media field`);

    // 钉钉最新API规范（2025年）：
    // - 使用 oapi.dingtalk.com 域名
    // - access_token 和 type 都在 query string 中
    // - 不要手动设置 Content-Type，让 axios 自动生成 boundary
    const uploadUrl = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${finalMediaType}`;
    log?.debug?.(`[DingTalk] Starting upload to: https://oapi.dingtalk.com/media/upload [with query params]`);

    const response = await axios.post<{
      media_id?: string;
      errcode?: number;
      errmsg?: string;
      type?: string;
      created_at?: number;
    }>(uploadUrl, formData, {
      // 不要手动设置 headers，让 axios 根据 FormData 自动生成 multipart/form-data 和 boundary
      maxBodyLength: Math.max(fileSize * 2, 100 * 1024), // 2倍文件大小或100KB，取较大值（小文件元数据可能很大）
      timeout: 120000, // 120秒超时，适应大文件上传
    });

    log?.debug?.(`[DingTalk] Upload response status: ${response.status}`);
    log?.debug?.(`[DingTalk] Upload response data: ${JSON.stringify(response.data)}`);

    // 钉钉API响应规范：errcode 为 0 表示成功
    if (response.data?.errcode === 0 && response.data?.media_id) {
      log?.info?.(
        `[DingTalk] File uploaded successfully - media_id: ${response.data.media_id}, type: ${response.data.type}`
      );
      return {
        mediaId: response.data.media_id,
        type: response.data.type || finalMediaType,
        createdAt: new Date((response.data.created_at || Date.now()) * 1000).toISOString(), // created_at 是秒级时间戳
      };
    }

    if (response.data?.errcode) {
      log?.error?.(`[DingTalk] Upload failed with errcode: ${response.data.errcode}, errmsg: ${response.data.errmsg}`);
    } else {
      log?.error?.(`[DingTalk] Upload response missing media_id - data: ${JSON.stringify(response.data)}`);
    }
    return null;
  } catch (err: any) {
    log?.error?.(`[DingTalk] Failed to upload media - message: ${err.message}`);
    log?.error?.(
      `[DingTalk] Upload error details: ${JSON.stringify({
        message: err.message,
        code: err.code,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
      })}`
    );
    if (log?.debug) {
      log.debug(`[DingTalk] Upload error stack: ${err.stack}`);
    }
    return null;
  }
}

function extractMessageContent(data: DingTalkInboundMessage): MessageContent | RichTextContent {
  const msgtype = data.msgtype || 'text';

  // 【调试日志】函数入口 - 显示完整输入数据
  console.log(`[DEBUG] extractMessageContent called with msgtype: ${msgtype}`);
  console.log(`[DEBUG] Full data object keys: ${Object.keys(data).join(', ')}`);
  console.log(`[DEBUG] data.content exists: ${!!data.content}`);
  if (data.content) {
    console.log(`[DEBUG] data.content keys: ${Object.keys(data.content).join(', ')}`);
    console.log(`[DEBUG] data.content.richText exists: ${!!data.content.richText}`);
    if (data.content.richText) {
      console.log(`[DEBUG] richText is array: ${Array.isArray(data.content.richText)}`);
      console.log(`[DEBUG] richText length: ${data.content.richText.length}`);
      console.log(`[DEBUG] richText full content: ${JSON.stringify(data.content.richText, null, 2)}`);
    }
  }

  // Logic for different message types
  if (msgtype === 'text') {
    console.log(`[DEBUG] Processing text message, content: ${data.text?.content}`);
    return { text: data.text?.content?.trim() || '', messageType: 'text' };
  }

  // Improved richText parsing: support text, at, image/picture, file, link components
  if (msgtype === 'richText') {
    console.log(`[DEBUG] Entering richText processing block`);
    const richTextParts = data.content?.richText || [];
    console.log(`[DEBUG] richTextParts assigned, length: ${richTextParts.length}`);

    let text = '';
    const mediaFiles: RichTextMediaFile[] = [];
    const componentCounts: Record<string, number> = {};

    console.log(`[DEBUG] Starting to process ${richTextParts.length} richText parts`);

    for (let i = 0; i < richTextParts.length; i++) {
      const part = richTextParts[i];
      console.log(`[DEBUG] Processing part ${i + 1}/${richTextParts.length}:`, JSON.stringify(part));

      // 如果没有 type 字段但有 text 字段，默认为 text 类型
      let partType = part.type;
      if (!partType && part.text !== undefined) {
        partType = 'text';
      }
      partType = partType || 'unknown';

      componentCounts[partType] = (componentCounts[partType] || 0) + 1;

      console.log(`[DEBUG] Part ${i + 1} type: ${partType}`);
      console.log(`[DEBUG] Part ${i + 1} keys: ${Object.keys(part).join(', ')}`);

      switch (partType) {
        case 'text':
          console.log(`[DEBUG] Processing text component, text value: "${part.text}"`);
          if (part.text) {
            text += part.text;
            console.log(`[DEBUG] Text appended, current text length: ${text.length}`);
          } else {
            console.log(`[DEBUG] Text component has no text value`);
          }
          break;

        case 'at':
          console.log(`[DEBUG] Processing at component, atName: "${part.atName}", atUserId: "${part.atUserId}"`);
          if (part.atName) {
            text += `@${part.atName} `;
            console.log(`[DEBUG] At appended, current text: "${text}"`);
          }
          break;

        case 'picture': {
          // 直接使用 downloadCode 下载图片，弃用 pictureDownloadCode
          console.log(`[DEBUG] Processing picture component, downloadCode: "${part.downloadCode}"`);

          if (part.downloadCode) {
            text += '[图片] ';
            mediaFiles.push({
              downloadCode: part.downloadCode,
              fileName: part.fileName || `image_${mediaFiles.length + 1}`,
              type: 'image',
            });
            console.log(`[DEBUG] Picture added with downloadCode`);
            console.log(`[DEBUG] Total media files: ${mediaFiles.length}`);
          } else {
            console.log(`[DEBUG] Picture component has no downloadCode`);
          }
          break;
        }

        case 'image':
          // 兼容旧格式，使用 downloadCode
          console.log(
            `[DEBUG] Processing image component, downloadCode: "${part.downloadCode}", fileName: "${part.fileName}"`
          );
          if (part.downloadCode) {
            text += '[图片] ';
            mediaFiles.push({
              downloadCode: part.downloadCode,
              fileName: part.fileName,
              type: 'image',
            });
            console.log(`[DEBUG] Image added to mediaFiles, count now: ${mediaFiles.length}`);
          } else {
            console.log(`[DEBUG] Image component has no downloadCode`);
          }
          break;

        case 'file':
          console.log(
            `[DEBUG] Processing file component, downloadCode: "${part.downloadCode}", fileName: "${part.fileName}"`
          );
          if (part.downloadCode) {
            text += `[文件: ${part.fileName || '文件'}] `;
            mediaFiles.push({
              downloadCode: part.downloadCode,
              fileName: part.fileName,
              type: 'file',
            });
            console.log(`[DEBUG] File added to mediaFiles, count now: ${mediaFiles.length}`);
          } else {
            console.log(`[DEBUG] File component has no downloadCode`);
          }
          break;

        case 'link':
          console.log(`[DEBUG] Processing link component, url: "${part.url}", text: "${part.text}"`);
          if (part.url) {
            text += part.text ? `[${part.text}](${part.url}) ` : `[链接](${part.url}) `;
            console.log(`[DEBUG] Link appended, current text: "${text}"`);
          }
          break;

        default:
          // 如果是未知类型但有 text 字段，当作文本处理
          if (part.text) {
            console.log(`[DEBUG] Unknown type "${partType as string}" but has text, treating as text`);
            text += part.text;
          } else {
            console.log(`[DEBUG] Unknown component type: ${partType as string}, skipping`);
          }
          break;
      }
    }

    console.log(`[DEBUG] Finished processing all parts`);
    console.log(`[DEBUG] Component counts: ${JSON.stringify(componentCounts)}`);
    console.log(`[DEBUG] Final text: "${text}"`);
    console.log(`[DEBUG] Total media files: ${mediaFiles.length}`);
    console.log(`[DEBUG] Media files: ${JSON.stringify(mediaFiles, null, 2)}`);

    const result = {
      text: text.trim() || '[富文本消息]',
      messageType: 'richText' as const,
      mediaPath: mediaFiles[0]?.downloadCode,
      mediaType: mediaFiles[0]?.type,
      richTextParts,
      mediaFiles,
    };

    console.log(`[DEBUG] Returning result:`, JSON.stringify(result, null, 2));
    return result;
  }

  if (msgtype === 'picture') {
    return { text: '[图片]', mediaPath: data.content?.downloadCode, mediaType: 'image', messageType: 'picture' };
  }

  if (msgtype === 'audio') {
    return {
      text: data.content?.recognition || '[语音消息]',
      mediaPath: data.content?.downloadCode,
      mediaType: 'audio',
      messageType: 'audio',
    };
  }

  if (msgtype === 'video') {
    return { text: '[视频]', mediaPath: data.content?.downloadCode, mediaType: 'video', messageType: 'video' };
  }

  if (msgtype === 'file') {
    return {
      text: `[文件: ${data.content?.fileName || '文件'}]`,
      mediaPath: data.content?.downloadCode,
      mediaType: 'file',
      messageType: 'file',
    };
  }

  // Fallback
  return { text: data.text?.content?.trim() || `[${msgtype}消息]`, messageType: msgtype };
}

// Send message via sessionWebhook
async function sendBySession(
  config: DingTalkConfig,
  sessionWebhook: string,
  text: string,
  options?: SendMessageOptions
): Promise<AxiosResponse>;
async function sendBySession(
  config: DingTalkConfig,
  sessionWebhook: string,
  text: string,
  mediaPath: string,
  options?: SendMessageOptions
): Promise<AxiosResponse>;
async function sendBySession(
  config: DingTalkConfig,
  sessionWebhook: string,
  text: string,
  textOrMediaPath?: string | SendMessageOptions,
  optionsOrMediaPath?: SendMessageOptions | string,
  mediaPathOption?: SendMessageOptions
): Promise<AxiosResponse> {
  const initialLog =
    typeof textOrMediaPath === 'object'
      ? textOrMediaPath.log
      : typeof optionsOrMediaPath === 'object'
        ? optionsOrMediaPath.log
        : undefined;

  initialLog?.info?.(`[DingTalk] sendBySession called - sessionWebhook: ${sessionWebhook}`);
  initialLog?.debug?.(
    `[DingTalk] sendBySession parameters - text: ${text}, textOrMediaPath type: ${typeof textOrMediaPath}, optionsOrMediaPath type: ${typeof optionsOrMediaPath}`
  );

  const token = await getAccessToken(config, initialLog);

  let mediaPath: string | undefined;
  let options: SendMessageOptions = {};

  if (typeof textOrMediaPath === 'object') {
    options = textOrMediaPath;
    options.log?.debug?.(`[DingTalk] sendBySession - textOrMediaPath is SendMessageOptions`);
  } else if (typeof textOrMediaPath === 'string') {
    mediaPath = textOrMediaPath;
    options.log?.debug?.(`[DingTalk] sendBySession - textOrMediaPath is string (mediaPath): ${mediaPath}`);
    if (typeof optionsOrMediaPath === 'object') {
      options = optionsOrMediaPath;
      options.log?.debug?.(`[DingTalk] sendBySession - optionsOrMediaPath is SendMessageOptions`);
    } else if (typeof optionsOrMediaPath === 'string') {
      mediaPath = optionsOrMediaPath;
      options = mediaPathOption || {};
      options.log?.debug?.(`[DingTalk] sendBySession - optionsOrMediaPath is string (mediaPath): ${mediaPath}`);
    }
  }

  if (mediaPath) {
    options.log?.info?.(`[DingTalk] sendBySession - Sending file via session webhook`);
    options.log?.debug?.(`[DingTalk] sendBySession - mediaPath: ${mediaPath}, sessionWebhook: ${sessionWebhook}`);

    const uploadResult = await uploadMedia(config, mediaPath, 'file', options.log);
    if (!uploadResult) {
      options.log?.error?.(`[DingTalk] sendBySession - Failed to upload media file`);
      throw new Error('[DingTalk] Failed to upload media file');
    }

    options.log?.info?.(`[DingTalk] sendBySession - File uploaded successfully, mediaId: ${uploadResult.mediaId}`);

    const fileName = path.basename(mediaPath);
    const fileExt = fileName.split('.').pop()?.toLowerCase() || '';
    options.log?.debug?.(`[DingTalk] sendBySession - fileName: ${fileName}, fileExt: ${fileExt}`);

    const body: FileMessageWebhookResponse = {
      msgtype: 'file',
      file: {
        fileName,
        mediaId: uploadResult.mediaId,
        fileType: fileExt,
      },
    };
    if (options.atUserId) body.at = { atUserIds: [options.atUserId], isAtAll: false };

    options.log?.debug?.(`[DingTalk] sendBySession - Request body: ${JSON.stringify(body)}`);

    const result = await axios({
      url: sessionWebhook,
      method: 'POST',
      data: body,
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
    });

    options.log?.info?.(`[DingTalk] sendBySession - File message sent via session webhook`);
    options.log?.debug?.(`[DingTalk] sendBySession - Response: ${JSON.stringify(result.data)}`);

    return result.data;
  }

  options.log?.info?.(`[DingTalk] sendBySession - Sending text/markdown message via session webhook`);
  options.log?.debug?.(`[DingTalk] sendBySession - text length: ${text.length}`);

  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 消息');
  options.log?.debug?.(`[DingTalk] sendBySession - useMarkdown: ${useMarkdown}, title: ${title}`);

  let body: SessionWebhookResponse;
  if (useMarkdown) {
    let finalText = text;
    if (options.atUserId) finalText = `${finalText} @${options.atUserId}`;
    body = { msgtype: 'markdown', markdown: { title, text: finalText } };
  } else {
    body = { msgtype: 'text', text: { content: text } };
  }

  if (options.atUserId) body.at = { atUserIds: [options.atUserId], isAtAll: false };

  options.log?.debug?.(`[DingTalk] sendBySession - Request body: ${JSON.stringify(body)}`);

  const result = await axios({
    url: sessionWebhook,
    method: 'POST',
    data: body,
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
  });

  options.log?.info?.(`[DingTalk] sendBySession - Message sent successfully`);
  options.log?.debug?.(`[DingTalk] sendBySession - Response: ${JSON.stringify(result.data)}`);

  return result.data;
}

// Send file message via proactive API
async function sendFileMessage(
  config: DingTalkConfig,
  target: string,
  mediaPath: string,
  log?: Logger
): Promise<AxiosResponse> {
  log?.info?.(`[DingTalk] sendFileMessage called - target: ${target}, mediaPath: ${mediaPath}`);
  log?.debug?.(`[DingTalk] sendFileMessage config - robotCode: ${config.robotCode}, clientId: ${config.clientId}`);

  log?.info?.(`[DingTalk] Step 1: Uploading media file...`);
  const uploadResult = await uploadMedia(config, mediaPath, 'file', log);

  if (!uploadResult) {
    log?.error?.(`[DingTalk] sendFileMessage failed - upload returned null`);
    throw new Error('[DingTalk] Failed to upload media file');
  }
  log?.info?.(`[DingTalk] Step 1: Upload successful - mediaId: ${uploadResult.mediaId}`);

  const token = await getAccessToken(config, log);
  const isGroup = target.startsWith('cid');
  log?.info?.(`[DingTalk] Step 2: Determining target type - isGroup: ${isGroup}`);

  const fileName = path.basename(mediaPath);
  const fileExt = fileName.split('.').pop()?.toLowerCase() || '';
  log?.debug?.(`[DingTalk] File name extracted: ${fileName}, extension: ${fileExt}`);

  const url = isGroup
    ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
    : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
  log?.debug?.(`[DingTalk] API URL selected: ${url}`);

  const payload: ProactiveMessagePayload = {
    robotCode: config.robotCode || config.clientId,
    msgKey: 'sampleFile',
    msgParam: JSON.stringify({
      fileName,
      mediaId: uploadResult.mediaId,
      fileType: fileExt,
    }),
  };

  if (isGroup) {
    (payload as any).openConversationId = target;
  } else {
    (payload as any).userIds = [target];
  }

  log?.debug?.(
    `[DingTalk] Request payload: ${JSON.stringify({
      robotCode: payload.robotCode,
      msgKey: payload.msgKey,
      msgParam: payload.msgParam,
      ...(isGroup
        ? { openConversationId: (payload as any).openConversationId }
        : { userIds: (payload as any).userIds }),
    })}`
  );
  log?.info?.(`[DingTalk] Step 3: Sending file message to DingTalk API...`);

  const result = await axios({
    url,
    method: 'POST',
    data: payload,
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
  });

  log?.info?.(`[DingTalk] Step 3: File message sent successfully`);
  log?.debug?.(`[DingTalk] API response - status: ${result.status}, data: ${JSON.stringify(result.data)}`);

  return result.data;
}

// Send interactive card (for initial card creation)
async function sendInteractiveCard(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<{ cardBizId: string; response: any }> {
  // Validate robotCode is configured
  const robotCode = config.robotCode || config.clientId;
  if (!robotCode) {
    throw new Error('[DingTalk] robotCode or clientId is required for sending interactive cards');
  }

  const token = await getAccessToken(config, options.log);
  const isGroup = conversationId.startsWith('cid');

  // Generate unique card business ID using crypto.randomUUID
  const cardBizId = `card_${randomUUID()}`;

  // Extract title and detect markdown
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 消息');

  // Build card data structure with markdown support
  const cardData: InteractiveCardData = {
    config: {
      autoLayout: true,
      enableForward: true,
    },
    header: {
      title: {
        type: 'text',
        text: title,
      },
    },
    contents: [
      {
        type: useMarkdown ? 'markdown' : 'text',
        text: text,
      },
    ],
  };

  // Build request payload
  const payload: InteractiveCardSendRequest = {
    cardTemplateId: config.cardTemplateId || 'StandardCard',
    cardBizId,
    robotCode,
    cardData: JSON.stringify(cardData),
  };

  if (isGroup) {
    payload.openConversationId = conversationId;
  } else {
    payload.singleChatReceiver = JSON.stringify({ userId: conversationId });
  }

  // Use configurable API URL with retry logic
  const apiUrl = config.cardSendApiUrl || 'https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards/send';

  const result = await retryWithBackoff(
    async () => {
      return await axios({
        url: apiUrl,
        method: 'POST',
        data: payload,
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      });
    },
    { maxRetries: 3, log: options.log }
  );

  // Cache card instance for future updates
  cardInstances.set(cardBizId, {
    cardBizId,
    conversationId,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
  });

  return { cardBizId, response: result.data };
}

// Update existing interactive card (for streaming updates)
async function updateInteractiveCard(
  config: DingTalkConfig,
  cardBizId: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<any> {
  const token = await getAccessToken(config, options.log);

  // Extract title and detect markdown
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 消息');

  // Build updated card data with markdown support
  const cardData: InteractiveCardData = {
    config: {
      autoLayout: true,
      enableForward: true,
    },
    header: {
      title: {
        type: 'text',
        text: title,
      },
    },
    contents: [
      {
        type: useMarkdown ? 'markdown' : 'text',
        text: text,
      },
    ],
  };

  // Build update request
  const payload: InteractiveCardUpdateRequest = {
    cardBizId,
    cardData: JSON.stringify(cardData),
    updateOptions: {
      updateCardDataByKey: false,
    },
  };

  // Use configurable API URL with retry logic
  const apiUrl = config.cardUpdateApiUrl || 'https://api.dingtalk.com/v1.0/im/robots/interactiveCards';

  try {
    const result = await retryWithBackoff(
      async () => {
        return await axios({
          url: apiUrl,
          method: 'PUT',
          data: payload,
          headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        });
      },
      { maxRetries: 3, log: options.log }
    );

    // Update cache on success
    const instance = cardInstances.get(cardBizId);
    if (instance) {
      instance.lastUpdated = Date.now();
    }

    return result.data;
  } catch (err: any) {
    // Remove card from cache on terminal errors (404, 410, etc.)
    const statusCode = err.response?.status;
    if (statusCode === 404 || statusCode === 410 || statusCode === 403) {
      options.log?.debug?.(`[DingTalk] Removing card ${cardBizId} from cache due to error ${statusCode}`);
      cardInstances.delete(cardBizId);
    }
    throw err;
  }
}

// Throttled card update wrapper with timeout mechanism
async function updateInteractiveCardThrottled(
  config: DingTalkConfig,
  cardBizId: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<any> {
  const now = Date.now();
  const lastUpdate = cardUpdateTimestamps.get(cardBizId) || 0;
  const timeSinceLastUpdate = now - lastUpdate;

  // Clear any existing timeout for this card
  const existingTimeout = cardUpdateTimeouts.get(cardBizId);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // If enough time has passed, update immediately
  if (timeSinceLastUpdate >= CARD_UPDATE_MIN_INTERVAL) {
    cardUpdateTimestamps.set(cardBizId, now);
    const result = await updateInteractiveCard(config, cardBizId, text, options);

    // Set timeout to detect when updates are complete
    const timeout = setTimeout(() => {
      cardUpdateTimeouts.delete(cardBizId);
      options.log?.debug?.(`[DingTalk] Card ${cardBizId} finalized after inactivity timeout`);
    }, CARD_UPDATE_TIMEOUT);

    cardUpdateTimeouts.set(cardBizId, timeout);
    return result;
  } else {
    // Schedule update after the minimum interval
    return new Promise((resolve, reject) => {
      const delay = CARD_UPDATE_MIN_INTERVAL - timeSinceLastUpdate;
      const timeout = setTimeout(async () => {
        try {
          cardUpdateTimestamps.set(cardBizId, Date.now());
          const result = await updateInteractiveCard(config, cardBizId, text, options);

          // Set inactivity timeout
          const inactivityTimeout = setTimeout(() => {
            cardUpdateTimeouts.delete(cardBizId);
            options.log?.debug?.(`[DingTalk] Card ${cardBizId} finalized after inactivity timeout`);
          }, CARD_UPDATE_TIMEOUT);

          cardUpdateTimeouts.set(cardBizId, inactivityTimeout);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }, delay);

      cardUpdateTimeouts.set(cardBizId, timeout);
    });
  }
}

// Send message with automatic mode selection (text/markdown/card)
async function sendMessage(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions & { cardBizId?: string; sessionWebhook?: string } = {}
): Promise<{ ok: boolean; cardBizId?: string; error?: string }> {
  options.log?.info?.(`[DingTalk] sendMessage called - conversationId: ${conversationId}, textLength: ${text.length}`);
  options.log?.debug?.(
    `[DingTalk] sendMessage config - messageType: ${config.messageType}, hasSessionWebhook: ${!!options.sessionWebhook}`
  );
  options.log?.debug?.(
    `[DingTalk] sendMessage options - cardBizId: ${options.cardBizId || 'none'}, atUserId: ${options.atUserId || 'none'}`
  );

  try {
    const messageType = config.messageType || 'markdown';
    options.log?.debug?.(`[DingTalk] sendMessage determined messageType: ${messageType}`);

    // If sessionWebhook is provided, use session-based sending (for replies during conversation)
    if (options.sessionWebhook) {
      options.log?.info?.(`[DingTalk] sendMessage using session-based sending via sendBySession`);
      options.log?.debug?.(`[DingTalk] sendMessage sessionWebhook: ${options.sessionWebhook}`);
      await sendBySession(config, options.sessionWebhook, text, options);
      options.log?.info?.(`[DingTalk] sendMessage session-based send completed successfully`);
      return { ok: true };
    }

    // For card mode with streaming
    if (messageType === 'card') {
      options.log?.info?.(`[DingTalk] sendMessage using card mode`);
      if (options.cardBizId) {
        options.log?.info?.(`[DingTalk] sendMessage updating existing card - cardBizId: ${options.cardBizId}`);
        await updateInteractiveCard(config, options.cardBizId, text, options);
        options.log?.info?.(`[DingTalk] sendMessage card updated successfully`);
        return { ok: true, cardBizId: options.cardBizId };
      } else {
        options.log?.info?.(`[DingTalk] sendMessage creating new card`);
        const { cardBizId } = await sendInteractiveCard(config, conversationId, text, options);
        options.log?.info?.(`[DingTalk] sendMessage new card created - cardBizId: ${cardBizId}`);
        return { ok: true, cardBizId };
      }
    }

    // For text/markdown mode (backward compatibility)
    options.log?.info?.(`[DingTalk] sendMessage using ${messageType} mode via sendProactiveMessage`);
    await sendProactiveMessage(config, conversationId, text, options);
    options.log?.info?.(`[DingTalk] sendMessage ${messageType} sent successfully`);
    return { ok: true };
  } catch (err: any) {
    options.log?.error?.(`[DingTalk] sendMessage failed: ${err.message}`);
    options.log?.error?.(
      `[DingTalk] sendMessage error details: ${JSON.stringify({
        message: err.message,
        code: err.code,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
      })}`
    );
    if (options.log?.debug) {
      options.log.debug(`[DingTalk] sendMessage error stack: ${err.stack}`);
    }
    return { ok: false, error: err.message };
  }
}

// Process merged messages from cache
async function processMergedMessages(
  cacheKey: string,
  entry: MergedMessageEntry,
  params: HandleDingTalkMessageParams
): Promise<void> {
  const { log } = params;

  log?.info?.(`[DingTalk] Processing ${entry.messages.length} merged messages for ${cacheKey}`);

  // Merge all text content
  const mergedText = entry.messages
    .map((m) => m.content.text)
    .filter(Boolean)
    .join('\n\n');

  // Collect all media files from all messages
  const allMediaFiles: RichTextMediaFile[] = [];
  entry.messages.forEach((m) => {
    if ('mediaFiles' in m.content && m.content.mediaFiles.length > 0) {
      allMediaFiles.push(...m.content.mediaFiles);
    } else if (m.content.mediaPath) {
      allMediaFiles.push({
        downloadCode: m.content.mediaPath,
        fileName: m.data.content?.fileName || `media_${m.data.msgId}`,
        type: (m.content.mediaType === 'image' ? 'image' : 'file') as 'image' | 'file',
      });
    }
  });

  // Deduplicate media files by downloadCode
  const uniqueMediaFiles = Array.from(new Map(allMediaFiles.map((m) => [m.downloadCode, m])).values());

  // Collect all rich text parts
  const allRichTextParts = entry.messages.flatMap((m) => ('richTextParts' in m.content ? m.content.richTextParts : []));

  log?.info?.(`[DingTalk] Merged result: ${mergedText.length} chars, ${uniqueMediaFiles.length} media files`);
  log?.debug?.(`[DingTalk] Original message IDs: ${entry.messages.map((m) => m.data.msgId).join(', ')}`);

  // Create merged content (use first message's data as base)
  const firstMessage = entry.messages[0];
  const mergedContent: RichTextContent = {
    text: mergedText || '[合并消息]',
    messageType: 'richText',
    mediaPath: uniqueMediaFiles[0]?.downloadCode,
    mediaType: uniqueMediaFiles[0]?.type,
    richTextParts: allRichTextParts,
    mediaFiles: uniqueMediaFiles,
  };

  // Update params to use merged content and first message's data
  const mergedParams = {
    ...params,
    data: firstMessage.data,
  };

  // Process merged messages by calling the original handler with merged content
  await handleDingTalkMessageOriginal(mergedParams, mergedContent);
}

// Message handler
async function handleDingTalkMessage(params: HandleDingTalkMessageParams): Promise<void> {
  const { accountId, data, log } = params;

  // Wrap logger with file/line location info for better debugging
  const wrappedLog = createLoggerWithLocation(log, 'channel.ts');

  wrappedLog?.info?.(
    `[DingTalk] handleDingTalkMessage called - accountId: ${accountId}, msgId: ${data.msgId || 'unknown'}`
  );
  // log?.debug?.('[DingTalk] Full Inbound Data:', JSON.stringify(maskSensitiveData(data))); // 注释掉：内容太长容易刷屏

  // 1. 过滤机器人自身消息
  log?.debug?.(`[DingTalk] Checking self-message - senderId: ${data.senderId}, chatbotUserId: ${data.chatbotUserId}`);
  if (data.senderId === data.chatbotUserId || data.senderStaffId === data.chatbotUserId) {
    log?.info?.('[DingTalk] Ignoring robot self-message');
    return;
  }
  log?.debug?.('[DingTalk] Message is not from robot itself');

  // NEW: Message merge logic
  const senderId = data.senderStaffId || data.senderId;
  const cacheKey = `${accountId}:${senderId}:${data.conversationId}`;
  const existingEntry = messageMergeCache.get(cacheKey);

  if (existingEntry) {
    // Within merge window - add to queue
    const content = extractMessageContent(data);

    existingEntry.messages.push({
      content,
      data,
      timestamp: Date.now(),
    });

    log?.info?.(
      `[DingTalk] Message ${data.msgId} added to merge queue (${existingEntry.messages.length}/${MESSAGE_MERGE_MAX_MESSAGES})`
    );

    // Check if max reached
    if (existingEntry.messages.length >= MESSAGE_MERGE_MAX_MESSAGES) {
      clearTimeout(existingEntry.timer);
      log?.info?.(`[DingTalk] Max messages reached (${MESSAGE_MERGE_MAX_MESSAGES}), triggering early merge`);
      const entryToProcess = messageMergeCache.get(cacheKey);
      messageMergeCache.delete(cacheKey);
      if (entryToProcess) {
        await processMergedMessages(cacheKey, entryToProcess, params);
      }
    }
    return; // Skip normal processing - will be handled by timer or max trigger
  }

  // First message in potential merge window - create entry and set timer
  const content = extractMessageContent(data);

  const entry: MergedMessageEntry = {
    messages: [{ content, data, timestamp: Date.now() }],
    timer: null as any,
    accountId,
    senderId,
    sessionKey: '',
    startTime: Date.now(),
  };

  // Set up timer that will fire after 2 seconds
  entry.timer = setTimeout(async () => {
    const cached = messageMergeCache.get(cacheKey);
    if (cached && cached.messages.length > 0) {
      messageMergeCache.delete(cacheKey);
      log?.info?.(
        `[DingTalk] Merge window expired (${MESSAGE_MERGE_WINDOW_MS}ms), processing ${cached.messages.length} merged messages`
      );
      await processMergedMessages(cacheKey, cached, params);
    }
  }, MESSAGE_MERGE_WINDOW_MS);

  messageMergeCache.set(cacheKey, entry);
  log?.info?.(`[DingTalk] Started new merge window for ${cacheKey}, timer: ${MESSAGE_MERGE_WINDOW_MS}ms`);

  // Wait for timer to process all messages together
  // Don't process this first message immediately
  return;
}

// Continue with original handleDingTalkMessage logic for non-merged messages
async function handleDingTalkMessageOriginal(
  params: HandleDingTalkMessageParams,
  preExtractedContent?: RichTextContent
): Promise<void> {
  const { cfg, accountId, data, sessionWebhook, log, dingtalkConfig } = params;
  const rt = getDingTalkRuntime();

  // Wrap logger with file/line location info for better debugging
  const wrappedLog = createLoggerWithLocation(log, 'channel.ts');

  // Use pre-extracted content if provided (for merged messages), otherwise extract from data
  const content = preExtractedContent || extractMessageContent(data);
  const isMerged = !!preExtractedContent;

  if (isMerged) {
    wrappedLog?.info?.(
      `[DingTalk] Processing merged message - type: ${content.messageType}, hasText: ${!!content.text}`
    );
  } else {
    wrappedLog?.info?.(`[DingTalk] Message extracted - type: ${content.messageType}, hasText: ${!!content.text}`);
  }
  log?.debug?.(`[DingTalk] Message content: "${content.text?.slice(0, 100)}..."`);

  if (!content.text) {
    log?.warn?.('[DingTalk] No text content in message, skipping');
    return;
  }

  const isDirect = data.conversationType === '1';
  const senderId = data.senderStaffId || data.senderId;
  const senderName = data.senderNick || 'Unknown';
  const groupId = data.conversationId;
  const groupName = data.conversationTitle || 'Group';

  log?.info?.(`[DingTalk] Message context - isDirect: ${isDirect}, senderId: ${senderId}, senderName: ${senderName}`);
  log?.debug?.(`[DingTalk] Group info - groupId: ${groupId}, groupName: ${groupName}`);

  // 2. Check authorization for direct messages based on dmPolicy
  let commandAuthorized = true;
  if (isDirect) {
    const dmPolicy = dingtalkConfig.dmPolicy || 'open';
    const allowFrom = dingtalkConfig.allowFrom || [];

    log?.info?.(`[DingTalk] DM policy check - dmPolicy: ${dmPolicy}, allowFrom count: ${allowFrom.length}`);

    if (dmPolicy === 'allowlist') {
      const normalizedAllowFrom = normalizeAllowFrom(allowFrom);
      const isAllowed = isSenderAllowed({ allow: normalizedAllowFrom, senderId });

      log?.debug?.(`[DingTalk] Allowlist check - senderId: ${senderId}, isAllowed: ${isAllowed}`);

      if (!isAllowed) {
        log?.info?.(`[DingTalk] DM blocked: senderId=${senderId} not in allowlist (dmPolicy=allowlist)`);

        // Notify user with their sender ID so they can request access
        try {
          log?.info?.('[DingTalk] Sending access denied notification');
          await sendBySession(
            dingtalkConfig,
            sessionWebhook,
            `⛔ 访问受限\n\n您的用户ID：\`${senderId}\`\n\n请联系管理员将此ID添加到允许列表中。`,
            { log }
          );
          log?.info?.('[DingTalk] Access denied notification sent successfully');
        } catch (err: any) {
          log?.error?.(`[DingTalk] Failed to send access denied message: ${err.message}`);
        }

        return;
      }

      log?.info?.(`[DingTalk] DM authorized: senderId=${senderId} in allowlist`);
    } else if (dmPolicy === 'pairing') {
      log?.info?.('[DingTalk] DM policy is pairing, SDK will handle authorization');
      commandAuthorized = true;
    } else {
      log?.info?.('[DingTalk] DM policy is open, allowing all messages');
      commandAuthorized = true;
    }
  }

  // 3. Resolve agent route (moved before media handling to get sessionKey)
  log?.info?.('[DingTalk] Resolving agent route...');
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'dingtalk',
    accountId,
    peer: { kind: isDirect ? 'dm' : 'group', id: isDirect ? senderId : groupId },
  });
  log?.info?.(`[DingTalk] Agent route resolved - agentId: ${route.agentId}, sessionKey: ${route.sessionKey}`);
  log?.debug?.(`[DingTalk] Route details - mainSessionKey: ${route.mainSessionKey}`);

  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  log?.info?.(`[DingTalk] Session store path: ${storePath}`);

  // 4. Handle media files (now has access to sessionKey and storePath)
  let mediaFile: SessionMediaFile | undefined;
  let mediaType: string | undefined;
  let mediaPath: string | undefined;
  const downloadedMediaFiles: SessionMediaFile[] = [];

  // 检查是否是富文本消息且包含多个媒体文件
  if (content.messageType === 'richText' && 'mediaFiles' in content) {
    const richTextContent = content as RichTextContent;

    // DEBUG: Log media files details
    log?.info?.(`[DingTalk] [DEBUG] Media processing - messageType: ${content.messageType}`);
    log?.info?.(`[DingTalk] [DEBUG] mediaFiles array length: ${richTextContent.mediaFiles?.length || 0}`);
    log?.info?.(
      `[DingTalk] [DEBUG] mediaFiles content: ${JSON.stringify(richTextContent.mediaFiles?.map((m) => ({ type: m.type, fileName: m.fileName, downloadCode: m.downloadCode?.substring(0, 20) + '...' })))}`
    );

    if (richTextContent.mediaFiles.length > 0) {
      log?.info?.(`[DingTalk] RichText contains ${richTextContent.mediaFiles.length} media file(s)`);

      // 获取会话超时时间（从配置读取，默认1小时）
      const sessionTimeout = cfg.session?.timeout || 3600000;

      log?.info?.(`[DingTalk] [DEBUG] Starting batch download of ${richTextContent.mediaFiles.length} files`);
      log?.info?.(`[DingTalk] [DEBUG] Session timeout: ${sessionTimeout}ms, Store path: ${storePath}`);

      // 批量下载所有媒体文件
      for (let i = 0; i < richTextContent.mediaFiles.length; i++) {
        const mediaFileInfo = richTextContent.mediaFiles[i];
        log?.info?.(
          `[DingTalk] Downloading media file ${i + 1}/${richTextContent.mediaFiles.length}: ${mediaFileInfo.fileName || 'unnamed'}`
        );

        log?.info?.(
          `[DingTalk] [DEBUG] File ${i + 1} details - type: ${mediaFileInfo.type || 'unknown'}, downloadCode length: ${mediaFileInfo.downloadCode?.length || 0}`
        );

        const downloadedMedia = await downloadMedia(
          dingtalkConfig,
          mediaFileInfo.downloadCode,
          route.sessionKey,
          storePath,
          mediaFileInfo.fileName || `media_${data.msgId}_${i}_${Date.now()}`,
          data.msgId,
          log
        );

        if (downloadedMedia) {
          // 更新过期时间（使用实际的会话超时时间）
          downloadedMedia.expiresAt = Date.now() + sessionTimeout * 2;
          downloadedMediaFiles.push(downloadedMedia);
          log?.info?.(`[DingTalk] Media file ${i + 1} saved - path: ${downloadedMedia.path}`);
        } else {
          log?.info?.(
            `[DingTalk] Failed to download media file ${i + 1} - downloadCode: ${mediaFileInfo.downloadCode}`
          );
        }
      }

      // DEBUG: Download summary
      log?.info?.(
        `[DingTalk] [DEBUG] Batch download completed - Total files in queue: ${richTextContent.mediaFiles.length}, Successfully downloaded: ${downloadedMediaFiles.length}, Failed: ${richTextContent.mediaFiles.length - downloadedMediaFiles.length}`
      );

      // 设置第一个文件为主要媒体文件（保持兼容）
      if (downloadedMediaFiles.length > 0) {
        mediaFile = downloadedMediaFiles[0];
        mediaType = downloadedMediaFiles[0].mimeType;
        mediaPath = downloadedMediaFiles[0].path;
        log?.info?.(`[DingTalk] Total media files downloaded: ${downloadedMediaFiles.length}`);

        // DEBUG: List all downloaded files
        downloadedMediaFiles.forEach((mf, idx) => {
          log?.info?.(`[DingTalk] [DEBUG] Downloaded file ${idx + 1}: ${mf.fileName} at ${mf.path}`);
        });
      } else {
        log?.info?.(`[DingTalk] [DEBUG] WARNING: No media files were successfully downloaded!`);
      }
    }
  } else if (content.mediaPath && dingtalkConfig.robotCode) {
    // 处理普通媒体消息（非富文本）
    log?.info?.(
      `[DingTalk] Received media message - downloadCode: ${content.mediaPath}, messageType: ${content.messageType}`
    );

    // 从消息数据中获取原始文件名（如果是文件类型消息）
    const originalFileName = data.content?.fileName || `media_${data.msgId}_${Date.now()}`;

    // 获取会话超时时间（从配置读取，默认1小时）
    const sessionTimeout = cfg.session?.timeout || 3600000;

    const downloadedMedia = await downloadMedia(
      dingtalkConfig,
      content.mediaPath,
      route.sessionKey,
      storePath,
      originalFileName,
      data.msgId,
      log
    );

    if (downloadedMedia) {
      // 更新过期时间（使用实际的会话超时时间）
      downloadedMedia.expiresAt = Date.now() + sessionTimeout * 2;
      mediaFile = downloadedMedia;
      mediaType = downloadedMedia.mimeType;
      mediaPath = downloadedMedia.path;
      downloadedMediaFiles.push(downloadedMedia);
      log?.info?.(
        `[DingTalk] Media saved to session storage - path: ${mediaFile.path}, expiresAt: ${new Date(mediaFile.expiresAt).toISOString()}`
      );
    } else {
      log?.info?.(`[DingTalk] Failed to download media - downloadCode: ${content.mediaPath}`);
    }
  } else {
    log?.info?.(
      `[DingTalk] No media to download - hasMediaPath: ${!!content.mediaPath}, hasRobotCode: ${!!dingtalkConfig.robotCode}`
    );
  }

  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
  log?.debug?.(`[DingTalk] Envelope options: ${JSON.stringify(envelopeOptions)}`);

  const previousTimestamp = rt.channel.session.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey });
  log?.debug?.(`[DingTalk] Previous session timestamp: ${previousTimestamp || 'none'}`);

  // 5. Format inbound envelope
  const fromLabel = isDirect ? `${senderName} (${senderId})` : `${groupName} - ${senderName}`;
  log?.debug?.(`[DingTalk] From label: ${fromLabel}`);

  const body = rt.channel.reply.formatInboundEnvelope({
    channel: 'DingTalk',
    from: fromLabel,
    timestamp: data.createAt,
    body: content.text,
    chatType: isDirect ? 'direct' : 'group',
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  log?.debug?.(`[DingTalk] Inbound envelope formatted`);

  const to = isDirect ? senderId : groupId;
  log?.debug?.(`[DingTalk] Target (to): ${to}`);

  // 6. Finalize context
  log?.info?.('[DingTalk] Finalizing inbound context...');

  // 构建基础上下文
  const contextData: any = {
    Body: body,
    RawBody: content.text,
    CommandBody: content.text,
    From: to,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: isDirect ? 'direct' : 'group',
    ConversationLabel: fromLabel,
    GroupSubject: isDirect ? undefined : groupName,
    SenderName: senderName,
    SenderId: senderId,
    Provider: 'dingtalk',
    Surface: 'dingtalk',
    MessageSid: data.msgId,
    Timestamp: data.createAt,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: 'dingtalk',
    OriginatingTo: to,
  };

  // 如果是富文本消息，添加富文本组件信息
  if (content.messageType === 'richText' && 'richTextParts' in content) {
    contextData.RichTextParts = content.richTextParts;
    contextData.MediaFiles = downloadedMediaFiles.map((mf) => ({
      path: mf.path,
      mimeType: mf.mimeType,
      fileName: mf.fileName,
    }));
    log?.info?.(
      `[DingTalk] Added richText info to context - parts: ${contextData.RichTextParts.length}, media files: ${contextData.MediaFiles.length}`
    );
  }

  const ctx = rt.channel.reply.finalizeInboundContext(contextData);
  log?.info?.(`[DingTalk] Inbound context finalized - SessionKey: ${ctx.SessionKey}`);

  // 7. Record session
  log?.info?.('[DingTalk] Recording inbound session...');
  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: { sessionKey: route.mainSessionKey, channel: 'dingtalk', to, accountId },
  });
  log?.info?.('[DingTalk] Inbound session recorded successfully');

  log?.info?.(`[DingTalk] Inbound: from=${senderName} text="${content.text.slice(0, 50)}..."`);

  // 8. Send "thinking" feedback
  let currentCardBizId: string | undefined;
  const useCardMode = dingtalkConfig.messageType === 'card';

  log?.info?.(
    `[DingTalk] Reply mode - useCardMode: ${useCardMode}, showThinking: ${dingtalkConfig.showThinking !== false}`
  );

  if (dingtalkConfig.showThinking !== false) {
    log?.info?.('[DingTalk] Sending "thinking" message...');
    try {
      if (useCardMode) {
        log?.info?.('[DingTalk] Sending thinking card...');
        const result = await sendInteractiveCard(dingtalkConfig, to, '🤔 思考中，请稍候...', { log });
        currentCardBizId = result.cardBizId;
        log?.info?.(`[DingTalk] Thinking card sent - cardBizId: ${currentCardBizId}`);
      } else {
        log?.info?.('[DingTalk] Sending thinking message via session webhook...');
        await sendBySession(dingtalkConfig, sessionWebhook, '🤔 思考中，请稍候...', {
          atUserId: !isDirect ? senderId : null,
          log,
        });
        log?.info?.('[DingTalk] Thinking message sent successfully');
      }
    } catch (err: any) {
      log?.error?.(`[DingTalk] Thinking message failed: ${err.message}`);
      log?.debug?.(`[DingTalk] Thinking message error: ${err.stack}`);
    }
  }

  // 9. Create reply dispatcher
  log?.info?.('[DingTalk] Creating reply dispatcher...');
  const { dispatcher, replyOptions, markDispatchIdle } = rt.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: '',
    deliver: async (payload: any) => {
      try {
        log?.debug?.(`[DingTalk] Deliver payload received: ${JSON.stringify(payload)}`);
        const textToSend = payload.markdown || payload.text;
        log?.debug?.(`[DingTalk] Deliver called - textLength: ${textToSend?.length || 0}`);

        // Check for media files (single or multiple)
        const hasMediaUrls = payload.mediaUrls && Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0;
        const hasMediaUrl = payload.mediaUrl && typeof payload.mediaUrl === 'string';

        log?.debug?.(`[DingTalk] Media check - hasMediaUrls: ${hasMediaUrls}, hasMediaUrl: ${hasMediaUrl}`);

        // Send media files first if present
        if (hasMediaUrls) {
          log?.info?.(`[DingTalk] Sending ${payload.mediaUrls.length} media file(s) from mediaUrls`);
          for (const mediaUrl of payload.mediaUrls) {
            try {
              log?.info?.(`[DingTalk] Sending media file: ${mediaUrl}`);
              await sendFileMessage(dingtalkConfig, to, mediaUrl, log);
              log?.info?.(`[DingTalk] Media file sent successfully: ${mediaUrl}`);
            } catch (err: any) {
              log?.error?.(`[DingTalk] Failed to send media file ${mediaUrl}: ${err.message}`);
              // Continue sending other files even if one fails
            }
          }
        } else if (hasMediaUrl) {
          log?.info?.(`[DingTalk] Sending single media file from mediaUrl: ${payload.mediaUrl}`);
          try {
            await sendFileMessage(dingtalkConfig, to, payload.mediaUrl, log);
            log?.info?.(`[DingTalk] Media file sent successfully: ${payload.mediaUrl}`);
          } catch (err: any) {
            log?.error?.(`[DingTalk] Failed to send media file ${payload.mediaUrl}: ${err.message}`);
          }
        }

        // Then send text message if present
        if (textToSend) {
          log?.info?.('[DingTalk] Sending text message');
          if (useCardMode) {
            log?.info?.(`[DingTalk] Delivering via card mode - hasCardBizId: ${!!currentCardBizId}`);
            if (currentCardBizId) {
              log?.debug?.(`[DingTalk] Updating existing card - cardBizId: ${currentCardBizId}`);
              await updateInteractiveCard(dingtalkConfig, currentCardBizId, textToSend, { log });
              log?.debug?.('[DingTalk] Card updated successfully');
            } else {
              log?.info?.('[DingTalk] Creating new card for delivery');
              const result = await sendInteractiveCard(dingtalkConfig, to, textToSend, { log });
              currentCardBizId = result.cardBizId;
              log?.info?.(`[DingTalk] New card created - cardBizId: ${currentCardBizId}`);
            }
          } else {
            log?.info?.('[DingTalk] Delivering via session webhook');
            await sendBySession(dingtalkConfig, sessionWebhook, textToSend, {
              atUserId: !isDirect ? senderId : null,
              log,
            });
            log?.debug?.('[DingTalk] Message delivered via session webhook');
          }
        }

        return { ok: true };
      } catch (err: any) {
        log?.error?.(`[DingTalk] Reply delivery failed: ${err.message}`);
        log?.error?.(
          `[DingTalk] Delivery error details: ${JSON.stringify({
            message: err.message,
            code: err.code,
            status: err.response?.status,
          })}`
        );
        return { ok: false, error: err.message };
      }
    },
  });
  log?.info?.('[DingTalk] Reply dispatcher created successfully');

  try {
    await rt.channel.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions });
  } finally {
    markDispatchIdle();

    // 获取会话超时时间（从配置读取，默认1小时）
    const sessionTimeout = cfg.session?.timeout || 3600000;

    // 清理当前会话的过期媒体文件
    if (storePath && route?.sessionKey) {
      cleanupSessionMedia(storePath, route.sessionKey, sessionTimeout, log);
    }

    // 完全迁移到新机制，不再处理临时目录遗留文件
  }
}

// DingTalk Channel Definition
export const dingtalkPlugin = {
  id: 'dingtalk',
  meta: {
    id: 'dingtalk',
    label: 'DingTalk',
    selectionLabel: 'DingTalk (钉钉)',
    docsPath: '/channels/dingtalk',
    blurb: '钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。',
    aliases: ['dd', 'ding'],
  },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  capabilities: {
    chatTypes: ['direct', 'group'],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
    outbound: true,
  },
  reload: { configPrefixes: ['channels.dingtalk'] },
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => {
      const config = getConfig(cfg);
      return config.accounts ? Object.keys(config.accounts) : isConfigured(cfg) ? ['default'] : [];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string) => {
      const config = getConfig(cfg);
      const id = accountId || 'default';
      const account = config.accounts?.[id];
      return account
        ? { accountId: id, config: account, enabled: account.enabled !== false }
        : { accountId: 'default', config, enabled: config.enabled !== false };
    },
    defaultAccountId: (): string => 'default',
    isConfigured: (account: any): boolean => Boolean(account.config?.clientId && account.config?.clientSecret),
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.config?.name || 'DingTalk',
      enabled: account.enabled,
      configured: Boolean(account.config?.clientId),
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || 'open',
      allowFrom: account.config?.allowFrom || [],
      policyPath: 'channels.dingtalk.dmPolicy',
      allowFromPath: 'channels.dingtalk.allowFrom',
      approveHint: '使用 /allow dingtalk:<userId> 批准用户',
      normalizeEntry: (raw: string) => raw.replace(/^(dingtalk|dd|ding):/i, ''),
    }),
  },
  groups: {
    resolveRequireMention: ({ cfg }: any): boolean => getConfig(cfg).groupPolicy !== 'open',
  },
  messaging: {
    normalizeTarget: ({ target }: any) => (target ? { targetId: target.replace(/^(dingtalk|dd|ding):/i, '') } : null),
    targetResolver: { looksLikeId: (id: string): boolean => /^[\w-]+$/.test(id), hint: '<conversationId>' },
  },
  outbound: {
    deliveryMode: 'direct',
    resolveTarget: ({ to }: any) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error('DingTalk message requires --to <conversationId>'),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const config = getConfig(cfg, accountId);
      try {
        const result = await sendProactiveMessage(config, to, text, { log });
        return { ok: true, data: result };
      } catch (err: any) {
        return { ok: false, error: err.response?.data || err.message };
      }
    },
    sendMedia: async ({ cfg, to, mediaPath, accountId, log }: any) => {
      log?.info?.(`[DingTalk] outbound.sendMedia called - to: ${to}, mediaPath: ${mediaPath}, accountId: ${accountId}`);

      const config = getConfig(cfg, accountId);
      if (!config.clientId) {
        log?.error?.(`[DingTalk] outbound.sendMedia - clientId not configured`);
        return { ok: false, error: 'DingTalk not configured' };
      }
      log?.debug?.(
        `[DingTalk] outbound.sendMedia - Config found - clientId: ${config.clientId}, robotCode: ${config.robotCode}`
      );

      try {
        log?.info?.(`[DingTalk] outbound.sendMedia - Calling sendFileMessage...`);
        const result = await sendFileMessage(config, to, mediaPath, log);
        log?.info?.(`[DingTalk] outbound.sendMedia - File sent successfully`);
        log?.debug?.(`[DingTalk] outbound.sendMedia - Result: ${JSON.stringify(result)}`);
        return { ok: true, data: result };
      } catch (err: any) {
        log?.error?.(`[DingTalk] outbound.sendMedia - Failed to send file`);
        log?.error?.(`[DingTalk] outbound.sendMedia - Error: ${err.message}`);
        log?.error?.(
          `[DingTalk] outbound.sendMedia - Error details: ${JSON.stringify({
            message: err.message,
            code: err.code,
            status: err.response?.status,
            statusText: err.response?.statusText,
            data: err.response?.data,
          })}`
        );
        if (log?.debug) {
          log.debug(`[DingTalk] outbound.sendMedia - Error stack: ${err.stack}`);
        }
        return { ok: false, error: err.response?.data || err.message };
      }
    },
  },
  gateway: {
    startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;
      if (!config.clientId || !config.clientSecret) throw new Error('DingTalk clientId and clientSecret are required');
      if (ctx.log?.info) {
        ctx.log.info(`[${account.accountId}] Starting DingTalk Stream client...`);
      }

      cleanupOrphanedTempFiles(ctx.log);

      const client = new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        debug: config.debug || false,
      });

      client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        const messageId = res.headers?.messageId;
        try {
          if (messageId) {
            client.socketCallBackResponse(messageId, { success: true });
          }
          const data = JSON.parse(res.data) as DingTalkInboundMessage;
          await handleDingTalkMessage({
            cfg,
            accountId: account.accountId,
            data,
            sessionWebhook: data.sessionWebhook,
            log: ctx.log,
            dingtalkConfig: config,
          });
        } catch (error: any) {
          if (ctx.log?.error) {
            ctx.log.error(`[DingTalk] Error processing message: ${error.message}`);
          }
        }
      });

      await client.connect();
      if (ctx.log?.info) {
        ctx.log.info(`[${account.accountId}] DingTalk Stream client connected`);
      }
      const rt = getDingTalkRuntime();
      rt.channel.activity.record('dingtalk', account.accountId, 'start');
      let stopped = false;
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (stopped) return;
          stopped = true;
          if (ctx.log?.info) {
            ctx.log.info(`[${account.accountId}] Stopping DingTalk Stream client...`);
          }
          rt.channel.activity.record('dingtalk', account.accountId, 'stop');
        });
      }
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          if (ctx.log?.info) {
            ctx.log.info(`[${account.accountId}] DingTalk provider stopped`);
          }
          rt.channel.activity.record('dingtalk', account.accountId, 'stop');
          // Clean up card cache cleanup interval
          stopCardCacheCleanup();
        },
      };
    },
  },
  status: {
    defaultRuntime: { accountId: 'default', running: false, lastStartAt: null, lastStopAt: null, lastError: null },
    probe: async ({ cfg }: any) => {
      if (!isConfigured(cfg)) return { ok: false, error: 'Not configured' };
      try {
        const config = getConfig(cfg);
        await getAccessToken(config);
        return { ok: true, details: { clientId: config.clientId } };
      } catch (error: any) {
        return { ok: false, error: error.message };
      }
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
  },
};

/**
 * Public low-level API exports for the DingTalk channel plugin.
 *
 * - {@link sendBySession} sends a message to DingTalk using a session/webhook
 *   (e.g. replies within an existing conversation). Supports text, markdown, and file messages.
 * - {@link sendProactiveMessage} sends a proactive/outbound message to DingTalk
 *   without requiring an existing inbound session.
 * - {@link sendFileMessage} sends a file message to DingTalk.
 * - {@link uploadMedia} uploads a media file to DingTalk and returns mediaId.
 * - {@link sendInteractiveCard} sends an interactive card to DingTalk
 *   (returns cardBizId for streaming updates).
 * - {@link updateInteractiveCard} updates an existing interactive card
 *   (for streaming message updates).
 * - {@link updateInteractiveCardThrottled} throttled version of updateInteractiveCard
 *   with rate limiting and auto-finalization timeout (recommended for streaming).
 * - {@link sendMessage} sends a message with automatic mode selection
 *   (text/markdown/card based on config).
 * - {@link getAccessToken} retrieves (and caches) the DingTalk access token
 *   for the configured application/runtime.
 *
 * These exports are intended to be used by external integrations that need
 * direct programmatic access to DingTalk messaging and authentication.
 */
export {
  sendBySession,
  sendProactiveMessage,
  sendFileMessage,
  uploadMedia,
  sendInteractiveCard,
  updateInteractiveCard,
  updateInteractiveCardThrottled,
  sendMessage,
  getAccessToken,
};
