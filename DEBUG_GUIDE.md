# 钉钉文件发送调试指南

## 启用调试日志

在配置文件中设置 `debug: true` 来启用详细的调试日志：

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      clientId: 'your-client-id',
      clientSecret: 'your-client-secret',
      robotCode: 'your-robot-code',
      debug: true, // 启用调试日志
    },
  },
}
```

## 日志级别说明

- **info**: 重要步骤的信息
- **debug**: 详细的调试信息（需要 `debug: true`）
- **warn**: 警告信息
- **error**: 错误信息

## 发送文件流程日志

### 1. outbound.sendMedia 调用

当通过 OpenClaw 的 outbound API 发送文件时：

```
[DingTalk] outbound.sendMedia called - to: cid-xxxxxx, mediaPath: /path/to/file.pdf, accountId: default
[DingTalk] outbound.sendMedia - Config found - clientId: dingxxxxx..., robotCode: dingxxxxx...
[DingTalk] outbound.sendMedia - Calling sendFileMessage...
```

**可能的问题：**

- 如果看到 `clientId not configured` - 检查配置文件中的 `clientId` 和 `clientSecret`

### 2. sendFileMessage 调用

```
[DingTalk] sendFileMessage called - target: cid-xxxxxx, mediaPath: /path/to/file.pdf
[DingTalk] sendFileMessage config - robotCode: dingxxxxx..., clientId: dingxxxxx...
[DingTalk] Step 1: Uploading media file...
```

**可能的问题：**

- 检查 `robotCode` 是否正确配置
- 检查文件路径是否正确

### 3. uploadMedia 调用

```
[DingTalk] uploadMedia called - mediaPath: /path/to/file.pdf, mediaType: file
[DingTalk] Access token obtained for media upload
[DingTalk] File exists: /path/to/file.pdf
[DingTalk] File stats - fileName: file.pdf, fileSize: 12345 bytes
[DingTalk] FormData created - type: file, agentId: 123456789
[DingTalk] Starting upload to: https://api.dingtalk.com/v1.0/media/upload
```

**可能的问题：**

- 如果看到 `File not found` - 检查文件路径是否正确
- 如果文件大小为 0 或很小，可能文件有问题

### 4. 上传响应

```
[DingTalk] Upload response status: 200
[DingTalk] Upload response data: {"mediaId":"@lALPDaWbF2bC1yfYyD4QAA"}
[DingTalk] File uploaded successfully - mediaId: @lALPDaWbF2bC1yfYyD4QAA
[DingTalk] Step 1: Upload successful - mediaId: @lALPDaWbF2bC1yfYyD4QAA
```

**可能的问题：**

- 如果看到 `Upload response missing mediaId` - 钉钉 API 响应异常，检查 API 权限
- 如果看到 HTTP 错误状态码（4xx, 5xx）- 检查网络和 API 配置

### 5. 发送文件消息

```
[DingTalk] Step 2: Determining target type - isGroup: true
[DingTalk] API URL selected: https://api.dingtalk.com/v1.0/robot/groupMessages/send
[DingTalk] File name extracted: file.pdf
[DingTalk] Request payload: {"robotCode":"dingxxxxx","msgKey":"sampleFile","msgParam":"{\"fileName\":\"file.pdf\",\"mediaId\":\"@lALPDaWbF2bC1yfYyD4QAA\"}","openConversationId":"cid-xxxxxx"}
[DingTalk] Step 3: Sending file message to DingTalk API...
```

**可能的问题：**

- 检查 `robotCode` 是否正确
- 检查群聊 ID 或用户 ID 是否正确
- 检查 `msgKey` 是否支持（可能需要使用预定义的 msgKey）

### 6. 发送响应

```
[DingTalk] Step 3: File message sent successfully
[DingTalk] API response - status: 200, data: {"result":true}
[DingTalk] outbound.sendMedia - File sent successfully
[DingTalk] outbound.sendMedia - Result: {"result":true}
```

**可能的问题：**

- 如果看到失败响应，检查响应数据中的错误信息

## 常见错误和解决方案

### 1. 文件上传失败

**错误日志：**

```
[DingTalk] Failed to upload media - message: Request failed with status code 401
[DingTalk] Upload error details: {"message":"Request failed with status code 401","status":401}
```

**解决方案：**

- 检查 `clientId` 和 `clientSecret` 是否正确
- 检查应用是否有媒体上传权限
- 尝试重新获取 access token

### 2. 文件不存在

**错误日志：**

```
[DingTalk] File not found: /path/to/file.pdf
[DingTalk] Failed to upload media - message: File not found: /path/to/file.pdf
```

**解决方案：**

- 检查文件路径是否正确
- 确保文件存在且可读
- 检查文件权限

### 3. API 调用失败

**错误日志：**

```
[DingTalk] Failed to upload media - message: Request failed with status code 403
[DingTalk] Upload error details: {"message":"Request failed with status code 403","status":403,"data":{"code":"Forbidden"}}
```

**解决方案：**

- 检查应用权限配置
- 确保应用已发布
- 检查 API 访问权限

### 4. 文件消息发送失败

**错误日志：**

```
[DingTalk] outbound.sendMedia - Failed to send file
[DingTalk] outbound.sendMedia - Error: Request failed with status code 400
[DingTalk] outbound.sendMedia - Error details: {"message":"Invalid msgKey","status":400}
```

**解决方案：**

- 检查 `msgKey` 是否有效（可能需要使用预定义的模板 msgKey）
- 检查 `msgParam` 格式是否正确
- 参考 [钉钉消息类型文档](https://open.dingtalk.com/document/dingstart/types-of-messages-sent-by-robots)

### 5. 网络问题

**错误日志：**

```
[DingTalk] Failed to upload media - message: connect ETIMEDOUT
[DingTalk] Upload error details: {"message":"connect ETIMEDOUT","code":"ETIMEDOUT"}
```

**解决方案：**

- 检查网络连接
- 检查防火墙设置
- 检查代理配置

## 查看日志

### 通过命令行查看实时日志

```bash
# 查看 DingTalk 相关日志
openclaw logs | grep DingTalk

