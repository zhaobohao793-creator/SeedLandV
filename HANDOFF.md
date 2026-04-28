# SeedLandV 生产化迁移 — 会话交接文档

**日期**：2026-04-26
**用途**：从 Electron 单机客户端 → FastAPI + Celery + Postgres + 火山 TOS 的批量视频生成服务
**触发**：用户准备投入生产承接大量视频订单，对照火山引擎官方 2.2 节要求（批量、异步、本地稳定性、VKE 容器化）发现当前实现完全不达标
**完整 plan 文件**：`C:\Users\Administrator\.claude\plans\plan-drifting-sonnet.md`（用户已批准）

---

## 1. 用户已确认的关键决策

| 决策点 | 选择 | 影响 |
|---|---|---|
| 客户端形态 | **Electron + 未来 Web UI 并存** | 后端从第一天就上多租户 + JWT auth；schema 含 `tenants` / `users` 表 |
| 本地开发对象存储 | **直连真 TOS 测试桶** | 不引入 MinIO；docker-compose 仅起 Postgres + Redis；TOS bucket 用户在火山控制台手开 |
| 首批落地范围 | **Phase 0-5**（含上传 + TOS 镜像）| 完整数据闭环，并发限流/VKE 推到 Phase 6-7 |

---

## 2. 本会话已完成的工作（Phase 0 → 2，共 50+ 文件）

### Phase 0 — 仓库结构 + 基础设施

```
[server/]                              # 新建后端 Python 树
├── pyproject.toml                     # python>=3.11,<3.14；依赖含 fastapi/sqlalchemy/celery/httpx/tos/python-jose/passlib/cryptography/gevent
├── README.md                          # dev 启动步骤 + 用户前置准备清单
├── alembic.ini, alembic/env.py        # 异步引擎 → 同步迁移（psycopg 3 双模式）
├── alembic/versions/20260426_0001_initial.py  # 5 表 + task_status enum + updated_at trigger
├── Dockerfile.api, Dockerfile.worker  # python:3.12-slim
├── scripts/verify_phase0.py           # Postgres + Redis + TOS head_bucket 自检
└── scripts/verify_phase1.py           # auth flow E2E 自检

[docker-compose.dev.yml]               # postgres:16 + redis:7（api 服务用 --profile api 选启）
[.env.example]                         # 12 个变量，分四组：客户端/后端/JWT/TOS
[.gitignore]                           # 增 server/.venv、__pycache__、egg-info、pytest_cache
```

### Phase 1 — FastAPI 骨架 + 多租户 JWT

```
server/app/
├── config.py                          # pydantic-settings，从根目录或 server/ 读 .env
├── main.py                            # FastAPI app + CORS + healthz + 三个 router
├── db/
│   ├── base.py                        # DeclarativeBase + 命名约定
│   ├── session.py                     # async engine + AsyncSession factory + get_session dep
│   └── sync_session.py                # 同步 engine（Celery worker 用）
├── models/
│   ├── enums.py                       # TaskStatus(11 值) / GenerationMode(4 值) / AssetKind / AssetSource
│   ├── tenant.py                      # tenants(id, name, ark_api_key_ciphertext, created_at)
│   ├── user.py                        # users(id, tenant_id, email UNIQUE, password_hash)
│   ├── task.py                        # tasks(uuid, local_id, ark_task_id, mode, prompt, params JSONB, status enum, ark_video_url, tos_video_url, usage, error, attempt, ...)
│   ├── asset.py                       # task_assets(task_id, position, kind, source, origin_url, tos_key, sha256, ...)
│   └── event.py                       # task_events(task_id, at, kind, status, payload JSONB)
└── auth/
    ├── security.py                    # argon2 + JWT encode_access/refresh + decode + TokenError
    ├── schemas.py                     # RegisterRequest / LoginRequest / TokenResponse / UserOut
    ├── deps.py                        # get_current_user (HTTPBearer + DB lookup) + get_current_tenant_id
    └── routes.py                      # POST /v1/auth/{register,login,refresh}, GET /me
```

