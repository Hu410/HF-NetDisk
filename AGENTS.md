# Repository Guidelines

## Project Structure & Module Organization

`src/index.js` is the Cloudflare Worker entry point. API handlers live in `src/routes/`, shared helpers in `src/utils/`, and Durable Object implementations in `src/durableObjects/`. The static application is under `frontend/`, organized into page scripts, state, utilities, and CSS. Unit and request-level tests are `test/*.test.js`; browser tests are in `test/e2e/`. Operational scripts live in `scripts/`, while deployment, security, and validation notes are in `docs/`. Keep API behavior aligned with `openapi.yaml` and Worker bindings in `wrangler.toml`.

## Build, Test, and Development Commands

- `npm ci` installs the exact locked dependency set.
- `npm run dev` starts Wrangler locally on port 8787; copy `.dev.vars.example` to `.dev.vars` first.
- `npm run lint` checks all JavaScript with ESLint and allows no warnings.
- `npm test` runs the Vitest suite once.
- `npm run e2e` runs Playwright against the local mock-backed static server.
- `npm run build:check` performs a Wrangler dry-run deployment.
- `npm run check` runs the full CI sequence: lint, unit tests, E2E tests, and deployment validation.

## Coding Style & Naming Conventions

Use modern ES modules, single quotes, semicolons, and two-space indentation. Prefer `camelCase` for variables and functions, `PascalCase` for exported classes, and descriptive lowercase filenames such as `uploadSession.js`. Route handlers should return consistent JSON responses through shared response helpers. ESLint configuration in `eslint.config.js` defines separate Worker, browser, and Node globals; prefix intentionally unused parameters with `_`.

## Testing Guidelines

Use Vitest (`describe`, `it`, `expect`) for modules and API boundaries. Name files `<feature>.test.js` and place browser journeys in `test/e2e/*.spec.js`. Add regression tests with every behavior change and cover success, authorization, and failure paths where relevant. There is no numeric coverage threshold; `npm run check` is the required baseline. Real-repository integration scripts require `.integration.vars` and explicit `HF_NETDISK_RUN_INTEGRATION=1`; they may create, move, and delete test files.

## Commit & Pull Request Guidelines

Recent commits use short Chinese summaries describing the delivered change (for example, `新增文件分享和分享管理功能`). Follow that concise, action-oriented style and avoid vague messages. Keep commits focused. Pull requests should explain the motivation and behavior change, link relevant issues, list verification commands, and include screenshots for frontend changes. Call out configuration, binding, security, or API-contract changes explicitly.

## Security & Configuration

Never commit `.dev.vars`, `.integration.vars`, tokens, passwords, logs, or generated test output. Use the tracked example files as templates and review `docs/SECURITY.md` and `docs/DEPLOYMENT.md` before changing authentication, secrets, or production bindings.
