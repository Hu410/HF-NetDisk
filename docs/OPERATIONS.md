# 生产运维手册

## 日常检查

```powershell
npm run health
npx wrangler deployments status
npx wrangler secret list
```

`/api/health` 只返回会话、上传、分享、仓库和认证五类依赖是否就绪，不返回仓库名、Token、密码或 Durable Object 标识。正常状态码为 200，正文 `status` 为 `ok`。

## 日志与告警

Wrangler 已启用 10% 持久化日志采样。结构化异常包含 `requestId`、方法、路径和脱敏错误信息。在 Cloudflare 控制台创建以下通知：

- Worker 错误率连续 5 分钟超过 2%。
- `/api/health` 连续 3 次非 200。
- P95 响应时间连续 10 分钟超过 3 秒。
- Durable Object 或 Worker 请求量明显偏离日常基线。

处理用户错误时，用响应中的 `X-Request-Id` 查询日志。不要记录或复制 Cookie、Authorization、密码和 Hugging Face Token。

## 回滚

先查看部署历史并选择已知健康版本：

```powershell
npx wrangler deployments list
npx wrangler versions view <version-id>
npx wrangler rollback <version-id> --message "rollback: <reason>"
npm run health
```

回滚 Worker 不会撤销 Hugging Face 文件提交，也不会删除 Durable Object 数据。涉及误删文件时应使用回收站恢复；涉及错误提交时，应根据 Hugging Face 历史创建修复提交。

## 恢复演练

无损演练使用真实集成测试：它在 `.integration-tests/` 创建唯一文件，验证删除和恢复后再次删除并清除。执行前确认 `.integration.vars` 指向生产域名，随后运行：

```powershell
npm run integration
npm run health
```

不要在健康生产版本上为了演练而执行实际回滚。回滚命令、权限、版本历史和健康检查均可用，即视为回滚前置条件通过。

## 凭据事件

1. 立即在 Hugging Face 撤销旧 Token。
2. 创建最小权限新 Token并运行 `npx wrangler secret put HF_TOKEN`。
3. 必要时轮换 `APP_PASSWORD`；现有会话仍应主动退出或等待过期。
4. 部署、运行健康检查和真实集成测试。
5. 检查日志中是否出现异常文件操作。
