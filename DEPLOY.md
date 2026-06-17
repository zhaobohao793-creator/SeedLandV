# SeedLandV 后端部署（Docker）

让别人能用你的桌面端，需要三件事齐活：① 安装包 `.exe`（`npm run build` 已产出）、② **后端部署在能联网访问的机器上**（本文）、③ 桌面端 `SEEDLANDV_API_URL` 指向这台后端（见最后一节）。

后端一键起来后包含 6 个容器：

| 服务 | 作用 | 对外端口 |
|---|---|---|
| `postgres` | 数据库（订单 / 用户 / 租户） | 仅内网 |
| `redis` | Celery broker + pub/sub + 缓存 | 仅内网 |
| `migrate` | 启动时跑一次 `alembic upgrade head`，完成即退出 | — |
| `api` | FastAPI（HTTP + WebSocket），桌面端连这个 | **8000** |
| `worker` | Celery worker，跑 Ark 生成轮询 / TOS 镜像 | — |
| `beat` | 定时任务（签名 URL 续期、镜像补偿） | — |

---

## 1. 前置（在要部署的那台机器上）

- 安装 Docker（含 compose v2）：Linux 服务器装 Docker Engine；Windows/Mac 装 Docker Desktop 并**确保已启动**。
- 开好火山 TOS 桶 + 子账号 AK/SK（参见 `server/README.md` 的"前置准备"）。

## 2. 配置密钥

```bash
cp .env.docker.example .env.docker
```

编辑 `.env.docker`，必填项：

```bash
# 数据库密码（强随机）
openssl rand -hex 24
# JWT 签名密钥
openssl rand -hex 32
# 租户 Ark Key 加密密钥（Fernet）
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

把上面三条分别填到 `POSTGRES_PASSWORD` / `JWT_SECRET` / `ARK_KEY_FERNET_SECRET`，再填 `VOLC_TOS_AK/SK/BUCKET`。
`.env.docker` 含密钥，已被 `.gitignore` 忽略，不要提交。

## 3. 起服务

```bash
docker compose -f docker-compose.prod.yml --env-file .env.docker up -d --build
```

首次会构建镜像 + 拉 Postgres/Redis 基础镜像，要几分钟。`migrate` 跑完迁移后 `api`/`worker`/`beat` 才启动（compose 已配好依赖顺序）。

> 💡 **本文每条 `docker compose` 命令都要带 `--env-file .env.docker`**——因为 compose 文件用了 `${VAR:?}` 必填校验，少了它任何子命令（连 `ps`/`logs`）都会报 “required variable … is missing”。
> 嫌烦可在当前终端先 `export COMPOSE_ENV_FILES=.env.docker`（仅本终端有效，新开终端要重来），之后命令就能省略 `--env-file`。

## 4. 验证

```bash
docker compose -f docker-compose.prod.yml --env-file .env.docker ps     # 各容器 healthy/running
curl http://localhost:8000/healthz                    # {"status":"ok"}
curl http://localhost:8000/readyz                     # db/redis/tos 三项都 ok 才算就绪
docker compose -f docker-compose.prod.yml --env-file .env.docker logs -f api worker
```

`/readyz` 返回 503 说明某个依赖没通——看 `error` 字段（多半是 TOS 凭据/桶名不对）。

## 5. 建第一个管理员账号

后端刚起来库是空的，桌面端登录前先建账号（也可以在桌面端首启的"初始化"表单里建，二选一）：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.docker run --rm api \
  python -m scripts.create_initial_admin \
  --workshop "我的工作室" --employee-id A001 --password '改成强密码'
```

## 6. 让桌面端连上这台后端

桌面端启动时读 `SEEDLANDV_API_URL`（默认 `http://localhost:8000`），来源是 exe 同目录或安装目录 resources 下的 `.env`。两种做法：

- **临时/自测**：在安装目录（exe 旁）放一个 `.env`，写 `SEEDLANDV_API_URL=http://你的后端IP:8000`。
- **发给用户**：让我把后端地址预置进安装包重打一版，用户装完即用、无需手动配。告诉我后端最终地址即可。

> ⚠️ 公网部署务必加 HTTPS：用 Nginx/Caddy 反代到 `api:8000`，并放行 WebSocket 升级头（`Upgrade`/`Connection`）。直接裸暴露 8000 明文不安全，WS 也容易被中间设备掐断。把 `.env.docker` 里 `API_PORT` 改成只监听 `127.0.0.1` 再交给反代更稳。

---

## 运维速查

```bash
# 看状态 / 日志
docker compose -f docker-compose.prod.yml --env-file .env.docker ps
docker compose -f docker-compose.prod.yml --env-file .env.docker logs -f worker

# 更新代码后重建
git pull
docker compose -f docker-compose.prod.yml --env-file .env.docker up -d --build
# （migrate 会自动把新迁移升上去；alembic upgrade head 幂等）

# 备份数据库
docker compose -f docker-compose.prod.yml --env-file .env.docker exec postgres \
  pg_dump -U seedlandv seedlandv > backup_$(date +%F).sql

# 停止 / 连数据一起删（谨慎！pgdata 卷会被删）
docker compose -f docker-compose.prod.yml --env-file .env.docker down
docker compose -f docker-compose.prod.yml --env-file .env.docker down -v
```
