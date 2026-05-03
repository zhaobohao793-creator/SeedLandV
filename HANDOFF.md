# SeedLandV 生产化迁移 — 会话交接文档

**更新于**:2026-05-03
**当前状态**:Phase 0-6 完成,可靠性 + 限流 + 健康检查 + Sentry 上线
**下一步**:Phase 6b/7 — TOS 直传 (presigned PUT + CORS) + Prometheus + Helm/VKE
**项目根**:`/Applications/SeedLandV/SeedLandV`(Mac;原 Windows 路径 `d:\SeedLandV` 已废弃)

---

## 1. 当前进度

| 阶段 | 状态 | 备注 |
|---|---|---|
| Phase 0 — 仓库 + Docker + Postgres + Redis + TOS | ✅ 全绿 | `verify_phase0.py` 三行 OK |
| Phase 1 — FastAPI + JWT auth | ✅ 5/5 绿 | `verify_phase1.py` exit 0 |
| Phase 2 — Ark Python 端口 + Celery worker | ✅ 37/37 单测 + 端到端 | `pytest -q` 1.4s |
| Phase 3 — WS 路由 + Electron 瘦身 | ✅ 真 Ark Key 文生视频跑通 | 见 §3 |
| Phase 4 — 资产上传 → TOS | ✅ 48/48 单测 + 端到端 smoke | 见 §5 |
| Phase 5 — TOS 镜像 + 签名 URL 续签 | ✅ 53/53 单测 + 端到端 smoke | 见 §6 |
| Phase 6 — 重试 + 限流 + 健康检查 + Sentry | ✅ 68/68 单测 + 端到端 smoke | 见 §7 |
| Phase 6b — TOS presigned PUT 直传 + CORS | ⏳ 待开 | 200MB 视频 server 中转吃 RSS |
| Phase 7 — Prometheus + Helm + VKE | ⏳ | 上线后才有意义 |

---

## 2. 重启服务(每次新会话开始跑这些)

```bash
cd /Applications/SeedLandV/SeedLandV

# 1) 起容器
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker compose -f docker-compose.dev.yml up -d

# 2) 起 API(终端 A — 注意:不带 --reload。改 server 代码必须 pkill + 重起,否则 curl 跑老代码假绿)
cd server && nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 > /tmp/seedlandv-uvicorn.log 2>&1 &

# 3) 起 worker(终端 B — 加 -B 启 beat,跑 mirror_retry_sweep + signed_url_refresh)
cd server && nohup .venv/bin/celery -A app.workers.celery_app:celery_app worker -B -P solo --loglevel=info > /tmp/seedlandv-celery.log 2>&1 &

# 4) 起 Electron(终端 C — 注意 Cursor 终端必须 unset 那个变量)
env -u ELECTRON_RUN_AS_NODE npm run dev
```

