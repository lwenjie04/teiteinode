# API 草案

## Auth

- `POST /api/auth/email-code/send`
- `POST /api/auth/email-code/verify`
- `POST /api/auth/logout`
- `GET /api/auth/me`

开发环境下，发送验证码会返回 `devCode` 方便本地测试；生产环境不会在响应里暴露验证码。验证码 10 分钟内有效，错误次数过多后需要重新发送。

## Sync

- `GET /api/sync/pull`
- `POST /api/sync/push`
- `POST /api/sync/resolve-conflict`

## Diary

- `GET /api/diaries`
- `GET /api/diaries/:id`
- `POST /api/diaries`
- `PATCH /api/diaries/:id`
- `DELETE /api/diaries/:id`

## Files

- `GET /api/files`
- `GET /api/files/stats`
- `POST /api/files/upload`
- `GET /uploads/:date/:filename`
- `GET /assets/:date/:filename` 旧上传地址兼容
- `DELETE /api/files/:id`

`POST /api/files/upload` 需要登录，目前只接受图片文件。返回：

```json
{
  "id": "file-id",
  "filename": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 12345,
  "relativeUrl": "/uploads/2026-05-11/file-photo.jpg",
  "url": "http://localhost:4000/uploads/2026-05-11/file-photo.jpg"
}
```

数据库可用时，上传接口会把文件元数据写入 `uploaded_files`。数据库不可用时，文件仍保存到磁盘，并在当前后端进程内使用内存元数据兜底；服务重启后内存元数据会丢失，但日记里已经保存的图片 URL 仍可访问对应磁盘文件。

## AI

- `GET /api/ai/status`
- `POST /api/ai/segment`
- `POST /api/ai/stylize`
- `POST /api/ai/generate-diary`

## 认证

除发送验证码、验证验证码、健康检查、AI 状态外，其余接口默认使用：

```http
Authorization: Bearer <token>
```

## AI 处理原则

- 前端不保存 API Key
- AI Key 只通过后端环境变量配置
- 图片处理失败不删除草稿
- 生成文字采用轻微润色策略
- 后端 AI 仍返回占位图或请求失败时，前端会使用本地 Canvas 兜底：主体选择会裁切成贴纸，贴纸版本会生成本地白边、漫画、手绘、黑白线稿效果
