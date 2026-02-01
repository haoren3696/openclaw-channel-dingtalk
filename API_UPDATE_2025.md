# 钉钉API规范更新 - 文件上传重新实现

## 修改时间

2025-01-31

## 修改原因

根据钉钉开放平台最新的API规范（2025年），之前的实现存在一些不符合规范的地方。

## 主要修改内容

### 1. API端点更新

**旧实现（错误）：**

```
https://api.dingtalk.com/media/upload?access_token=${token}
```

**新实现（正确）：**

```
https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${mediaType}
```

**变更点：**

- ✅ 使用 `oapi.dingtalk.com` 域名（旧版稳定API）
- ✅ `type` 参数从 form-data 移动到 query string
- ✅ `access_token` 在 query string 中传递

### 2. 请求体格式

**旧实现（错误）：**

```typescript
formData.append('media', fs.createReadStream(mediaPath), { ... });
formData.append('type', finalMediaType);  // ❌ 错误：type 不应该在 formData 中
```

**新实现（正确）：**

```typescript
formData.append('media', fs.createReadStream(mediaPath), { ... });
// ✅ 正确：只有 media 字段，type 在 URL 参数中
```

### 3. HTTP Headers

**旧实现（错误）：**

```typescript
headers: {
  ...formData.getHeaders(),  // ❌ 错误：不应该手动设置 headers
}
```

**新实现（正确）：**

```typescript
// ✅ 正确：不设置 headers，让 axios 自动生成 multipart/form-data 和 boundary
```

### 4. 文件大小限制更新

根据2025年最新规范：

| 类型  | 旧限制 | 新限制 |
| ----- | ------ | ------ |
| image | 1MB    | 2MB    |
| voice | 2MB    | 2MB    |
| video | 10MB   | 100MB  |
| file  | 10MB   | 20MB   |

### 5. 响应时间戳处理

**旧实现（错误）：**

```typescript
createdAt: new Date(response.data.created_at || Date.now()).toISOString();
// ❌ 错误：created_at 是秒级时间戳，应该乘以1000转为毫秒
```

**新实现（正确）：**

```typescript
createdAt: new Date((response.data.created_at || Date.now()) * 1000).toISOString();
// ✅ 正确：钉钉返回的是秒级时间戳
```

### 6. 超时设置

- 旧超时：60秒
- 新超时：120秒（适应大文件上传）

## 完整代码对比

### uploadMedia 函数（修改前 vs 修改后）

```typescript
// ==================== 修改前（错误）====================
const formData = new FormData();
formData.append('media', fs.createReadStream(mediaPath), {
  filename: fileName,
  contentType: 'application/octet-stream',
} as any);
formData.append('type', finalMediaType); // ❌ type 不应该在这里

const uploadUrl = `https://api.dingtalk.com/media/upload?access_token=${token}`; // ❌ 错误域名

const response = await axios.post(uploadUrl, formData, {
  headers: {
    ...formData.getHeaders(), // ❌ 不应该手动设置 headers
  },
  maxBodyLength: fileSize * 1.5,
  timeout: 60000,
});

// ==================== 修改后（正确）====================
const formData = new FormData();
formData.append('media', fs.createReadStream(mediaPath), {
  filename: fileName,
  contentType: 'application/octet-stream',
} as any);
// ✅ type 移除了，放到 URL 参数中

const uploadUrl = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${finalMediaType}`; // ✅ 正确域名和参数

const response = await axios.post(uploadUrl, formData, {
  // ✅ 不设置 headers，让 axios 自动生成
  maxBodyLength: fileSize * 2,
  timeout: 120000,
});
```

## 钉钉API规范参考

### 官方文档

- 接口地址：`POST https://oapi.dingtalk.com/media/upload`
- 文档链接：https://open.dingtalk.com/document/development/upload-media-files

### 请求参数

#### Query参数

| 参数名       | 必填 | 类型   | 描述                                 |
| ------------ | ---- | ------ | ------------------------------------ |
| access_token | 是   | string | 调用接口凭证                         |
| type         | 是   | string | 媒体文件类型：image/voice/video/file |

#### Body参数（multipart/form-data）

| 参数名 | 必填 | 类型 | 描述                              |
| ------ | ---- | ---- | --------------------------------- |
| media  | 是   | file | 媒体文件内容，字段名必须是'media' |

### 响应格式

```json
{
  "errcode": 0,
  "errmsg": "ok",
  "media_id": "@lADPDfYH0lA0xxxxxx",
  "type": "file",
  "created_at": 1691119400 // 秒级时间戳
}
```

### 常见错误码

| 错误码 | 描述                  | 解决方案                        |
| ------ | --------------------- | ------------------------------- |
| 0      | 成功                  | -                               |
| 400001 | access_token无效      | 检查token是否过期               |
| 400002 | media参数为空         | 确保上传了有效的文件            |
| 400003 | 文件大小超过限制      | 检查文件大小                    |
| 400004 | 文件类型不支持        | 检查type参数和文件格式          |
| 43008  | 参数需要multipart类型 | 确保使用multipart/form-data格式 |

## 测试建议

1. **启用调试日志**：在配置中设置 `debug: true`
2. **测试不同文件类型**：
   - 图片（jpg, png）
   - 文档（pdf, docx）
   - 大文件（接近限制大小）
3. **查看日志输出**：
   ```bash
   openclaw logs | grep DingTalk
   ```

## 验证检查清单

- [x] API端点使用 `oapi.dingtalk.com`
- [x] access_token 在 query string 中
- [x] type 参数在 query string 中
- [x] form-data 中只有 media 字段
- [x] 不手动设置 Content-Type header
- [x] 文件大小限制符合最新规范
- [x] created_at 正确处理（秒级转毫秒）
- [x] 超时设置为120秒
- [x] TypeScript编译通过

## 相关文件

- `src/channel.ts` - 主要修改文件
- `src/types.ts` - 类型定义（无需修改）
