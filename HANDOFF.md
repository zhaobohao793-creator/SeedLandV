# SeedLandV 生产化迁移 — 会话交接文档

**更新于**:2026-05-03
**当前状态**:Phase 0-4 完成,Phase 4 端到端 smoke 通过(真上传 → 真 TOS → 真签名 URL)
**下一步**:Phase 5 — TOS 产物镜像 + 签名 URL 刷新
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
| Phase 5 — TOS 镜像 + 签名 URL | ⏳ 待开 | 详 §6 |
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

## 4. 验证步骤(可选,确认环境没坏)

```bash
cd server && .venv/bin/pytest -q                        # 期 48 passed (Phase 4 加了 11)
.venv/bin/python scripts/verify_phase0.py               # 期 3 行 [OK]
.venv/bin/python scripts/verify_phase1.py && echo $?    # 期 5 行 [OK] + exit 0
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

> 继续 SeedLandV。Phase 0-4 已完成,资产上传端到端 smoke 通过,代码全 commit 在 `init` 分支。先读 `/Applications/SeedLandV/SeedLandV/HANDOFF.md` 拿状态,按 §2 起服务(注意 uvicorn 没有 --reload,celery 也没有 autoreload —— 改完代码必须重启对应进程),跑 §4 验证一下没坏,然后开 §6 Phase 5(TOS 镜像 + 签名 URL 刷新)。