**Auth 设计要点**：
- access token 1h，refresh token 7d，HS256
- 注册时同时建 `tenant` + `user`（一对一），未来 Web UI 接邀请流再扩展
- Ark API Key 不放 `.env`，按租户存 `tenants.ark_api_key_ciphertext`，Fernet 对称加密

### Phase 2 — Ark 全栈 Python 端口 + Celery worker

```
server/app/
├── ark/
│   ├── types.py                       # Pydantic 镜像 ArkContentItem(text/image_url/video_url/audio_url with discriminator) / ArkSubmitPayload / ArkTaskResponse
│   ├── errors.py                      # 1:1 端口 d:\SeedLandV\electron\ark\errors.ts：CODE_MAP(50+ 项) + HTTP_MAP + lookup_by_code(前缀回退) + translate_ark_error + parse_ark_error_body
│   ├── client.py                      # ArkClient(api_key, base_url) sync httpx；submit + get_task；ArkError(.status, .raw, .code, .is_transient)
│   ├── builder.py                     # validate_by_mode(9 图/3 视频/3 音频) + build_payload(text + 4 mode role 映射)；新增 ResolvedAsset / TaskParams 数据类
│   └── poller.py                      # poll_until_done：3s 起 1.3x 退避 cap 10s timeout 15min；transient 5xx warn-continue；on_update + cancel_check 钩子
├── auth/crypto.py                     # encrypt_ark_key / decrypt_ark_key（Fernet）
├── realtime/
│   └── publisher.py                   # publish_task_update(tenant_id, payload) → Redis channel `task:{tenant_id}`（Phase 3 WS 订阅）
├── workers/
│   ├── celery_app.py                  # Celery(broker=redis, backend=redis)；task_acks_late=True / reject_on_worker_lost / track_started
│   └── tasks.py                       # ark_submit_and_poll(task_id)：取 DB 行 → resolve assets → build payload → submit → poll → 每个 delta 写 task + task_event + 发 Redis；handle build/submit/poll 三类错误
├── schemas/tasks.py                   # SubmitTaskRequest(localId/mode/prompt/assets/params with AssetSourceUrl|AssetSourceUpload discriminator) / TaskOut(server_id/id/localId/status/videoUrl/...)
└── routes/
    ├── tasks.py                       # POST /v1/tasks (202 + 入队) / GET /v1/tasks (列表) / GET /v1/tasks/{uuid} / DELETE
    └── tenants.py                     # PUT/GET/DELETE /v1/tenants/me/ark-key（Fernet 加密入库）
```

**关键设计选择**：
- Celery worker 走 **同步**（gevent pool），简化代码；FastAPI 路由走 async
- 同一个 SQLAlchemy URL（`postgresql+psycopg://`）双模式工作，async/sync engine 各取所需
- worker 失败分三类：build / submit / poll，分别落 `task_events.kind` 便于审计
- Phase 2 暂不接收 `mode='upload'` 资产（路由 401，Phase 4 才解锁）

### Phase 2 测试覆盖（37 个全绿，pytest 1.26s）

```
server/tests/
├── conftest.py                        # 注入测试用 env defaults（不连真 DB/Redis）
├── test_ark_errors.py     12 个      # CODE_MAP 抽样、prefix 匹配、HTTP fallback、body 解析
├── test_ark_builder.py    13 个      # 4 mode 校验、role 映射、9/3/3 上限、blank prompt、seed 处理、position 排序
├── test_ark_poller.py      6 个      # terminal 退出、transient 5xx 跳过、fatal 4xx 抛、timeout、cancel
└── test_ark_client.py      6 个      # respx mock 提交/查询/错误翻译/缺 id 校验/缺 key 校验
```

```
server/scripts/smoke_e2e.py            # 真 Ark 跑通 text-to-video 480p/3s/Fast 模型的端到端验证
```

---

## 3. 已验证 vs 未验证

