/**
 * 钉钉文件发送示例代码
 *
 * 此文件展示如何使用钉钉通道插件发送文件消息
 */

import { uploadMedia, sendFileMessage, sendBySession, type DingTalkConfig } from '@openclaw/dingtalk';

// 示例配置
const config: DingTalkConfig = {
  clientId: process.env.DINGTALK_CLIENT_ID || '',
  clientSecret: process.env.DINGTALK_CLIENT_SECRET || '',
  robotCode: process.env.DINGTALK_ROBOT_CODE || '',
  agentId: process.env.DINGTALK_AGENT_ID || '',
};

/**
 * 示例1: 主动发送文件消息（不依赖对话）
 * 适用于：定时任务、通知推送等场景
 */
async function example1_SendFileProactively() {
  const filePath = '/path/to/your/file.pdf';
  const conversationId = 'cid-xxxxxx'; // 群聊ID，或者直接是用户ID（单聊）

  try {
    console.log('开始发送文件:', filePath);
    const result = await sendFileMessage(config, conversationId, filePath);
    console.log('文件发送成功:', result);
  } catch (error) {
    console.error('文件发送失败:', error);
  }
}

/**
 * 示例2: 在对话中发送文件作为回复
 * 适用于：机器人回复用户消息时附带文件
 */
async function example2_SendFileInReply(sessionWebhook: string) {
  const filePath = '/path/to/your/report.xlsx';

  try {
    console.log('在对话中发送文件:', filePath);
    const result = await sendBySession(config, sessionWebhook, '这是您请求的报告', filePath);
    console.log('文件发送成功:', result);
  } catch (error) {
    console.error('文件发送失败:', error);
  }
}

/**
 * 示例3: 仅上传文件获取mediaId
 * 适用于：需要先上传文件，稍后分批发送的场景
 */
async function example3_UploadOnly() {
  const filePath = '/path/to/your/image.png';

  try {
    console.log('上传文件:', filePath);
    const uploadResult = await uploadMedia(config, filePath, 'image');

    if (uploadResult) {
      console.log('文件上传成功, mediaId:', uploadResult.mediaId);
      // 可以保存 mediaId 用于后续发送
      return uploadResult.mediaId;
    } else {
      console.error('文件上传失败');
      return null;
    }
  } catch (error) {
    console.error('文件上传失败:', error);
    return null;
  }
}

/**
 * 示例4: 批量发送文件
 * 适用于：发送多个文件的场景
 */
async function example4_SendMultipleFiles(conversationId: string, filePaths: string[]) {
  const results = [];

  for (const filePath of filePaths) {
    try {
      console.log(`发送文件 ${results.length + 1}/${filePaths.length}:`, filePath);
      const result = await sendFileMessage(config, conversationId, filePath);
      results.push({ filePath, success: true, result });

      // 添加延迟避免频率限制
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`文件发送失败: ${filePath}`, error);
      results.push({ filePath, success: false, error });
    }
  }

  return results;
}

/**
 * 示例5: 根据文件类型自动选择mediaType
 * 适用于：根据文件扩展名自动判断文件类型
 */
async function example5_SendFileWithAutoType(conversationId: string, filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase();

  let mediaType: 'image' | 'video' | 'audio' | 'file' = 'file';

  switch (ext) {
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'bmp':
      mediaType = 'image';
      break;
    case 'mp4':
    case 'avi':
    case 'mov':
    case 'wmv':
      mediaType = 'video';
      break;
    case 'mp3':
    case 'wav':
    case 'm4a':
      mediaType = 'audio';
      break;
    default:
      mediaType = 'file';
  }

  try {
    console.log(`发送${mediaType}类型文件:`, filePath);
    const uploadResult = await uploadMedia(config, filePath, mediaType);

    if (uploadResult) {
      console.log('文件上传成功:', uploadResult.mediaId);
      // 使用 uploadResult.mediaId 发送消息
      return uploadResult.mediaId;
    }
    return null;
  } catch (error) {
    console.error('文件发送失败:', error);
    return null;
  }
}

/**
 * 示例6: 错误处理和重试
 * 适用于：生产环境中的文件发送
 */
async function example6_SendFileWithRetry(conversationId: string, filePath: string, maxRetries = 3) {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`尝试 ${attempt}/${maxRetries}: 发送文件`, filePath);
      const result = await sendFileMessage(config, conversationId, filePath);
      console.log('文件发送成功:', result);
      return result;
    } catch (error) {
      lastError = error as Error;
      console.error(`尝试 ${attempt}/${maxRetries} 失败:`, error);

      if (attempt < maxRetries) {
        // 指数退避重试
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`等待 ${delay}ms 后重试...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`文件发送失败，已重试 ${maxRetries} 次`);
  throw lastError;
}

/**
 * 示例7: 发送带附件的消息
 * 适用于：先发送文本，然后发送文件
 */
async function example7_SendMessageWithAttachment(sessionWebhook: string, filePath: string) {
  try {
    // 先发送文本消息
    await sendBySession(config, sessionWebhook, '正在准备文件，请稍候...');

    // 然后发送文件
    await sendBySession(config, sessionWebhook, '这是您请求的文件', filePath);

    console.log('消息和文件发送成功');
  } catch (error) {
    console.error('发送失败:', error);
  }
}

// 使用示例
(async () => {
  // 取消注释以运行示例
  // await example1_SendFileProactively();
  // await example3_UploadOnly();
  // const results = await example4_SendMultipleFiles('cid-group-id', [
  //   '/path/to/file1.pdf',
  //   '/path/to/file2.xlsx',
  //   '/path/to/file3.png',
  // ]);
  // console.log('批量发送结果:', results);
})();