**重启 server/worker 流程**:
```bash
pkill -f "uvicorn app.main"; pkill -f "celery -A app.workers.celery_app"; sleep 2
# ...再按上面 step 2/3 起
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

## 4. 验证步骤(可选,确认环境没坏)

```bash
cd server && .venv/bin/pytest -q                        # 期 68 passed (Phase 6 加了 15)
.venv/bin/python scripts/verify_phase0.py               # 期 3 行 [OK]
.venv/bin/python scripts/verify_phase1.py && echo $?    # 期 5 行 [OK] + exit 0
curl -s http://127.0.0.1:8000/readyz | jq .             # 期 db/redis/tos 都 ok
cd .. && npm run typecheck                              # 期无输出
```

Electron 内手动测:Topbar 点徽章 → 重设 Ark Key 模态(close button 应可见)→ 输错 key(如把 TOS AK 贴进去)期望 server 返回 400 红字。

---

## 5. Phase 4 实装一览 — 资产上传 → TOS(已 commit)

### 数据流
本地图片/视频在 renderer 里仍以 `mode: 'local'` 持有(path/name/size)。提交时
**main 进程**惰性上传:`electron/api/upload.ts::AssetUploader.uploadFile` 把文件
读进 Buffer,以 `multipart/form-data` POST 给 server `POST /v1/assets`。server
把 bytes 流到 TOS,key 形如 `seedlandv/uploads/{yyyy}/{mm}/{dd}/{uuid4}{ext}`,
生成不透明 `asset_token`(`secrets.token_urlsafe(24)`),Redis `SETEX
asset_token:{token} 3600 <json>` 存 `{tenant_id, user_id, kind, mime, tos_key,
size_bytes}`。submit 时把 `{kind, mode: 'upload', asset_token}` 放在 assets 数组
里,`POST /v1/tasks` 反查 Redis,验证 tenant_id 一致 + kind 匹配,把 `tos_key`
塞进 `task_assets`。worker `_resolve_assets` 看到 `source='upload'` 走
`TosClient.generate_presigned_get_url(7d)` 给 Ark。

### Server side(`server/app/`)
**新增**:
- `storage/tos.py` — `TosClient`(thin wrapper,接受 `client_factory` 便于测试):
  - `put_object_streaming(key, stream, content_type, content_length)`
  - `generate_presigned_get_url(key, ttl_seconds=7*24*3600)` 用
    `HttpMethodType.Http_Method_Get`
  - `build_object_key(extension)` 模块函数,返回 `seedlandv/uploads/yyyy/mm/dd/{uuid4hex}{ext}`(扩展名归一化为小写)
  - `get_tos_client()` lru_cache 单例,从 settings 读 AK/SK/region/endpoint/bucket
- `routes/assets.py` — `POST /v1/assets`(multipart):
  - `kind` ∈ `{image, video, audio}`(Form 字段),mime startswith `{kind}/`
  - 上限:图 20MB / 视频 200MB / 音 50MB(读 `limit+1` 字节检测溢出 → 413)
  - `await asyncio.to_thread(tos_client.put_object_streaming, ...)` 不阻塞 event loop
  - Redis 存 token 时附带 `tenant_id`,作 ownership scope
- `tests/test_storage_tos.py` — 11 个单测:key shape + 唯一性 + ext 归一化 +
  put/sign 调用参数 + 默认 7d TTL

**修改**:
- `routes/tasks.py::submit_task` — 删掉 501,加 `_resolve_asset_token(token, user)`:
  Redis 读 + `tenant_id` 校验(失败统一返回 "无效或已过期",不泄露存在性) +
  `kind` 匹配。`task_assets` 行写 `source='upload'`、`tos_key`、`mime`、`size_bytes`。
- `workers/tasks.py::_resolve_assets` — `source='upload'` 分支拿 `row.tos_key` 调
  `TosClient.generate_presigned_get_url`(惰性导入避免 worker 启动时连 TOS)
- `main.py` — `app.include_router(assets_router)`

### Electron side
**新增**:
- `electron/api/upload.ts` — `AssetUploader.uploadFile(path, kind)`,Node 20 原生
  `FormData + Blob` 单请求 multipart,扩展名 → mime 映射表 14 种

**修改**:
- `electron/api/client.ts::submitTask` — `Promise.all` 把 `mode: 'local'` 资产
  并行上传,转换成 `{kind, mode: 'upload', asset_token}` 后再 `POST /v1/tasks`。
  每个上传都包了 `withRefresh` 处理 401。

### 与原计划的偏离
原计划是 renderer 选完文件**立刻** upload,把 store 里的 asset 改成 `mode:'upload'`。
实际改成**惰性** —— renderer 仍然存 `mode: 'local'`,提交时 main 进程批量上传。
理由:免去 renderer 端的 upload 状态机,免去用户取消/删除资产时的孤儿 token。
代价:没有逐文件上传进度。Phase 6 要做大文件直传时再加进度回调。

### 端到端 smoke 验证(本次会话已跑过)
1. `POST /v1/assets`(75 字节 PNG)→ 200 + `asset_token` ✅
2. `head_object` 验证 TOS 真有这个对象,ETag/size/Content-Type 都对 ✅
3. `POST /v1/tasks` 带 `asset_token` → 202 + `server_id` ✅
4. worker 跑到 `submit` 阶段才报 "tenant has no Ark API key configured"
   (说明 `_resolve_assets` 成功签了 TOS URL,Ark 调用前才挂)✅
5. `kind` mismatch / bogus token → 400 with 中文提示 ✅
6. 签名 URL `requests.get(verify=False)` 200 + 字节匹配 ✅
   (curl 在本地走了 MITM 代理证书报 403,SDK 自身和 requests 都 OK)

### 已知边角(留给 Phase 6 加严)
- 大文件目前是一次 `await file.read(limit+1)` 读进内存。200MB 视频 = ~200MB RSS。
  生产前要换成 SpooledTemporaryFile 流式 + 边读边算 hash。
- presigned PUT 让客户端直传 TOS 也是 Phase 6 候选,需要先解决 CORS 和 IAM 范围。

---

## 6. Phase 5 实装一览 — TOS 镜像 + 签名 URL 续签(已 commit)

### 数据流
Ark 跑完 → `ark_submit_and_poll` 看到 `final.status=='succeeded'` 且 row 有
`ark_video_url` + 没有 `tos_video_key` → `tos_mirror_video.delay(task_id)`。
镜像 worker 三段事务:
1. `SELECT … FOR UPDATE SKIP LOCKED` 锁行,验证状态/重试预算/冷却,bump
   `mirror_attempt`,转 `MIRRORING`,commit 释锁。
2. **无锁网络段**:`mirror_url_to_tos` httpx stream 拉 Ark URL 到
   SpooledTemporaryFile(< 64MiB 内存,> 落盘),知道总长后整块 PUT 进 TOS
   `seedlandv/videos/{yyyy}/{mm}/{dd}/{task_uuid}/video.mp4`。
3. 短事务写 `tos_video_key` + `tos_video_url` (7d 签名) +
   `tos_video_url_expires_at` + status=COMPLETED;失败则回滚状态到 SUCCEEDED 留
   重试,permanent give-up(`mirror_attempt >= 5`)→ COMPLETED_PARTIAL。

### Server side(`server/app/`)
**新增**:
- `alembic/versions/20260503_0002_phase5_video_mirror.py` — `tasks` 表加 4 列:
  `tos_video_url_expires_at`、`mirror_attempt`、`mirror_last_attempt_at`、
  `mirror_error`;部分索引 `ix_tasks_mirror_pending` /
  `ix_tasks_url_refresh` 用于 sweeper 走索引扫描。
- `storage/tos.py::build_video_key(task_uuid)` — 稳定 key 形,重试 PUT 同一对象
  保证幂等。
- `storage/tos.py::mirror_url_to_tos(client, src_url, dest_key, ...)` — httpx
  stream → SpooledTemporaryFile → tos PUT,`http_factory` 可注入便于测试。

**修改**:
- `workers/tasks.py` — 加 `tos_mirror_video`(三段事务版),`mirror_retry_sweep`
  (滚回 stuck `mirroring` + 重新入队冷却结束的 `succeeded`),
  `signed_url_refresh`(24h 内到期就续签),常量 `MIRROR_MAX_ATTEMPTS=5`、
  `MIRROR_RETRY_COOLDOWN=5min`、`MIRROR_STUCK_THRESHOLD=15min`、
  `URL_REFRESH_LEAD=24h`。`ark_submit_and_poll` 末尾 hook
  `tos_mirror_video.delay()`。
- `workers/celery_app.py` — `beat_schedule`:`mirror_retry_sweep` 每小时,
  `signed_url_refresh` 每日 02:00 UTC;timezone=UTC。
- `routes/tasks.py` — `GET /v1/tasks/{server_id}/video-url` 现签 7d URL,
  顺手把 `tos_video_url` + `tos_video_url_expires_at` 写回行(下次 WS 快照即用
  最新 URL)。404 不存在,409 没镜像。

### 与原计划的偏离
原计划没写"sweeper 同时清扫 stuck `mirroring` 行"。实际加了——为了正确处理
worker 在第 2 段网络 IO 中崩溃的情况(行卡 `mirroring` 但锁已释放)。
`MIRROR_STUCK_THRESHOLD=15min` 之后 sweep 会把它滚回 `succeeded` 让重试。

### 端到端 smoke(本次会话已跑)
1. 假装 Ark 跑完:用 TOS 自己的 `seedlandv/uploads/...` 当 upstream URL,造一行
   `status='succeeded'` 的任务 → `tos_mirror_video.delay(id)` →
   行变 MIRRORING → COMPLETED,`tos_video_key` 写好,7d URL 可访问 ✅
2. `GET /v1/tasks/{uuid}/video-url` 200 + URL 字节匹配,row.tos_video_url 被刷新 ✅
3. 同 endpoint:不存在 → 404 ✅;未镜像 → 409 + "video has not been mirrored yet" ✅
4. `signed_url_refresh()` 直调:把行的 expires_at 倒拨到 12h 后,跑刷新,URL 变 +
   expires_at 推到 7d 后 ✅
5. `mirror_retry_sweep()` 直调:`enqueued: 3, rolled_back: 0`,worker 串行处理,
   网络可达的成功 → COMPLETED;`https://example/v.mp4` ConnectError → 滚回
   SUCCEEDED + `mirror_error.type='ConnectError'` ✅