| 层级 | 状态 |
|---|---|
| 文件语法（compileall） | ✅ 全部通过 |
| Phase 2 业务单元测试 | ✅ 37/37 绿 |
| Phase 0 基础设施连通性 | ❌ Docker 未装；用户必须先装 Docker Desktop + 开 TOS bucket |
| Phase 1 auth flow E2E | ❌ 需先把 Phase 0 拉起 + uvicorn 启动 |
| Phase 2 真 Ark E2E | ❌ 需把 Phase 0/1 拉起 + Celery worker 启动 + 配 Ark Key |

---

## 4. 已知阻塞 / 用户必须做的前置

1. **装 Docker Desktop for Windows**（docker-compose.dev.yml 需要它）
2. **火山控制台**：
   - 创建 TOS bucket（建议 `seedlandv-dev`，cn-beijing 区）
   - 创建子账号，授 `TOSFullAccess` 限定到该 bucket，拿 AK/SK
3. **生成两个本地密钥**：
   ```bash
   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
4. **复制 `.env.example` 为 `.env`** 填上 5 个必填项：`VOLC_TOS_AK/SK/BUCKET`、`JWT_SECRET`、`ARK_KEY_FERNET_SECRET`
5. **Python 版本**：当前主机 3.14.4，但 pyproject 限 `<3.14`（gevent / psycopg 部分 wheel 缺）。建议本地装 Python 3.12 跑 server。Dockerfile 已固定 `python:3.12-slim`，容器化路径不受影响

---

## 5. 完整启动序列（第一次跑全栈）

```bash
# 1. 基础设施
cd /d/SeedLandV
docker compose -f docker-compose.dev.yml up -d

# 2. 后端依赖
cd server
python -m venv .venv
source .venv/Scripts/activate
pip install -e ".[dev]"

# 3. 验证 Phase 0 三件套
python scripts/verify_phase0.py
# 期待：[OK ] Postgres / [OK ] Redis / [OK ] 火山 TOS

# 4. 迁移
alembic upgrade head

# 5. 启 API（终端 A）
uvicorn app.main:app --reload

# 6. 启 worker（终端 B）
celery -A app.workers.celery_app:celery_app worker -P solo --loglevel=info
# 注：dev 用 -P solo 单进程；生产 Dockerfile.worker 用 -P gevent --concurrency=50

# 7. 验证 Phase 1 auth（终端 C）
python scripts/verify_phase1.py
# 期待 6 个 OK

# 8. 验证 Phase 2 真 Ark E2E（终端 C）
VOLC_ARK_API_KEY=ark_xxx python scripts/smoke_e2e.py
# 期待 status=succeeded + videoUrl 落出
```

---

## 6. Phase 3 详细计划（下一个会话从这里接）

**目标**：Renderer 完全由后端驱动，UI 零改动；Electron 主进程瘦身为 HTTP/WS 代理。

### 6.1 后端新增（server/）

```
app/realtime/
├── subscriber.py                      # 新建：Redis pub/sub 消费者，解析 channel `task:{tenant_id}` 消息
└── connections.py                     # 新建：管理 WebSocket 连接，按 tenant_id 索引

app/routes/ws.py                       # 新建：WebSocket 端点 /ws/tasks?token=...
                                       # - 握手时解 JWT，提取 tenant_id
                                       # - 启动 Redis subscribe 后台任务
                                       # - 收到消息后 send_json 给该 tenant 的所有连接
                                       # - 心跳 + reconnect 友好（client 端处理）

app/main.py                            # 修改：app.include_router(ws_router) 或 app.add_api_websocket_route
```

### 6.2 Electron 端改造

**新增 `electron/api/`**：
```
electron/api/
├── http.ts                            # fetch 封装，base URL 从 SEEDLANDV_API_URL env
├── auth.ts                            # safeStorage 持久化 token；启动 refresh；登录窗口集成
├── client.ts                          # submitTask / cancelTask / listTasks / removeTask /
                                       # clearTasks / uploadAsset(占位，Phase 4 实现) /
                                       # login / register / refreshToken / setArkKey
└── socket.ts                          # WebSocket 连接 + 指数退避重连；
                                       # socket.on('task:update', t => mainWindow.webContents.send('task:update', t))
