# 钉钉文件发送 API 实现文档

## 修改总结

根据 [钉钉API文档](https://open.dingtalk.com/document/development/upload-media-files) 对文件上传和发送流程进行了规范化修改。

## 主要修改内容

### 1. 文件上传 (uploadMedia)

#### API 端点

```
POST https://api.dingtalk.com/media/upload?access_token={token}
```

#### 支持的文件类型和大小限制

| 类型  | 扩展名                                         | 大小限制 | 说明     |
| ----- | ---------------------------------------------- | -------- | -------- |
| image | jpg, jpeg, png, gif, bmp                       | 1MB      | 图片文件 |
| voice | amr, mp3, wav                                  | 2MB      | 语音文件 |
| video | mp4                                            | 10MB     | 视频文件 |
| file  | doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar | 10MB     | 普通文件 |

#### 请求参数

- `type`: 媒体文件类型 (image, voice, video, file)
- `media`: 要上传的文件 (multipart/form-data)

#### 响应格式

```json
{
  "errcode": 0,
  "errmsg": "ok",
  "media_id": "@lAz...",
  "type": "file",
  "created_at": 1605863153573
}
```

**注意**: `errcode` 为 0 表示成功，此时 `media_id` 字段存在。

### 2. 文件消息发送 (sendFileMessage)

#### API 端点

- 群聊: `POST https://api.dingtalk.com/v1.0/robot/groupMessages/send`
- 单聊: `POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend`

#### 请求头

```
x-acs-dingtalk-access-token: <access_token>
Content-Type: application/json
```

#### 请求体格式

```json
{
  "robotCode": "dingxxxxxx",
  "msgKey": "sampleFile",
  "msgParam": "{\"mediaId\":\"@lAz...\",\"fileName\":\"test.pdf\",\"fileType\":\"pdf\"}",
  "openConversationId": "cidxxxxxx"
}
```

#### msgParam 字段说明

- `mediaId`: 通过上传接口获取的 media_id
- `fileName`: 文件名称（包含扩展名）
- `fileType`: 文件类型（如：pdf, xlsx, docx 等）

### 3. Session Webhook 文件发送

#### 请求体格式

```json
{
  "msgtype": "file",
  "file": {
    "fileName": "test.pdf",
    "mediaId": "@lAz...",
    "fileType": "pdf"
  },
  "at": {
    "atUserIds": ["userId"],
    "isAtAll": false
  }
}
```

## 代码修改详情

### uploadMedia 函数优化

1. **文件扩展名映射** (只保留官方支持格式)

   ```typescript
   const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp'];
   const voiceExts = ['amr', 'mp3', 'wav'];
   const videoExts = ['mp4'];
   const fileExts = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'pdf', 'rar'];
   ```

2. **文件大小检查**

   ```typescript
   const sizeLimits: Record<string, number> = {
     image: 1 * 1024 * 1024, // 1MB
     voice: 2 * 1024 * 1024, // 2MB
     video: 10 * 1024 * 1024, // 10MB
     file: 10 * 1024 * 1024, // 10MB
   };
   ```

3. **FormData Headers**

   ```typescript
   headers: {
     ...formData.getHeaders(),
   },
   ```

4. **响应处理**
   ```typescript
   if (response.data?.errcode === 0 && response.data?.media_id) {
     return {
       mediaId: response.data.media_id,
       type: response.data.type || finalMediaType,
       createdAt: new Date(response.data.created_at || Date.now()).toISOString(),
     };
   }
   ```

## 使用示例

### 发送文件消息

```typescript
import { sendFileMessage } from '@openclaw/dingtalk';

const result = await sendFileMessage(
  config,
  'cid-xxxxxx', // 群聊ID
  '/path/to/document.pdf'
);
```

### 上传文件并获取 mediaId

```typescript
import { uploadMedia } from '@openclaw/dingtalk';

const result = await uploadMedia(config, '/path/to/image.jpg', 'image');

if (result) {
  console.log('mediaId:', result.mediaId);
}
```

### 在回复中发送文件

```typescript
import { sendBySession } from '@openclaw/dingtalk';

await sendBySession(config, sessionWebhook, '这是您要的文件', '/path/to/file.xlsx', { log });
```

## 调试日志

启用 `debug: true` 配置后，可以看到详细的日志输出：

```
[DingTalk] uploadMedia called - mediaPath: /path/to/file.pdf, mediaType: file, finalMediaType: file, fileExt: pdf
[DingTalk] Access token obtained for media upload
[DingTalk] File exists: /path/to/file.pdf
[DingTalk] File stats - fileName: file.pdf, fileSize: 12345 bytes, limit: 10485760 bytes
[DingTalk] FormData created - type: file
[DingTalk] Starting upload to: https://api.dingtalk.com/media/upload?access_token=xxxxx
[DingTalk] Upload response status: 200
[DingTalk] Upload response data: {"errcode":0,"errmsg":"ok","media_id":"@lAz...","type":"file","created_at":1605863153573}
[DingTalk] File uploaded successfully - media_id: @lAz..., type: file
```

## 常见错误码

| 错误码 | 说明                 |
| ------ | -------------------- |
| 0      | 成功                 |
| 40004  | 不合法的媒体文件类型 |
| 40005  | 不合法的媒体文件大小 |
| 40006  | 不合法的媒体文件格式 |
| 40007  | 媒体文件上传失败     |

## 参考文档

- [上传媒体文件](https://open.dingtalk.com/document/development/upload-media-files)
- [机器人发送消息的类型](https://open.dingtalk.com/document/dingstart/types-of-messages-sent-by-robots)
- [机器人发送群聊消息](https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message)
