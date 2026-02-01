# 钉钉文件消息发送功能

## 新增功能

该更新为钉钉通道插件添加了文件消息发送功能。

## 使用方法

### 1. 发送文件消息

```typescript
import { uploadMedia, sendFileMessage, sendBySession } from '@openclaw/dingtalk';

// 通过主动消息发送文件
async function sendFileProactively(config, conversationId, filePath) {
  try {
    const result = await sendFileMessage(config, conversationId, filePath);
    console.log('文件发送成功:', result);
  } catch (error) {
    console.error('文件发送失败:', error);
  }
}

// 通过session webhook发送文件（回复消息）
async function sendFileInReply(config, sessionWebhook, filePath) {
  try {
    const result = await sendBySession(config, sessionWebhook, '文件已发送', filePath);
    console.log('文件发送成功:', result);
  } catch (error) {
    console.error('文件发送失败:', error);
  }
}

// 只上传文件不发送
async function uploadOnly(config, filePath) {
  try {
    const result = await uploadMedia(config, filePath, 'file');
    console.log('文件上传成功, mediaId:', result?.mediaId);
    return result?.mediaId;
  } catch (error) {
    console.error('文件上传失败:', error);
    return null;
  }
}
```

### 2. 通过 OpenClaw Outbound API 发送文件

```typescript
// 使用 sendMedia 方法发送文件
await openclaw.outbound.send({
  channel: 'dingtalk',
  to: 'conversation-id',
  media: '/path/to/file.pdf',
  accountId: 'your-account-id',
});
```

## 配置要求

确保在配置文件中设置了以下字段：

```yaml
channels:
  dingtalk:
    clientId: 'your-app-key'
    clientSecret: 'your-app-secret'
    robotCode: 'your-robot-code'
    agentId: 'your-agent-id'
```

## 支持的文件类型

- 普通文件（file）
- 图片（image）
- 音频（audio）
- 视频（video）

## API 变更

### 新增导出函数

- `uploadMedia(config, mediaPath, mediaType?, log?)` - 上传媒体文件
- `sendFileMessage(config, target, mediaPath, log?)` - 发送文件消息

### 修改的函数

- `sendBySession` - 添加了对文件消息的支持
- `outbound.sendMedia` - 现在发送真实的文件而非文本描述

## 技术细节

### 上传流程

1. 使用 `uploadMedia` 上传文件到钉钉服务器
2. 获取 `mediaId`
3. 使用 `mediaId` 发送文件消息

### API 端点

- 上传文件: `POST https://api.dingtalk.com/v1.0/media/upload`
- 发送文件消息:
  - 群聊: `POST https://api.dingtalk.com/v1.0/robot/groupMessages/send`
  - 单聊: `POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend`