```

**修改 [electron/main.ts](electron/main.ts)**：
- 删除 `tasks = new Map<string, TaskRecord>()` (line 30)
- 删除 `controllers = new Map<string, AbortController>()` (line 31)
- 删除 import `arkSubmit, ArkError, buildPayload, pollUntilDone`
- 替换 `api:submit` 内部从直调 Ark 改为 → `await client.submitTask(input)`
- `api:listTasks` → `await client.listTasks()`
- `api:cancel` → `await client.cancelTask(localId)`
- `api:removeTask` → `await client.removeTask(localId)`
- `api:clearTasks` → `await client.clearTasks()`
- `task:update` 来源从内部 `broadcastTask()` 改为 `socket.on('task:update', ...)` 转发
- 启动时调 `auth.bootstrap()`，没 token 弹登录窗口

**保留**（main.ts 内）：
- `api:pickFile` 不变
- `api:downloadVideo` 不变（URL 来源现在是 TOS）
- `api:openExternal` 不变

**migrate**：把 [electron/ark/tasks.ts](electron/ark/tasks.ts) 的 `validateByMode` 9/3/3 校验逻辑迁到 `electron/shared/validate.ts`（renderer pre-submit UX 提示用）

**删除**：
- [electron/ark/client.ts](electron/ark/client.ts)
- [electron/ark/poller.ts](electron/ark/poller.ts)
- [electron/ark/errors.ts](electron/ark/errors.ts)
- [electron/ark/encode.ts](electron/ark/encode.ts)
- [electron/ark/tasks.ts](electron/ark/tasks.ts)（校验迁出后）
- [electron/ark/types.ts](electron/ark/types.ts)（DTO 迁到 shared/）

**preload + renderer**：**零改动**。`window.seedland` 契约保持完全一致，TaskRecord 字段名不变，`task:update` 事件 shape 不变。

### 6.3 关键 contract 复盘（实施时核对）

renderer 期望的 TaskRecord 字段（不能漏！）：
```ts
{ id, localId, mode, prompt, params, assetsPreview,
  status, videoUrl?, lastFrameUrl?, error?, createdAt, updatedAt, usage? }
