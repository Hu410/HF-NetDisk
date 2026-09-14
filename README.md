# HF NetDisk

部署在 Cloudflare Workers 上的个人网盘，使用固定的 Hugging Face Dataset 仓库保存文件。项目支持普通文件与 LFS 分片上传、流式下载、分页目录、移动与重命名、回收站和密码会话登录。

## 部署前准备

需要准备：

- Node.js 22 或更高版本。
- 一个 Cloudflare 账户，并安装项目依赖中的 Wrangler。
- 一个 Hugging Face Dataset 仓库，格式为 `用户名/仓库名`。
- 一个对目标 Dataset 仓库具有读写权限的 Hugging Face Access Token。推荐创建只授权目标仓库的 Fine-grained Token。
- 一个用于登录网盘的独立强密码。

安装依赖并登录 Cloudflare：

```powershell
npm install
npx playwright install chromium
npx wrangler login
```

## 部署时必须修改的配置

### 1. 修改 `wrangler.toml`

至少检查并修改以下内容：

```toml
name = "cloudflare-hf-netdisk"

[vars]
HF_REPO = "你的用户名/你的Dataset仓库名"
HF_PRIVATE = "true"
HF_MIRROR_URL = ""
HF_MIRROR_ALLOWED_HOSTS = ""
MAX_UPLOAD_PARTS = "10000"
```

| 配置 | 是否必须修改 | 说明 |
| --- | --- | --- |
| `name` | 建议 | Cloudflare Worker 名称。同一账户内必须唯一，也是默认 `workers.dev` 地址的一部分。 |
| `HF_REPO` | 必须 | Hugging Face Dataset 仓库，必须使用 `用户名/仓库名` 格式。不要填写模型仓库地址或完整 URL。 |
| `HF_PRIVATE` | 必须核对 | 私有仓库填写字符串 `"true"`，公开仓库填写字符串 `"false"`。值必须与实际仓库可见性一致。 |
| `HF_MIRROR_URL` | 按需 | Hugging Face 下载镜像根地址，必须是 HTTPS。无需镜像时填写空字符串。私有仓库不会使用镜像。 |
| `HF_MIRROR_ALLOWED_HOSTS` | 使用镜像时必须 | 镜像主机白名单，只填写主机名，不包含协议和路径；多个主机使用英文逗号分隔。镜像地址的主机不在此列表中时会自动停用镜像。 |
| `MAX_UPLOAD_PARTS` | 通常无需修改 | 单次 LFS 分片上传允许的最大分片数量，默认 `10000`。降低该值可以更早拒绝异常的大型上传任务。 |

例如使用 `https://hf-mirror.com/` 时，应配套填写：

```toml
HF_MIRROR_URL = "https://hf-mirror.com/"
HF_MIRROR_ALLOWED_HOSTS = "hf-mirror.com"
```

`HF_MIRROR_URL` 和 `HF_MIRROR_ALLOWED_HOSTS` 必须同时正确配置，否则项目会回退到 Hugging Face 官方地址。镜像只用于允许的公开仓库请求，不会接收私有仓库令牌。

### 2. 配置访问域名

如果使用 Cloudflare 自定义域名，请修改 `wrangler.toml` 中的路由：

```toml
routes = [
  { pattern = "disk.example.com/*", zone_name = "example.com" }
]
```

- `pattern`：网盘使用的完整域名加 `/*`。
- `zone_name`：该域名所属、且已经加入当前 Cloudflare 账户的根域名。

如果只使用 Cloudflare 提供的 `workers.dev` 地址，请删除或注释整个 `routes` 配置。部署完成后 Wrangler 会输出实际访问地址。

### 3. 设置生产 Secret

以下两个值是敏感信息，不能写入 `wrangler.toml`、README 或提交到 Git：

```powershell
npx wrangler secret put HF_TOKEN
npx wrangler secret put APP_PASSWORD
```

- `HF_TOKEN`：Hugging Face Access Token，必须能够读取并写入 `HF_REPO` 指定的 Dataset 仓库。
- `APP_PASSWORD`：用户登录此网盘 WebUI 时使用的密码。请使用与 Cloudflare、Hugging Face 密码不同的长随机密码。

Wrangler 会分别提示输入 Secret，输入内容不会写入项目文件。如果后续修改 Worker 名称或切换 Cloudflare 环境，需要为对应 Worker/环境重新设置 Secret。

## 不应随意修改的配置

以下配置已经与代码对应，普通部署应保持不变：

```toml
main = "src/index.js"

[assets]
directory = "frontend"

[[durable_objects.bindings]]
name = "SESSIONS"
class_name = "SessionStore"

[[durable_objects.bindings]]
name = "UPLOADS"
class_name = "UploadSession"

[[durable_objects.bindings]]
name = "SHARES"
class_name = "ShareStore"
```

`SESSIONS` 用于登录会话，`UPLOADS` 用于 LFS 上传会话，`SHARES` 用于分享记录、密码验证和访客访问凭据。删除、改名或漏配这些 Durable Object 绑定会导致登录、大文件上传或分享功能失败。

## 文件分享

登录 WebUI 后，可以在“全部文件”的文件或文件夹操作区、文件详情面板或右键菜单中创建分享。可配置 1 小时、1 天、7 天、30 天或永久有效，并可选择设置访问密码。“分享管理”页面支持复制链接、查看密码与过期状态以及立即撤销。

公开分享页不需要网盘登录。分享密码使用 PBKDF2 派生后保存，不保存明文；验证成功后使用独立的 HttpOnly Cookie。文件夹分享允许访客查看文件列表并逐个下载，不提供跨目录访问或打包下载。过期或撤销的链接会立即失效。

## 执行部署

先运行完整检查，再部署：

```powershell
npm run check
npm run deploy
```

部署后，使用实际访问域名检查健康状态。`scripts/healthcheck.mjs` 默认检查项目示例域名；部署到自己的域名时，可在本地创建不会提交到 Git 的 `.integration.vars`：

```text
HF_NETDISK_BASE_URL=https://disk.example.com
HF_NETDISK_PASSWORD=你的APP_PASSWORD
```

然后执行：

```powershell
npm run health
```

健康检查中的 `sessions`、`uploads`、`repository` 和 `authentication` 应全部为 `true`。首次上线后还应实际验证登录、上传、下载、移动、删除、回收站恢复和清空功能。

## 本地开发

复制本地 Secret 示例文件：

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

编辑 `.dev.vars`：

```text
HF_TOKEN=你的HuggingFace令牌
APP_PASSWORD=你的本地登录密码
```

本地运行仍会读取 `wrangler.toml` 中的 `HF_REPO`、`HF_PRIVATE` 和镜像设置。`.dev.vars` 已被 `.gitignore` 忽略，不要强制提交该文件。

## 测试与运维文档

```powershell
npm run lint
npm test
npm run e2e
npm run build:check
```

`npm run e2e` 使用模拟 API，不会访问真实 Hugging Face 仓库。真实仓库集成测试会创建、移动和删除测试文件，只有显式设置 `HF_NETDISK_RUN_INTEGRATION=1` 后才应执行 `npm run integration`。

- [部署检查表](./docs/DEPLOYMENT.md)
- [验证说明](./docs/VALIDATION.md)
- [生产运维与回滚](./docs/OPERATIONS.md)
- [安全边界](./docs/SECURITY.md)
- [API 契约](./openapi.yaml)