### 启 beat
开发期 worker 加 `-B` 启 in-process beat:
```bash
celery -A app.workers.celery_app:celery_app worker -B -P solo --loglevel=info
```
生产部署再拆出独立 `celery beat` 进程。

---

## 7. Phase 6 实装一览 — 重试 + 限流 + 健康检查 + Sentry(已 commit)

### 数据流
- **Ark 提交重试**:`ark_submit_and_poll` 区分 ArkError.is_transient(5xx/429)
  和 httpx 网络错误为可重试;permanent 4xx / RuntimeError(缺 Ark Key)直接
  FAILED。可重试时 `task.attempt += 1`,`self.retry(countdown=...)`,full-jitter
  exponential backoff(base 30s,2x,cap 600s)。出 `SUBMIT_MAX_ATTEMPTS=5` 后
  也走 FAILED。轮询期 transient 已被 `poll_until_done` 内部消化,不暴露。
- **镜像重试**:`_claim_mirror_row` 的冷却闸从固定 5min 改成
  `_mirror_cooldown_for(attempt)`(60s base,2x,cap 1h)。SQL 候选用最小冷却
  过滤,精确门槛交给 `_claim_mirror_row` 跑。
- **每租户限流**:`POST /v1/tasks` 调 `consume_ark_submit_quota(tenant_id)` 走
  Redis fixed-window(`ark_submit_quota:{tid}:{epoch_hour}`,INCR + EXPIRE),
  默认 `ARK_SUBMIT_RATE_LIMIT_PER_HOUR=100`。所有响应都带
  `X-RateLimit-Limit`/`Remaining`/`Reset`;超额返回 429 + `Retry-After`,
  且计数器仍然递增(防 spammer 利用 INCR 漂移窗口)。
