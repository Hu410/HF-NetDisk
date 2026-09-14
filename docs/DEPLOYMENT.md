# 部署检查表

## 首次部署

- 在 Hugging Face 创建专用、最小权限的写入令牌。
- 确认 `wrangler.toml` 的 `HF_REPO`、`HF_PRIVATE` 与镜像白名单正确。
- 执行 `npx wrangler secret put HF_TOKEN`。
- 执行 `npx wrangler secret put APP_PASSWORD`，使用独立的长随机密码。
- 执行 `npm run check`，随后执行 `npm run deploy`。
- 登录后验证小文件上传、LFS 上传、Range 下载、重命名、回收站恢复与清除。

## 发布前

- `npm ci`、`npx playwright install chromium` 与 `npm run check` 全部通过。
- 工作区与 CI 日志中不存在令牌或明文密码。
- 私有仓库下载未经过镜像。
- `MAX_UPLOAD_PARTS` 不超过上游限制，上传会话可由 Durable Object alarm 清理。
- 已记录回滚版本；Worker 回滚不会自动回滚 Hugging Face 文件提交。

## 轮换 Secret

重新执行相应的 `wrangler secret put`，部署并验证后撤销旧 Hugging Face 令牌。不要把 Secret 写入 `wrangler.toml`、`.dev.vars.example` 或 CI 变量输出。
