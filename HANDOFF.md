# SeedLandV 生产化迁移 — 会话交接文档

**更新于**:2026-04-28
**当前状态**:Phase 0-3 完成且端到端验证(用真 Ark Key 跑通文生视频),代码已 commit
**下一步**:Phase 4 — 资产上传 → 火山 TOS
**项目根**:`/Applications/SeedLandV/SeedLandV`(Mac;原 Windows 路径 `d:\SeedLandV` 已废弃)

---

## 1. 当前进度

| 阶段 | 状态 | 备注 |
|---|---|---|
| Phase 0 — 仓库 + Docker + Postgres + Redis + TOS | ✅ 全绿 | `verify_phase0.py` 三行 OK |
| Phase 1 — FastAPI + JWT auth | ✅ 5/5 绿 | `verify_phase1.py` exit 0 |
| Phase 2 — Ark Python 端口 + Celery worker | ✅ 37/37 单测 + 端到端 | `pytest -q` 1.4s |
| Phase 3 — WS 路由 + Electron 瘦身 | ✅ 真 Ark Key 文生视频跑通 | 见 §3 |
| Phase 4 — 资产上传 → TOS | ⏳ 待开 | 详 §5 |
| Phase 5 — TOS 镜像 + 签名 URL | ⏳ | 详 §6 |
| Phase 6 — 限流 + 重试 + 监控 | ⏳ | |
| Phase 7 — Helm + VKE 部署 | ⏳ | |

---

## 2. 重启服务(每次新会话开始跑这些)

```bash
cd /Applications/SeedLandV/SeedLandV

# 1) 起容器
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker compose -f docker-compose.dev.yml up -d

# 2) 起 API(终端 A)
cd server && .venv/bin/uvicorn app.main:app --reload

# 3) 起 worker(终端 B)
cd server && .venv/bin/celery -A app.workers.celery_app:celery_app worker -P solo --loglevel=info

# 4) 起 Electron(终端 C — 注意 Cursor 终端必须 unset 那个变量)
env -u ELECTRON_RUN_AS_NODE npm run dev
```

**docker CLI 路径坑**:Mac 上 docker-compose 默认找不到 `docker-credential-desktop`,把 `/Applications/Docker.app/Contents/Resources/bin` 加 PATH 就好。

**Cursor 终端坑**:Cursor 注入 `ELECTRON_RUN_AS_NODE=1`,直接 `npm run dev` 会让 Electron 当 Node 跑然后 `app.isPackaged` 报 undefined。永远 `env -u ELECTRON_RUN_AS_NODE` 前缀,或在系统 Terminal.app 里跑。

---

## 3. Phase 3 实装一览(已 commit)

### Server side(`server/app/`)
- `realtime/connections.py` — `TenantHub` per-tenant WS 连接 + Redis async 订阅 task,惰性启停
- `realtime/publisher.py` — 同步 publisher(Phase 2 已存在,Celery worker 用)
- `routes/ws.py` — `/ws/tasks?token=...`,JWT 校验 + 持久 receive_text 循环
- `main.py` — wire `ws_router`
- `workers/tasks.py` — `_publish_snapshot(session, task)` 改吐完整 `TaskOut` shape(含 mode/prompt/params/assetsPreview/createdAt,camelCase 键),修复 `_ark_client_for` 异常未捕获导致任务卡 `submitting` 的 bug
- `routes/tenants.py` — PUT `/v1/tenants/me/ark-key` 收到 key 后先用它打一次 Ark sentinel UUID(401/403 → 拒绝;其它 → 接受)

### Electron side
- `electron/api/http.ts` — fetch 包装,从 main 端取 token,renderer 永远摸不到 token
- `electron/api/auth.ts` — token 通过 Electron `safeStorage`(macOS Keychain / Windows DPAPI)持久到 `userData/auth.bin`
- `electron/api/client.ts` — task CRUD + tenant Ark Key,包了一次 401 自动 refresh
- `electron/api/socket.ts` — `ws` 库的 WebSocket,1s→30s 指数退避重连,login/logout/refresh 时 rebind
- `electron/shared/validate.ts` — 9/3/3 mode 校验,renderer 提交前可调
- `electron/main.ts` — 重写为 HTTP/WS 代理,删了 `tasks Map` / `controllers Map` / 直调 Ark
- `electron/preload.ts` — 加 `login/register/logout/getAuthState/setArkKey/getArkKeyStatus` IPC 通道
- `electron/shared/types.ts` — `TaskRecord` 加 `serverId: string`(取代 localId 作 server 寻址),`AuthState` 在这里定义
- `electron/ark/` — 整个目录已删