- **健康检查**:`GET /healthz` 保留为廉价 liveness(只回 ok,无外依赖);新增
  `GET /readyz` 并行 ping DB/Redis/TOS HeadBucket,任一挂掉返 503 + 失败原因。
  k8s readinessProbe 用 readyz,liveness 用 healthz。
- **Sentry**:`app/observability/sentry.py::init_sentry(settings, integration=...)`
  在 FastAPI(`main.py`)和 Celery(`celery_app.py::_make_celery`)入口幂等初始化;
  `SENTRY_DSN` 空时 no-op;tracing/profiling 关到 0.0,只要 exception capture +
  breadcrumbs。

### Server side(`server/app/`)
**新增**:
- `storage/quota.py` — `consume_ark_submit_quota(tenant_id, *, limit=None,
  client=None)` 返回 `QuotaResult(allowed, used, limit, remaining,
  reset_in_seconds)`;`limit`/`client` 参数注入便于单测。
- `observability/sentry.py` — `init_sentry(settings, *, integration: 'fastapi'|'celery')`,
  幂等(模块级 `_initialised`),空 DSN 直接 return。
- `tests/test_quota.py` — 5 个单测:首次允许、超额仍然递增、租户隔离、跨小时新桶、reset
  倒计时。
- `tests/test_workers_backoff.py` — 6 个单测:mirror 倍增/封顶/0-attempt 兜底、
  submit full-jitter 上下界、submit 大 attempt 的 cap。

**修改**:
- `config.py` — 加 `ark_submit_rate_limit_per_hour=100`、`sentry_dsn=""`、
  `sentry_env="dev"`。
- `pyproject.toml` — 加 `sentry-sdk[fastapi,celery]>=2.18`(实际 2.58 装上了)。
- `main.py` — 启动时调 `init_sentry(...)`;新增 `_check_db/_check_redis/_check_tos`
  + `GET /readyz`(JSONResponse,503 on degraded)。
- `routes/tasks.py::submit_task` — 注入 `Response`,提前调 `consume_ark_submit_quota`,
  未通过抛 429 + `Retry-After`,通过则在响应头写 RateLimit-* 三连。
