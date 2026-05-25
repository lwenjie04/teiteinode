# 贴贴日记 Android 端

这是安卓软件端的原生 WebView 壳，默认加载本机开发服务：

```text
http://10.0.2.2:5173
```

本地调试时先在项目根目录运行：

```powershell
npm.cmd run dev
```

然后用 Android Studio 打开 `apps/android`。发布前把 `app/build.gradle` 里的 `TIETIE_WEB_URL` 改成你的 HTTPS 正式域名，再构建 APK/AAB。

当前壳已启用：

- JavaScript、IndexedDB/localStorage
- 图片文件选择
- 后退/前进由 WebView 管理
- 开发环境 HTTP 明文访问

后续可继续补：原生拍照回调、系统分享、推送通知、沉浸式状态栏。