### Renderer side(`src/`)
- `components/auth/AuthGate.tsx` — 邮箱/密码登录注册模态(注册创建 tenant)
- `components/auth/ArkKeyPrompt.tsx` — Ark Key 配置/重设模态(初次必填,重设可关)
- `components/layout/Topbar.tsx` — ARK Key 徽章可点 → 触发 ArkKeyPrompt
- `components/tasks/TaskCard.tsx` — `cancelTask`/`removeTask` 改用 `task.serverId`
- `lib/store.ts` — 加 `authState` + `arkKeyPromptOpen`
- `App.tsx` — auth gate;登录后 lazy fetch tasks/apiStatus + WS 监听

### 依赖变更
- `package.json` — 加 `ws@^8.18.0` + `@types/ws`(Electron 33 的 Node 20 没原生 WebSocket)
- `server/pyproject.toml` — `pydantic` → `pydantic[email]`(EmailStr 需要 email-validator)

### Commit 列表
```
7d519fe docs: Phase 0-2 handoff document from prior session
b7da06b feat(renderer): auth gate + Ark Key modal + Topbar reset trigger
9a2b7b4 feat(electron): thin HTTP/WS proxy main, drop in-process Ark loop
eb419ec feat(server): probe Ark Key liveness before persisting
714663f feat(server): WebSocket task updates + full TaskOut snapshot publishing
01eb95f fix(server): pydantic[email] dep + Phase 1 verify script Mac compat
3b3298e Initial commit: SeedLandV project import
```

---

## 4. Phase 3 验证步骤(可选,确认环境没坏)

```bash
cd server && .venv/bin/pytest -q                        # 期 37 passed
.venv/bin/python scripts/verify_phase0.py               # 期 3 行 [OK]
.venv/bin/python scripts/verify_phase1.py && echo $?    # 期 5 行 [OK] + exit 0
```

Electron 内手动测:Topbar 点徽章 → 重设 Ark Key 模态(close button 应可见)→ 输错 key(如把 TOS AK 贴进去)期望 server 返回 400 红字。

---

## 5. Phase 4 实施计划 — 资产上传 → TOS

### 目标
Electron 选本地图片/视频 → main 进程 multipart 流到 server `POST /v1/assets` → server 流式 put 到 TOS,生成 `tos_key` → 返回 `asset_token`(随机字符串,Redis 存 1h TTL,值是 `{tos_key, mime, size_bytes}`)→ 前端 submit 时 assets 数组里带 `asset_token` → worker `_resolve_assets` 拿 token 反查 `tos_key`,调 `generate_presigned_get_url(7d)` 给 Ark。

### Server side 改动

**新增**:
- `app/storage/tos.py` — `TosClient` 包装(venv 里已有 `tos` SDK):
  - `__init__()` 从 settings 读 AK/SK/region/endpoint/bucket
  - `put_object_streaming(key: str, stream, content_type: str | None = None) -> None`
  - `generate_presigned_get_url(key: str, ttl_seconds: int = 7*24*3600) -> str`
- `app/routes/assets.py` — `POST /v1/assets`(multipart),用 FastAPI `UploadFile`:
  - 校验 `kind` ∈ `{image, video, audio}` + 文件 mime + 大小上限(图 20MB / 视频 200MB / 音 50MB)
  - key 形如 `seedlandv/uploads/{yyyy}/{mm}/{dd}/{uuid4}{ext}`
  - 调 `tos.put_object_streaming` 拿到 key
  - 生成 `asset_token`(`secrets.token_urlsafe(24)`)→ Redis `SETEX asset_token:{token} 3600 <json>`
  - 返回 `{asset_token, kind, mime, size_bytes}`
- `tests/test_storage_tos.py` — mock TOS SDK 的 put / sign,验证 key 生成 + URL TTL

**修改**:
- `app/routes/tasks.py` — `submit_task` 中遇到 `AssetSourceUpload` 不再 501,而是从 Redis 拉 token 反查 `tos_key`,塞进 `task_assets` 行的 `tos_key` 字段
- `app/workers/tasks.py::_resolve_assets` — `source='upload'` 分支调 `tos.generate_presigned_get_url(row.tos_key)` 取代当前 RuntimeError
- `app/main.py` — wire `assets_router`

