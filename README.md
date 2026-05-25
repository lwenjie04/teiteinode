# 贴贴日记

贴贴日记是一款面向 iPhone 主屏幕安装使用的 PWA 照片日记应用。用户可以拍照或选择照片，抠出主体变成贴纸，搭配手账背景、漫画风格、装饰贴纸、画笔涂鸦和 AI 生成的小日记，保存并同步到云端。

## 项目结构

```text
apps/
  web/      Vue 3 + Vite + PWA 前端
  api/      Fastify + TypeScript 后端
  android/  Android WebView 软件端壳
  mp-wechat/ 微信小程序端壳
packages/
  shared/   前后端共享类型
docs/       产品与接口文档
```

## 本地开发

```bash
npm install
npm run dev
```

PowerShell 如果不能直接运行 `npm`，可以使用：

```powershell
npm.cmd install
npm.cmd run dev
```

## 多端适配

当前已拆出四个端：

- 网页端：`apps/web`
- PWA 端：`apps/web` 的 manifest/service worker
- Android 软件端：`apps/android`
- 微信小程序端：`apps/mp-wechat`，支持本地记录、邮箱验证码登录、手动云同步、基础 AI 辅助编辑和卡片图片导出

校验命令：

```powershell
npm.cmd run build:clients
```

完整说明见 `docs/多端适配说明.md`。

## 环境变量

后端环境变量参考 `apps/api/.env.example`。AI API Key 只放在后端，前端不会暴露密钥。

生产部署变量参考 `deploy/.env.example`。正式上线时需要复制为 `deploy/.env`，并填写域名、数据库密码和 `JWT_SECRET`。

## 云同步

后端同步接口会优先使用 `DATABASE_URL` 指向的 PostgreSQL，并自动创建 `sync_diaries` 表。数据库不可用时会临时回退到内存仓库，方便本地开发，但服务重启后内存数据会丢失。

健康检查会显示当前同步存储状态：

```bash
curl http://localhost:4000/api/health
```

## 图片素材

登录后添加照片时，前端会调用 `POST /api/files/upload` 把图片保存到后端 `STORAGE_DIR` 目录，并在日记里保存 `/uploads/` 可访问 URL。未登录、上传失败或离线时，会自动回退为浏览器本地 Data URL。

浏览器端还会维护一个本地素材库，离线照片会登记到 IndexedDB 的 `assets` 表，编辑器里可以直接复用。本地 JSON 备份从 v3 起会包含这些本地素材；旧 v1/v2 备份仍可导入。

当前文件存储是服务器本地磁盘，后续可以把文件存储层替换为对象存储。

## 当前状态

已完成工程骨架、PWA 配置、照片贴纸编辑器、主体点选/框选流程、装饰贴纸、画笔涂鸦、本地素材库、本地备份、Web/PWA 手动云同步、小程序手动云同步、小程序 AI 写日记/生成贴纸入口、小程序轻量贴纸画布、小程序卡片图片导出、PostgreSQL 同步持久化和 Docker Compose 生产部署配置。接下来可以继续接入真实 AI 服务、真实邮件服务和对象存储。

## 生产部署

部署到自己的服务器可以使用：

```bash
cp deploy/.env.example deploy/.env
npm run deploy:up
```

完整说明见 `docs/部署说明.md`。
