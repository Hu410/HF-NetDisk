# 安全模型

- 浏览器只持有 `HttpOnly; Secure; SameSite=Strict` 会话 Cookie，不接触 Hugging Face 令牌。
- 所有有副作用的 API 请求必须同源；项目不支持 CORS。
- 仓库由服务端 `HF_REPO` 固定，用户不能切换到任意仓库。
- 私有文件始终由 Worker 流式代理；公开文件才可重定向到允许的镜像。
- LFS 上游上传地址保存在 Durable Object，客户端仅使用短期 `uploadId`。
- 分享密码使用带随机盐的 PBKDF2-SHA256 派生值保存，不记录明文密码。分享访问凭据使用独立的 HttpOnly、Secure、SameSite Cookie，错误密码会按分享和客户端限流。
- 文件夹分享下载路径必须保持在被分享目录内；分享过期或撤销会在元数据和下载请求中重新校验。
- 路径经过 Unicode NFC、相对路径和保留目录校验。
- 删除默认进入 `.trash`，彻底删除需要显式操作。
- 错误响应与日志包含请求 ID；日志不得包含 Authorization、Cookie、密码和令牌。

如果发现令牌泄漏，请先在 Hugging Face 撤销令牌，再设置新 Worker Secret。仅从仓库删除历史文件不足以使已泄漏令牌失效。