### Electron side 改动

**新增**:
- `electron/api/upload.ts` — `uploadAsset(filePath, kind)`:`fs.createReadStream` → `FormData` → `POST /v1/assets`,返回 `asset_token`
- main.ts 加 IPC `api:uploadAsset` 包一层

**修改**:
- `electron/preload.ts` — 暴露 `uploadAsset`
- renderer asset picker(`src/components/asset/AssetPicker.tsx`)— 选完文件先调 `uploadAsset` 拿 token,把 `AssetSource.mode` 从 `'local'` 改成 `'upload'`,带 `asset_token` 字段
- `electron/shared/types.ts` — `AssetSource` 加 `{ kind, mode: 'upload', asset_token: string, name: string }` 变体
- `electron/api/client.ts::submitTask` — `mode === 'upload'` 时 forward `asset_token` 给 server,删掉当前 throw

### 验证
- 单测覆盖 `app/storage/tos.py` 的 mock 路径
- 端到端:图生视频选本地 png → 上传 → 提交 → worker 用签名 URL 调 Ark → 出视频
- 失败用例:超 size、bad mime、token 过期(1h 后)、不属于自己 tenant 的 token(未来 Phase 6 加严)

### 设计抉择留笔记
- **token 而不是直接返回 tos_key**:用户拿到 tos_key 可以推测 bucket 结构,token 是不透明的,Redis TTL 也限制了滥用窗口
- **multipart 而不是 presigned PUT**:第一版选简单的方式,用户上传过 server,server 流式给 TOS。Phase 6 可以加 presigned PUT 让客户端直传,但要考虑 CORS 与凭证泄露
- **大小上限**:写在 server 端,renderer 也可加 pre-flight 提示但 server 是真理之源

---

## 6. Phase 5 — TOS 产物镜像(预览,等 Phase 4 后再做)

- `app/workers/tasks.py::tos_mirror_video(task_id)` — `SELECT FOR UPDATE SKIP LOCKED WHERE status='succeeded' AND tos_video_key IS NULL`,流式从 Ark URL 拉到 TOS `videos/{yyyy}/{mm}/{dd}/{uuid}/video.mp4`
- `ark_submit_and_poll` succeeded 时 `tos_mirror_video.delay(task_id)`
- `GET /v1/tasks/{uuid}/video-url` — 取 tos_video_key 现签 7d URL
- Celery beat:`mirror_retry_sweep`(小时)+ `signed_url_refresh`(每天)
- WS 推送优先 `tos_video_url`,fallback `ark_video_url`

---

## 7. 已知坑 / 已记录到 memory

| 坑 | 表现 | 怎么避 |
|---|---|---|
| Cursor 终端 `ELECTRON_RUN_AS_NODE=1` | `npm run dev` 立刻崩 `app.isPackaged undefined` | `env -u ELECTRON_RUN_AS_NODE npm run dev` |
| 收用户 API key 只校验长度 | 输错也能存进 DB,worker 跑时才报 401 | server 端 PUT 时探测一次目标服务,401 拒收 |
| docker-compose `docker-credential-desktop` not found | Mac 上首次 `docker compose pull` 报错 | `export PATH=/Applications/Docker.app/Contents/Resources/bin:$PATH` |
| `email-validator` 拒 `.local` | `verify_phase1.py` 老脚本失败 | 测试邮箱用 `@example.com`(IANA 保留) |

---

## 8. 当前后台进程(本次会话留下,可能还在跑)

```bash
# 查
docker ps --format 'table {{.Names}}\t{{.Status}}'  # postgres + redis
pgrep -fl "uvicorn|celery|electron-vite|Electron " | head -10

# 全停(下次会话开始前可以先清干净)
pkill -f "uvicorn|celery|electron-vite"
docker compose -f docker-compose.dev.yml down
```

日志路径:
- uvicorn: `/tmp/seedlandv-uvicorn.log`
- celery: `/tmp/seedlandv-celery.log`
- electron-vite: `/tmp/seedlandv-electron.log`

---

## 9. 下一会话开场白模板

> 继续 SeedLandV。Phase 0-3 已完成且端到端跑通,代码全 commit 在 `init` 分支。先读 `/Applications/SeedLandV/SeedLandV/HANDOFF.md` 拿状态,按 §2 起服务,跑 §4 验证一下没坏,然后开 §5 Phase 4(资产上传 → TOS)。