- `workers/tasks.py` — 加常量 `SUBMIT_MAX_ATTEMPTS=5`、
  `SUBMIT_BASE_BACKOFF_SECONDS=30`、`SUBMIT_MAX_BACKOFF_SECONDS=600`、
  `MIRROR_BASE_COOLDOWN_SECONDS=60`、`MIRROR_MAX_COOLDOWN_SECONDS=3600`;
  helper `_submit_backoff_for(attempt)` / `_mirror_cooldown_for(attempt)`;
  `ark_submit_and_poll` 装饰器改 `max_retries=SUBMIT_MAX_ATTEMPTS`,submit 阶段两个
  except 都加上 transient 分支 + `self.retry(...)`;`_claim_mirror_row` 用
  `_mirror_cooldown_for(task.mirror_attempt)`;`mirror_retry_sweep` SQL 用最小冷却。
- `workers/celery_app.py` — `_make_celery` 头上调 `init_sentry(s, integration='celery')`。

### 与原计划的偏离
- 原计划的 "rate limit Celery 投递 + Ark 调用" 实际只在 HTTP 层做。重试不算新提交,
  比 Celery 层简单且效果一样(Ark 限额是按 API 调用算)。
- 原计划的 "Prometheus exporter" 推到 Phase 7,要等 VKE 上线后 dashboard 才有
  意义。Sentry 已经覆盖 exception capture。
- 原计划的 "presigned PUT 直传 TOS" 推到 Phase 6b,需要先解决 TOS bucket CORS
  + STS 临时密钥范围,工作量另起一级。

### 端到端 smoke(本次会话已跑)
1. `GET /healthz` → 200 `{status:ok}` ✅
2. `GET /readyz` → 200 `{db:{ok:true}, redis:{ok:true}, tos:{ok:true}, status:ok}` ✅
3. 注册新租户 → `POST /v1/tasks` 连发 102 次:1-100 全 202 + `X-RateLimit-Remaining`
   从 99 递减到 0;101 拿 429 + `Retry-After: 931`(约 15min 至下个整点) ✅
4. 100 个失败任务都因 "tenant has no Ark API key configured" 永久 FAILED,
   `attempt=0`(RuntimeError 不在 transient 分支,符合预期) ✅
5. `init_sentry()` 空 DSN 直接 no-op ✅

### 待 Phase 6b/7 处理
- 透传 X-RateLimit-* 到 Electron renderer,UI 显示 "本小时还剩 N 次提交"。
- presigned PUT(需要 TOS bucket CORS + STS 临时密钥)。
- Prometheus exporter(等 VKE/Grafana 上线)。
- /readyz 503 路径 smoke(需要主动断 docker container,留给 Phase 7)。

---

## 8. 已知坑 / 已记录到 memory

| 坑 | 表现 | 怎么避 |
|---|---|---|
| Cursor 终端 `ELECTRON_RUN_AS_NODE=1` | `npm run dev` 立刻崩 `app.isPackaged undefined` | `env -u ELECTRON_RUN_AS_NODE npm run dev` |
| 收用户 API key 只校验长度 | 输错也能存进 DB,worker 跑时才报 401 | server 端 PUT 时探测一次目标服务,401 拒收 |
| docker-compose `docker-credential-desktop` not found | Mac 上首次 `docker compose pull` 报错 | `export PATH=/Applications/Docker.app/Contents/Resources/bin:$PATH` |
| `email-validator` 拒 `.local` | `verify_phase1.py` 老脚本失败 | 测试邮箱用 `@example.com`(IANA 保留) |

---

## 9. 当前后台进程(本次会话留下,可能还在跑)

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

## 10. 下一会话开场白模板

> 继续 SeedLandV。Phase 0-6 已完成,重试 + 限流 + Sentry + /readyz 端到端 smoke 通过,代码全 commit 在 `init` 分支。先读 `/Applications/SeedLandV/SeedLandV/HANDOFF.md` 拿状态,按 §2 起服务(uvicorn 没 --reload,celery 加 -B 启 beat —— 改 server 代码必须 pkill + 重启),跑 §4 验证一下没坏(`curl /readyz` 三 dep ok),然后开 Phase 6b(TOS presigned PUT 直传 + CORS)或 Phase 7(Prometheus + Helm/VKE)。