# 查看所有日志
openclaw logs --follow

# 查看特定级别的日志
openclaw logs | grep -E "\[DingTalk\].*(error|warn)"
```

### 导出日志到文件

```bash
# 导出最近 1000 行日志
openclaw logs | tail -n 1000 > dingtalk-debug.log

# 导出错误日志
openclaw logs | grep -E "\[DingTalk\].*error" > dingtalk-errors.log
```

## 调试步骤

### Step 1: 检查配置

```bash
# 检查配置文件
cat ~/.openclaw/clawdbot.json | grep -A 20 dingtalk
```

确保以下配置项正确：

- `clientId`
- `clientSecret`
- `robotCode`
- `agentId`（可选）

### Step 2: 测试文件上传

使用独立的测试脚本测试文件上传：

```typescript
import { uploadMedia } from '@openclaw/dingtalk';

const result = await uploadMedia(config, '/path/to/test.pdf', 'file');
console.log('Upload result:', result);
```

### Step 3: 测试消息发送

使用独立的测试脚本测试消息发送：

```typescript
import { sendFileMessage } from '@openclaw/dingtalk';

const result = await sendFileMessage(config, 'test-conversation-id', '/path/to/test.pdf');
console.log('Send result:', result);
```

### Step 4: 检查 API 响应

如果 API 调用失败，查看详细的响应数据：

```
[DingTalk] Upload error details: {
  "message": "Request failed with status code 400",
  "status": 400,
  "data": {
    "code": "InvalidParameter",
    "message": "Invalid file type"
  }
}
```

## 需要更多信息？

如果以上步骤无法解决问题，请收集以下信息并提交 issue：

1. **配置信息**（隐藏敏感信息）：

   ```json
   {
     "clientId": "din******xx",
     "robotCode": "din******xx",
     "agentId": "123******789"
   }
   ```

2. **完整日志**：

   ```bash
   openclaw logs | grep DingTalk > full-log.txt
   ```

3. **错误详情**：
   - 错误消息
   - 错误状态码
   - API 响应数据

4. **环境信息**：
   - OpenClaw 版本
   - 钉钉插件版本
   - Node.js 版本
   - 操作系统

5. **复现步骤**：
   - 具体的操作步骤
   - 使用的文件类型和大小
   - 目标会话类型（群聊/单聊）