```

server `TaskOut` 已对齐（[server/app/schemas/tasks.py](server/app/schemas/tasks.py)）。WS 推送 payload 看 [server/app/workers/tasks.py:_publish_snapshot](server/app/workers/tasks.py)，也已对齐。**注意：renderer 用 `localId` 做匹配键，所以 server 必须每条 WS 事件回传 `localId`**（已实现）。

### 6.4 Phase 3 验证

- 启动 docker compose + uvicorn + celery + Electron dev
- Electron 弹登录窗口，注册一个用户
- 配 tenant Ark Key（暂时手动 PUT 一次或在登录后加 UI）
- 提交 text-to-video，看 TaskCard 状态实时变化
- `kill -9 uvicorn`，10 秒内重启，确认 WS 自动重连且状态续上

---

## 7. Phase 4-5 概览（Phase 3 完成后接）

### Phase 4 — 资产上传 → TOS

- 新增 `server/app/storage/tos.py` — `TosClient` 封装：`put_object_streaming` / `generate_presigned_get_url(key, ttl=7d)`
- 新增 `server/app/routes/assets.py` — `POST /v1/assets`：multipart 流式 → `seedlandv/uploads/{yyyy}/{mm}/{dd}/{uuid}{ext}`，返 `{asset_token, mime, size_bytes}`，token 存 Redis 1h TTL
- 修改 `server/app/workers/tasks.py::_resolve_assets` — `source='upload'` 分支用 `tos_client.generate_presigned_get_url(tos_key)` 拿临时 URL 给 Ark
- Electron 加 `api:uploadAsset` IPC，main 进程 `fs.createReadStream → multipart`
- renderer submit 入参从 `path` 改成 `asset_token`
- 删 [electron/ark/encode.ts](electron/ark/encode.ts)（base64 路径彻底没了）

### Phase 5 — TOS 产物镜像

- 新增 `server/app/workers/tasks.py::tos_mirror_video(task_id)` — `SELECT FOR UPDATE SKIP LOCKED WHERE status='succeeded' AND tos_video_key IS NULL`，流式拷 Ark URL → TOS `videos/{yyyy}/{mm}/{dd}/{uuid}/video.mp4`，写 `status='completed' + tos_video_key + tos_video_url`
- `ark_submit_and_poll` 终态 succeeded 时 `tos_mirror_video.delay(task_id)`
- 新增 `GET /v1/tasks/{uuid}/video-url` — 按需重签 7d URL
- Celery beat 两个定时任务：`mirror_retry_sweep`（小时）+ `signed_url_refresh`（每天）
- WS 推送优先 `tos_video_url`，fallback `ark_video_url`

---

## 8. 上下文：旧 Electron 单机版的三大致命缺陷（用户问题的起点）

1. `tasks = new Map<string, TaskRecord>()` 在 [electron/main.ts:30](electron/main.ts#L30) — 应用一关全丢
2. 只存 Ark 原始 CDN URL，**24h 过期**，过期后历史订单链接全废
3. 轮询 + 提交都跑在 Electron 主进程 setTimeout 里，无限流/重试/批量调度，关掉桌面就停

火山引擎官方文档 2.2 节明确要求：批量 API 调用、异步结果处理、本地稳定性测试、VKE 容器化并发压测。Phase 3-7 全部围绕这三点解决。

---

## 9. 重要文件 / 路径速查

**项目根**：`d:\SeedLandV`
**Plan 文件（用户已批准）**：`C:\Users\Administrator\.claude\plans\plan-drifting-sonnet.md`
**memory 索引**：`C:\Users\Administrator\.claude\projects\d--SeedLandV\memory\MEMORY.md`
**关键 memory**：
- `seedlandv_task_storage.md` — 任务存储架构 + 实施进度（已更新到 Phase 0-2 完成）
- `pricing_ark_seedance.md` — Ark Seedance 计费
- `ark_seedance_image_role.md` — image role 必填规则
- `ark_human_asset_api.md` — 私域人像素材库 API（邀测）

**Claude Code 源码参考**（架构蓝本，全局 CLAUDE.md 指定）：
- `d:\Claude Code Typescript\claude-code-haha`
- Agent loop: `src/query.ts`
- Tool 接口: `src/Tool.ts`
- System prompt: `src/utils/systemPrompt.ts`
- Permissions: `src/utils/permissions/`
- Compact: `src/services/compact/`

---

## 10. 下个会话的开场指令模板

把这段贴给下一个会话即可：

> 我要继续 SeedLandV 生产化迁移，已完成 Phase 0-2（FastAPI + Celery + JWT + Ark Python 端口 + 37 单测全绿）。请先读 `d:\SeedLandV\HANDOFF.md` 和 `C:\Users\Administrator\.claude\plans\plan-drifting-sonnet.md` 拿到完整上下文，然后开 Phase 3：WebSocket 路由 + Electron 端瘦身。Electron 主进程改成 HTTP/WS 代理，删除 `electron/ark/` 直调 Ark 的代码，renderer 零改动。

---

## 11. 待办（按优先级）

- [ ] **用户**：装 Docker Desktop + 开 TOS bucket + 配 .env（解开 Phase 0 验证）
- [ ] **用户**：跑一遍 verify_phase0.py / verify_phase1.py / smoke_e2e.py 确认 Phase 0-2 真能 work
- [ ] **下个会话**：Phase 3 — WebSocket + Electron 瘦身（详见 §6）
- [ ] **下个会话**：Phase 4 — 资产上传 → TOS（详见 §7）
- [ ] **下个会话**：Phase 5 — TOS 产物镜像 + 签名 URL 续签（详见 §7）
- [ ] **后续**：Phase 6 — Redis 令牌桶限流 + Celery autoretry + Prometheus
- [ ] **后续**：Phase 7 — Helm chart + VKE 部署 + load test
