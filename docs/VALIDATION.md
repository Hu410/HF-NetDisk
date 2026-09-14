# 真实环境验证记录

## 验证结果（2026-08-29）

- Worker 已部署到 `hf.relc.eu.org/*`，最终版本 `7fef9902-36aa-4911-a652-1d691384e7d2`。
- `HF_TOKEN` 与 `APP_PASSWORD` 已通过 Worker Secret 绑定，未写入项目文件。
- 真实小文件流程通过：登录、上传、完整下载、Range、原子重命名、回收站、恢复、彻底清理。
- 真实 LFS 流程通过：96 MiB、multipart、7 个分片、Range 内容校验和自动清理。
- 只读性能测试：5 并发、50 请求、0 失败；P50 379.9 ms，P95 1627.5 ms，最大 3106.6 ms。
- 真实 LFS 测试发现并修复了 Hugging Face multipart 数字键并非固定从 1 开始的兼容性问题。

## 再次执行条件

1. 撤销曾出现在源码中的旧 Hugging Face Token。
2. 创建仅用于目标仓库的新写入 Token。
3. 使用 `wrangler secret put HF_TOKEN` 和 `wrangler secret put APP_PASSWORD` 配置 Secret。
4. 部署测试 Worker，并将其地址和新应用密码仅注入当前终端环境。

## 测试命令

复制 `.integration.vars.example` 为被 Git 忽略的 `.integration.vars` 并填写当前应用密码。真实集成测试只在 `.integration-tests/` 下创建文件，并在结束时尝试清理：

```powershell
$env:HF_NETDISK_RUN_INTEGRATION='1'
$env:HF_NETDISK_BASE_URL='https://your-test-worker.example'
$env:HF_NETDISK_PASSWORD='your-new-app-password'
npm run integration
```

只读并发测试：

```powershell
$env:HF_NETDISK_BASE_URL='https://your-test-worker.example'
$env:HF_NETDISK_PASSWORD='your-new-app-password'
$env:HF_NETDISK_CONCURRENCY='5'
$env:HF_NETDISK_REQUESTS='50'
npm run performance
```

集成测试验证登录、小文件上传、完整下载、Range 下载、原子重命名、回收站、恢复与彻底清理。性能脚本只读取分页目录，输出成功数、失败数和最小值、P50、P95、最大延迟。

## 验收建议

- 所有集成检查通过且 `.integration-tests/` 无残留。
- 50 次只读请求无错误，P95 延迟记录到发布报告。
- 另行通过浏览器验证 100 MiB 以上 LFS 文件；测试后核对上传会话能够完成或被 alarm 清理。
- 使用 Cloudflare 仪表盘核对错误率、CPU 时间和 Durable Object 请求量。
