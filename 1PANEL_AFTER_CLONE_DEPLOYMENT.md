# FrontMind Dashboard：1Panel 最终替换式生产部署

本文是 `frontmind-agent → frontmind-dashboard` 的最终替换方案：

```text
新版代码只进入新的 GitHub Private Repo：frontmind-dashboard
→ 使用全新的 frontmind_dashboard 空数据库和三套全新持久目录
→ 停止旧 Agent，释放并由 Dashboard 接管 3001
→ dashboard.frontmind.net 指向新 Dashboard
→ Website 通过 frontmind-dashboard:3001 调用内部接口
→ Dashboard 与 Website 验收通过
→ 永久删除旧 Agent 运行环境、域名、服务器资产和数据库
```

旧 GitHub `frontmind-agent` 仓库只作为历史仓库保留，不接收本次或后续 Dashboard
提交。旧 Agent 的数据库、用户数据、密钥和持久文件一律不迁移到新 Dashboard。旧生产
资产只在切换验收期间临时保留，最终必须按本文的精确目标清单永久删除。

## 0. 一次性迁移到新的私有仓库

目标仓库必须是已经确认归属和可见性均正确的 Private 仓库：

```text
https://github.com/xiafanzeng/frontmind-dashboard.git
```

本地代码检查完成并提交后，在 GitHub Desktop 中把目标仓库明确设为
`xiafanzeng/frontmind-dashboard`。首次 push 前必须在界面中逐字核对 Owner、Repository
和 Remote URL；只允许向新仓库 push，禁止向旧 `frontmind-agent` 仓库 push。

确认新仓库已收到精确 release commit 后，关闭使用该目录的终端、GitHub Desktop 和
Codex 窗口，再把本地文件夹从 `frontmind-agent` 精确改名为：

```text
/Users/fanzengxia/Documents/GitHub/frontmind-dashboard
```

在 GitHub Desktop 中重新定位/添加改名后的本地目录，并再次核对其远端仍是
`https://github.com/xiafanzeng/frontmind-dashboard.git`。旧 GitHub 仓库的分支、提交、
远端配置和 Private 属性不做任何修改。

## 1. 固定部署参数

| 项目            | 生产值                                |
| --------------- | ------------------------------------- |
| 代码仓库        | `frontmind-dashboard`                 |
| 宿主机仓库目录  | `/frontmind-dashboard`                |
| 容器内工作目录  | `/app`                                |
| 1Panel 运行环境 | `FrontMind-Dashboard`                 |
| Docker 容器     | `frontmind-dashboard`                 |
| 私有容器 DNS    | `frontmind-dashboard`                 |
| 应用端口        | `3001`                                |
| 公开域名        | `https://dashboard.frontmind.net`     |
| Website 域名    | `https://www.frontmind.net`           |
| MySQL 私有 DNS  | `mysql`（本次生产网络已核验）         |
| MySQL 数据库    | `frontmind_dashboard`                 |
| MySQL 用户      | `frontmind_dashboard`                 |
| Node            | `22.12+`                              |
| pnpm            | 仓库 `packageManager` 声明的 `10.4.1` |

生产环境的敏感配置只写入 1Panel 运行环境变量界面。不要在仓库目录或容器 `/app` 创建
`.env`、`.env.local` 或 `.env.production`，也不要执行 `cp .env.example .env`。

## 2. 发布前必须具备的代码

服务器只部署已经提交、推送并在干净克隆中验证过的精确 SHA。至少确认：

```bash
git -C /frontmind-dashboard status --short --branch
git -C /frontmind-dashboard fetch origin --prune
git -C /frontmind-dashboard switch main
git -C /frontmind-dashboard pull --ff-only origin main
git -C /frontmind-dashboard rev-parse HEAD
```

`git status --short` 必须为空，`HEAD` 必须等于本次记录的 Agent release SHA。发现服务器
有未知修改时停止，不执行 `git reset --hard`。

当前数据库版本必须包含：

```text
drizzle/0000_*.sql
…
drizzle/0034_known_scarlet_spider.sql
drizzle/meta/_journal.json（35 条记录）
```

当前生产包还必须包含三个运行时 Skill：

```text
private-workflows/socratic-kb-builder.skill
private-workflows/brand-question-portfolio.skill/
private-workflows/response-logic-builder.skill/
```

## 3. 切换前隔离旧 Agent，并登记精确退役目标

切换前旧 Agent 可以继续运行，但只能用于维持旧站点；不得再向其代码仓库、数据库或持久
目录导入 Dashboard 数据。新旧系统必须完全隔离：

1. 不向旧 `frontmind-agent` GitHub 仓库 push 本次新版提交。
2. 不把旧数据库或旧持久目录挂载给新 Dashboard。
3. 不复用旧 Agent 的凭据加密密钥、ICP 密钥、service token 或内部容器 DNS。
4. 不将旧客户数据复制、导入或同步到 `frontmind_dashboard`。
5. 在 Dashboard 启动前停止旧 Agent 并关闭其自动重启，使 `3001` 完全释放。

开始部署前，从 1Panel 和 DNS 控制台只读盘点并记录以下精确值：

| 退役对象 | 必须记录的精确标识 |
| --- | --- |
| 旧运行环境 | 1Panel 运行环境名称、容器名称/ID |
| 旧网站 | `agent.frontmind.net` 对应的 1Panel 网站名称和配置目录 |
| 旧 DNS | `agent.frontmind.net` 的记录类型、主机记录、记录值和记录 ID |
| 旧服务器代码 | 规范化后的唯一绝对路径 |
| 旧数据库 | 数据库实例、精确数据库名 |
| 旧数据库用户 | 完整 `username@host` 主体和 `SHOW GRANTS` 结果 |
| 旧 prepared-files | 规范化后的唯一绝对路径或卷名 |
| 旧 dashboard-assets | 规范化后的唯一绝对路径或卷名 |
| 旧 ICP/其他持久数据 | 每一个规范化绝对路径或卷名，逐项记录 |
| 旧备份/快照/导出 | 1Panel 任务 ID、快照 ID、规范化导出路径、远端对象及 version ID |
| 旧自动任务 | 备份、同步、清理和导出的精确计划任务 ID |
| 旧外部凭据 | 只记录提供方、用途和凭据 ID/名称，不记录或回显真实值 |

清单必须由两人复核，且明确排除 `/frontmind-dashboard`、
`/srv/frontmind-dashboard/prepared-files`、
`/srv/frontmind-dashboard/dashboard-assets`、
`/srv/frontmind-dashboard/icp-materials` 和 `frontmind_dashboard`。任何旧目标不明确时，
停止退役，不猜测、不使用通配符。

## 4. 新建空数据库

在 `1Panel → 数据库 → MySQL` 新建：

```text
数据库：frontmind_dashboard
用户：frontmind_dashboard
字符集：utf8mb4
访问范围：仅本机/私有 Docker 网络
```

密码使用独立强随机值。写入 `DATABASE_URL` 时必须进行 URL 编码；例如密码中的 `@`、
`:`、`/`、`#`、`?`、`%` 不能原样放进 URI。

数据库不映射公网 `3306`。Dashboard 与 MySQL 必须加入同一个私有 Docker 网络。本次已
在生产私有网络核验 MySQL 服务 DNS 名为固定值 `mysql`，不能在 Dashboard 容器中使用
`127.0.0.1`。以后若迁移 MySQL 容器，必须先重新核验并同步修订固定参数和数据库目标门，
不能为通过检查而临时放宽。

## 5. 创建全新持久目录

在宿主机创建三个全新目录，并限制权限：

```bash
install -d -m 700 /srv/frontmind-dashboard/prepared-files
install -d -m 700 /srv/frontmind-dashboard/dashboard-assets
install -d -m 700 /srv/frontmind-dashboard/icp-materials
```

在 1Panel 运行环境中挂载：

```text
/srv/frontmind-dashboard/prepared-files
→ /var/lib/frontmind/prepared-files

/srv/frontmind-dashboard/dashboard-assets
→ /var/lib/frontmind/dashboard-assets

/srv/frontmind-dashboard/icp-materials
→ /var/lib/frontmind/icp-materials
```

`icp-materials` 不能被 OpenResty/Nginx 作为静态目录公开。

## 6. 创建 FrontMind-Dashboard 运行环境

在 `1Panel → 网站 → 运行环境 → Node.js` 新建：

```text
名称：FrontMind-Dashboard
容器名称：frontmind-dashboard
宿主机代码目录：/frontmind-dashboard
容器内工作目录：/app
Node：22.12+ LTS
端口：3001
初始启动命令：sleep infinity
自动重启：迁移完成前关闭
```

不同 1Panel 版本对“代码目录/运行目录”的字段命名不同：宿主机仓库应挂载到容器
`/app`，后文所有容器命令都以 `/app` 为准。创建后先运行
`docker exec frontmind-dashboard pwd` 和 `ls -la /app/package.json`；若实际挂载点不同，
必须先统一运行目录与三个 Skill 绝对路径，不能混用 `/frontmind-dashboard` 和 `/app`。

先用 `sleep infinity` 只为了让容器存在，以便完成依赖、构建、迁移和管理员初始化；
正式启动命令稍后改为 `pnpm start`。

准备阶段不要给新容器发布宿主机 `3001`。如果当前 1Panel 版本创建运行环境时必须立即
绑定宿主机端口，则先执行第 13 节的旧 Agent 停止与端口释放步骤，再创建
`FrontMind-Dashboard`；旧 Agent 与 Dashboard 绝不能同时绑定 `3001`，也不能把 Dashboard
临时改到其他生产端口。

运行环境需要加入：

- MySQL 所在私有网络；
- Website 所在私有网络；
- 私有 DNS alias `frontmind-dashboard`。

不要把 `3001` 直接开放到公网；公开流量只经过 80/443 和 OpenResty。

## 7. 永久安装 PDF 运行依赖

生产检查已确认当前 `1panel/node:22.22.2`（Debian 12）不包含任何所需 PDF 命令。
仓库提供固定派生镜像定义：

```text
deploy/1panel-node-pdf/Dockerfile
```

它固定使用生产服务器实际核验的完整基础镜像 digest，并永久安装：

```text
poppler-utils
ghostscript
```

Docker 构建上下文由同目录 `.dockerignore` 限制为 Dockerfile 本身，不能把代码、环境
文件、Key 或 token 传入镜像构建。Dockerfile 也不得通过 `ARG`、`ENV`、`LABEL` 或
`COPY` 写入任何敏感值。

先确认服务器代码为已审核 release，且基础镜像仍为文档记录的精确对象：

```bash
docker inspect frontmind-dashboard \
  --format 'configured_image={{.Config.Image}} image_id={{.Image}}'

docker image inspect 1panel/node:22.22.2 \
  --format 'user={{json .Config.User}} repo_digests={{json .RepoDigests}}'
```

预期基础镜像为 `1panel/node:22.22.2`，RepoDigest 包含：

```text
1panel/node@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28
```

`user` 必须是 `""` 或 `"root"`。任一结果不同都先停，不覆盖 Dockerfile 中的 digest。

构建固定派生镜像：

```bash
DASHBOARD_RELEASE_SHA="$(git -C /frontmind-dashboard rev-parse HEAD)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

docker build \
  --pull=false \
  --build-arg VCS_REF="$DASHBOARD_RELEASE_SHA" \
  --build-arg IMAGE_VERSION='dashboard-20260728-r1-pdf2' \
  --tag "$DASHBOARD_PDF_IMAGE" \
  --file /frontmind-dashboard/deploy/1panel-node-pdf/Dockerfile \
  /frontmind-dashboard/deploy/1panel-node-pdf
```

构建日志最后必须看到五个 `command -v` 均成功。检查镜像审计标签，防止同名旧镜像被
误用：

```bash
test "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
)" = "$DASHBOARD_RELEASE_SHA"

test "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
)" = "dashboard-20260728-r1-pdf2"

docker image inspect "$DASHBOARD_PDF_IMAGE" \
  --format 'image_id={{.Id}}'
```

随后直接从新镜像验证并记录本次实际安装的软件包版本：

```bash
docker run --rm \
  --network none \
  --entrypoint sh \
  "$DASHBOARD_PDF_IMAGE" \
  -lc '
set -eu
node --version
command -v pnpm
test "$(pnpm --version)" = "10.4.1"
command -v pdfinfo
command -v pdftotext
command -v pdfseparate
command -v pdfunite
command -v gs
dpkg-query -W -f="\${Package}=\${Version}\n" \
  ghostscript poppler-utils
'
```

基础镜像 digest 已固定；Debian 仓库中的安全更新仍可能随时间变化，因此必须把本次构建
的最终 image ID、两项软件包版本、release SHA 和构建时间写入发布记录，并把这个已经
验收的派生镜像纳入新系统镜像备份或受控私有镜像仓库。不能仅假设未来重新运行
`apt-get` 会得到字节级相同的镜像。

通过现有容器的 Compose 标签定位 1Panel 实际运行目录和项目名，不能猜安装路径：

```bash
DASHBOARD_RUNTIME_DIR="$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
)"
DASHBOARD_COMPOSE_PROJECT="$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.project" }}'
)"
DASHBOARD_COMPOSE_CONFIG_FILES="$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'
)"
DASHBOARD_COMPOSE_SERVICE="$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.service" }}'
)"

test -n "$DASHBOARD_RUNTIME_DIR"
test -n "$DASHBOARD_COMPOSE_PROJECT"
test -n "$DASHBOARD_COMPOSE_CONFIG_FILES"
test -n "$DASHBOARD_COMPOSE_SERVICE"

case "$DASHBOARD_COMPOSE_CONFIG_FILES" in
  *,*)
    echo "MULTIPLE_COMPOSE_FILES_REVIEW_REQUIRED"
    exit 1
    ;;
  /*)
    DASHBOARD_COMPOSE_FILE="$DASHBOARD_COMPOSE_CONFIG_FILES"
    ;;
  *)
    echo "COMPOSE_FILE_PATH_NOT_ABSOLUTE"
    exit 1
    ;;
esac

test -f "$DASHBOARD_COMPOSE_FILE"
test "$(grep -Ec '^[[:space:]]*image:' "$DASHBOARD_COMPOSE_FILE")" -eq 1
grep -nE '^[[:space:]]*image:' "$DASHBOARD_COMPOSE_FILE"
```

在 1Panel 停止 `FrontMind-Dashboard`。使用 1Panel 文件管理器打开上面精确定位的
`docker-compose.yml`。1Panel 当前版本通常把基础镜像写成变量模板：

```yaml
image: 1panel/node:${NODE_VERSION}
```

某些版本也可能已经展开为 `image: 1panel/node:22.22.2`。只把实际存在的这一条
`image:` 替换为：

```yaml
image: frontmind-dashboard-node:22.22.2-pdf-<本次40位release SHA>
```

不要修改 `NODE_VERSION`、`run.sh`、1Panel 内部 `.env`、`command`、端口、卷、网络或
`createdBy` 标签。这个 1Panel 生成文件可能直接包含生产环境变量和敏感值，禁止复制或
粘贴完整文件到聊天、工单、日志或截图。先只解析镜像名，禁止运行可能展开敏感环境变量
的裸 `docker compose config`：

```bash
docker compose \
  --project-name "$DASHBOARD_COMPOSE_PROJECT" \
  --project-directory "$DASHBOARD_RUNTIME_DIR" \
  --file "$DASHBOARD_COMPOSE_FILE" \
  config --services |
  grep -Fx "$DASHBOARD_COMPOSE_SERVICE"

docker compose \
  --project-name "$DASHBOARD_COMPOSE_PROJECT" \
  --project-directory "$DASHBOARD_RUNTIME_DIR" \
  --file "$DASHBOARD_COMPOSE_FILE" \
  config --images |
  grep -Fx "$DASHBOARD_PDF_IMAGE"
```

两条命令都必须恰好匹配。然后使用原项目名、原配置文件和精确 service 强制重建，不能
执行 `down -v`，也不能重建同一 Compose 项目中的其他服务：

```bash
docker compose \
  --project-name "$DASHBOARD_COMPOSE_PROJECT" \
  --project-directory "$DASHBOARD_RUNTIME_DIR" \
  --file "$DASHBOARD_COMPOSE_FILE" \
  up -d --force-recreate --pull never \
  "$DASHBOARD_COMPOSE_SERVICE"
```

同时核对实际镜像 ID、五个命令、工作目录和网络：

```bash
test "$(
  docker inspect frontmind-dashboard --format '{{.Image}}'
)" = "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" --format '{{.Id}}'
)"

test "$(
  docker inspect frontmind-dashboard --format '{{.State.Running}}'
)" = "true"
test "$(
  docker inspect frontmind-dashboard --format '{{.State.Restarting}}'
)" = "false"
INITIAL_RESTART_COUNT="$(
  docker inspect frontmind-dashboard --format '{{.RestartCount}}'
)"

docker exec frontmind-dashboard sh -lc '
set -eu
test "$(pwd)" = "/app"
command -v pdfinfo
command -v pdftotext
command -v pdfseparate
command -v pdfunite
command -v gs
'

docker inspect frontmind-dashboard \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

再次执行同一条限定精确 service 的 `up -d --force-recreate --pull never` 并重复验证，
证明依赖不是当前容器 writable layer 中的临时安装。每次通过 1Panel 编辑、升级或重建
运行环境后，都必须重新确认 Compose 的 `image:`、release SHA 标签和容器实际 image ID
仍指向该固定派生镜像；若被 1Panel 恢复成官方镜像，必须重新应用本节的精确镜像配置后
才能启动。

绝对不要在运行容器中临时 `apt install`，不要 `docker commit`，不要把派生镜像反向
标记成 `1panel/node:22.22.2`，也不要执行 `docker compose down -v` 或
`docker system prune`。

## 8. 生成新密钥

因为使用全新数据库和全新目录，本次必须生成全新的密钥，不能复用旧 Agent 值。
在安全终端分别执行，每次输出只复制到密码管理器和 1Panel：

```bash
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 48
```

依次用于：

1. `FRONTMIND_CREDENTIAL_ENCRYPTION_KEY`，值前加 `base64:`；
2. `FRONTMIND_ICP_MATERIAL_KEY`，值前加 `base64:`；
3. `FRONTMIND_PRESALES_SERVICE_TOKEN`；
4. `FRONTMIND_PROVISIONING_SERVICE_TOKEN`；
5. `FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET`。

五项必须彼此不同。两枚 service token 还要原样配置到 Website；其余三项只属于
Dashboard。

售前 API Key 不在这里生成，也不写入任何环境文件或 Website。它只能由系统管理员登录
Dashboard 的售前页面录入，由 Dashboard 使用新的
`FRONTMIND_CREDENTIAL_ENCRYPTION_KEY` 加密后保存到 `frontmind_dashboard`。

已经出现在聊天、截图、日志或终端共享记录中的真实 API Key 只用于受控验证，正式开放
流量前必须在上游轮换。任何真实 Key 都不能进入 Git、Website 环境或浏览器 bundle。

## 9. 在 1Panel 配置 Dashboard 环境变量

以下值全部在 `FrontMind-Dashboard → 环境变量` 中添加：

```env
NODE_ENV=production
PORT=3001

DATABASE_URL=mysql://frontmind_dashboard:<URL编码密码>@mysql:3306/frontmind_dashboard

FRONTMIND_CREDENTIAL_ENCRYPTION_KEY=base64:<新32字节base64>
FRONTMIND_ICP_MATERIAL_KEY=base64:<另一把新32字节base64>
FRONTMIND_PRESALES_SERVICE_TOKEN=<新随机值，至少32字符>
FRONTMIND_PROVISIONING_SERVICE_TOKEN=<另一新随机值，至少32字符>
FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET=<第三个独立随机值>
FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_TTL_SECONDS=300

FRONTMIND_MONITOR_API_KEY=<监控服务专用Key>

FRONTMIND_PUBLIC_URL=https://dashboard.frontmind.net
FRONTMIND_WEBSITE_URL=https://www.frontmind.net

FRONTMIND_PREPARED_FILE_DIR=/var/lib/frontmind/prepared-files
FRONTMIND_PREPARED_FILE_TTL_MS=2592000000
FRONTMIND_DASHBOARD_ASSET_DIR=/var/lib/frontmind/dashboard-assets
FRONTMIND_ICP_MATERIAL_DIR=/var/lib/frontmind/icp-materials
FRONTMIND_ICP_RETENTION_DAYS=365
FRONTMIND_PDF_WORKERS=1
FRONTMIND_CONVERSATION_RETENTION_DAYS=30
FRONTMIND_SERVICE_ENTITLEMENT_ENFORCEMENT=auto

FRONTMIND_KB_SKILL_PATH=/app/dist/private-workflows/socratic-kb-builder.skill
FRONTMIND_BRAND_QUESTION_SKILL_PATH=/app/dist/private-workflows/brand-question-portfolio.skill
FRONTMIND_RESPONSE_LOGIC_SKILL_PATH=/app/dist/private-workflows/response-logic-builder.skill
```

这里展示的均为变量名和占位符，不要把真实值粘贴到部署手册、终端共享输出、截图或 Git。
用户和应用不得在 `/frontmind-dashboard` 或容器 `/app` 创建 `.env`、`.env.local` 或
`.env.production`。所有敏感值只通过 1Panel 服务端环境变量界面管理。1Panel 自己可能
在 `/opt/1panel/runtime/...` 维护内部环境文件并挂载到容器 `/.env`；它不能挂到
`/app/.env*`，也不得由用户手工读取、编辑、复制或提交。

`FRONTMIND_MONITOR_API_KEY` 是监控专用 Key，只允许出现在 Dashboard 服务端的 1Panel
环境变量中；禁止写入 Website、前端配置或任何 `VITE_` 变量。两枚 service token 也禁止
使用 `VITE_` 前缀。

通常不需要设置 `FRONTMIND_UPSTREAM_BASE_URL` 和 `FRONTMIND_MONITOR_API_BASE_URL`；
代码内已有安全的正式默认地址。只有实际服务提供方要求更换时才配置，且必须是无账号、
查询参数和 fragment 的 HTTPS URL。

保存并重建后执行无回显运行环境门。它只输出固定成功/错误码，不输出任何环境变量值：

```bash
docker exec frontmind-dashboard \
  node /app/scripts/validate-production-runtime.mjs
```

必须只出现 `RUNTIME_ENV_OK`。任一错误都先修复对应变量名，禁止用 `env`、`printenv`、
`docker inspect .Config.Env` 或完整 Compose 输出排查。

## 10. 安装、检查、测试和构建

先确认应用目录没有项目级环境文件，且 1Panel 的内部 `/.env` 没有被挂载到 `/app`。只
检查路径，不读取文件内容或容器环境：

```bash
docker exec frontmind-dashboard sh -lc '
set -eu
for path in /app/.env*; do
  if [ "$path" = "/app/.env*" ]; then
    continue
  fi
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo "PROJECT_ENV_FILE_FORBIDDEN"
    exit 1
  fi
done
'

if docker inspect frontmind-dashboard \
  --format '{{range .Mounts}}{{println .Destination}}{{end}}' |
  grep -Eq '^/app/\.env(?:\.|$)'
then
  echo "PROJECT_ENV_MOUNT_FORBIDDEN"
  exit 1
fi
```

1Panel 自己在私有运行目录维护并挂载到 `/.env` 的配置属于面板实现细节，不是项目环境
文件；不要手工读取、修改或删除它。

在 Dashboard 容器中执行：

```bash
docker exec frontmind-dashboard sh -lc \
  'set -eu; cd /app; node -v; test "$(pnpm --version)" = "10.4.1"'

docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
env \
  -u DATABASE_URL \
  -u FRONTMIND_CREDENTIAL_ENCRYPTION_KEY \
  -u FRONTMIND_ICP_MATERIAL_KEY \
  -u FRONTMIND_PRESALES_SERVICE_TOKEN \
  -u FRONTMIND_PROVISIONING_SERVICE_TOKEN \
  -u FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET \
  -u FRONTMIND_MONITOR_API_KEY \
  pnpm install --prod=false --frozen-lockfile
'

docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
env \
  -u DATABASE_URL \
  -u FRONTMIND_CREDENTIAL_ENCRYPTION_KEY \
  -u FRONTMIND_ICP_MATERIAL_KEY \
  -u FRONTMIND_PRESALES_SERVICE_TOKEN \
  -u FRONTMIND_PROVISIONING_SERVICE_TOKEN \
  -u FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET \
  -u FRONTMIND_MONITOR_API_KEY \
  pnpm check
'

docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
env \
  -u DATABASE_URL \
  -u FRONTMIND_CREDENTIAL_ENCRYPTION_KEY \
  -u FRONTMIND_ICP_MATERIAL_KEY \
  -u FRONTMIND_PRESALES_SERVICE_TOKEN \
  -u FRONTMIND_PROVISIONING_SERVICE_TOKEN \
  -u FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET \
  -u FRONTMIND_MONITOR_API_KEY \
  pnpm test
'

docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
env \
  -u DATABASE_URL \
  -u FRONTMIND_CREDENTIAL_ENCRYPTION_KEY \
  -u FRONTMIND_ICP_MATERIAL_KEY \
  -u FRONTMIND_PRESALES_SERVICE_TOKEN \
  -u FRONTMIND_PROVISIONING_SERVICE_TOKEN \
  -u FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET \
  -u FRONTMIND_MONITOR_API_KEY \
  FRONTMIND_BUILD_VERSION=dashboard-20260728-r1 \
  pnpm build
'

docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
env \
  -u DATABASE_URL \
  -u FRONTMIND_CREDENTIAL_ENCRYPTION_KEY \
  -u FRONTMIND_ICP_MATERIAL_KEY \
  -u FRONTMIND_PRESALES_SERVICE_TOKEN \
  -u FRONTMIND_PROVISIONING_SERVICE_TOKEN \
  -u FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET \
  -u FRONTMIND_MONITOR_API_KEY \
  pnpm audit:production
'
```

如果 1Panel 实际挂载目录不是 `/app`，以容器中的真实工作目录替换，但 Skill 环境变量也
必须与生产构建产物绝对路径一致。

这里显式从 `pnpm install`、测试和构建子进程移除所有生产密钥，避免第三方安装脚本、
测试或前端构建读取真实值；不要删除这些 `env -u`。

验证产物：

```bash
docker exec frontmind-dashboard sh -lc '
set -eu
test -f /app/dist/index.js
test -f /app/dist/pdf-prepare-worker.js
test -f /app/dist/public/index.html
test -f /app/dist/private-workflows/socratic-kb-builder.skill
test -f /app/dist/private-workflows/brand-question-portfolio.skill/SKILL.md
test -f /app/dist/private-workflows/response-logic-builder.skill/SKILL.md
node --check /app/dist/index.js
node --check /app/dist/pdf-prepare-worker.js
cmp -s \
  /app/private-workflows/socratic-kb-builder.skill \
  /app/dist/private-workflows/socratic-kb-builder.skill
cmp -s \
  /app/private-workflows/brand-question-portfolio.skill/SKILL.md \
  /app/dist/private-workflows/brand-question-portfolio.skill/SKILL.md
cmp -s \
  /app/private-workflows/response-logic-builder.skill/SKILL.md \
  /app/dist/private-workflows/response-logic-builder.skill/SKILL.md
'

docker exec frontmind-dashboard node -e '
const value = require("/app/dist/public/__frontmind__/version.json");
if (value.version !== "dashboard-20260728-r1") process.exit(1);
console.log("BUILD_VERSION_OK dashboard-20260728-r1");
'

test -z "$(git -C /frontmind-dashboard status --short)"
git -C /frontmind-dashboard diff --check
```

任何命令失败都不能继续迁移。

## 11. 在空库执行 0000–0034 共 35 个迁移

数据库必须是刚创建且不含旧 Agent 数据的 `frontmind_dashboard`。唯一允许的 schema
变更命令是 `pnpm db:migrate`。

迁移前先核对仓库迁移源：

```bash
docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
test "$(find drizzle -maxdepth 1 -type f -name "*.sql" | wc -l)" -eq 35
test -f drizzle/0034_known_scarlet_spider.sql
'

docker exec frontmind-dashboard node -e '
const journal = require("/app/drizzle/meta/_journal.json");
if (journal.entries.length !== 35) process.exit(1);
if (journal.entries.at(-1)?.tag !== "0034_known_scarlet_spider") process.exit(1);
console.log("MIGRATION_SOURCE_OK count=35 latest=0034_known_scarlet_spider");
'
```

然后通过 Dashboard 容器实际持有的 `DATABASE_URL` 连接数据库，但不打印 URL 或密码。
必须同时确认数据库名、新用户主体和零表：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
import mysql from "mysql2/promise";
let connection;
try {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error();
  const target = new URL(raw);
  if (
    target.protocol !== "mysql:" ||
    target.hostname !== "mysql" ||
    (target.port && target.port !== "3306") ||
    decodeURIComponent(target.username) !== "frontmind_dashboard" ||
    target.pathname !== "/frontmind_dashboard" ||
    target.search ||
    target.hash ||
    !target.password
  ) {
    throw new Error();
  }
  connection = await mysql.createConnection(raw);
  const [[identity]] = await connection.query(
    "SELECT DATABASE() AS db, CURRENT_USER() AS principal",
  );
  const [[tables]] = await connection.query(
    "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  if (identity.db !== "frontmind_dashboard") {
    throw new Error();
  }
  if (!String(identity.principal).startsWith("frontmind_dashboard@")) {
    throw new Error();
  }
  if (Number(tables.table_count) !== 0) {
    throw new Error();
  }
  console.log(`EMPTY_DATABASE_TARGET_OK ${identity.db} ${identity.principal}`);
} catch {
  console.error("EMPTY_DATABASE_CHECK_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

只有出现 `MIGRATION_SOURCE_OK` 和 `EMPTY_DATABASE_TARGET_OK` 后才执行：

```bash
docker exec -it frontmind-dashboard sh -lc '
set -eu
cd /app
pnpm db:migrate
'
```

任何环境都绝对不要执行：

```bash
pnpm db:push
pnpm db:generate
```

如果迁移命令非零退出，立即停止，不要直接重跑。MySQL DDL 可能已经部分提交；在仍无新
业务写入时，只能先审计新库状态，必要时精确重建 Dashboard 自己的新空库后从 `0000`
重新执行，绝不能使用 `db:push` 或 `db:generate` 修补。

迁移成功后，将数据库账本的 35 行按 `created_at` 与 journal 时间戳、SQL SHA-256
逐项核对：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
import mysql from "mysql2/promise";
import { readMigrationFiles } from "drizzle-orm/migrator";
let connection;
try {
  const expected = readMigrationFiles({ migrationsFolder: "/app/drizzle" });
  connection = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await connection.query(
    "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC",
  );
  if (expected.length !== 35 || rows.length !== 35) {
    throw new Error();
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      String(rows[index].hash) !== expected[index].hash ||
      String(rows[index].created_at) !== String(expected[index].folderMillis)
    ) {
      throw new Error();
    }
  }
  console.log(
    "MIGRATIONS_VERIFIED count=35 latest=0034_known_scarlet_spider",
  );
} catch {
  console.error("MIGRATION_LEDGER_CHECK_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

只有出现 `MIGRATIONS_VERIFIED count=35 latest=0034_known_scarlet_spider` 才算完成。
此时新库已包含新 Dashboard schema，不应再称为“空库”，但不得含任何旧 Agent 客户
数据。

## 12. 初始化唯一系统管理员

先确认新库还没有任何用户，防止重复执行初始化：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
import mysql from "mysql2/promise";
let connection;
try {
  connection = await mysql.createConnection(process.env.DATABASE_URL);
  const [[row]] = await connection.query("SELECT COUNT(*) AS count FROM users");
  if (Number(row.count) !== 0) throw new Error();
  console.log("ADMIN_INIT_PRECHECK_OK users=0");
} catch {
  console.error("ADMIN_INIT_PRECHECK_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

在 TTY 中执行，密码不会进入命令历史：

```bash
docker exec -it frontmind-dashboard sh -lc '
cd /app
pnpm admin:init -- --username admin --display-name "FrontMind Admin"
'
```

然后用不返回密码字段的查询断言只有这一名系统管理员：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
import mysql from "mysql2/promise";
let connection;
try {
  connection = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await connection.query(
    "SELECT username, role, adminAccessLevel, isActive FROM users ORDER BY id",
  );
  if (rows.length !== 1) throw new Error();
  const [admin] = rows;
  if (
    admin.username !== "admin" ||
    admin.role !== "admin" ||
    admin.adminAccessLevel !== "system_admin" ||
    Number(admin.isActive) !== 1
  ) {
    throw new Error();
  }
  console.log("ADMIN_VERIFIED count=1 role=admin access=system_admin active=1");
} catch {
  console.error("ADMIN_VERIFICATION_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

## 13. 停止旧 Agent，并让 Dashboard 接管 3001

进入维护窗口后先冻结 Website 的支付、开户和所有会写入旧 Agent 的入口。根据第 3 节
记录的精确运行环境名称，在 1Panel 中停止旧 Agent 并关闭其自动重启；此时只停止，不删除
任何旧资产。同时停止仍处于 `sleep infinity` 的 `FrontMind-Dashboard`，然后以失败关闭
方式确认宿主机 `3001` 已释放：

```bash
if ss -H -lnt 'sport = :3001' | grep -q .; then
  echo "PORT_3001_STILL_IN_USE"
  exit 1
fi
echo "PORT_3001_RELEASED"
```

必须出现 `PORT_3001_RELEASED`。若仍被占用，只根据 1Panel 中核实过的精确容器名称/ID
查明来源；不要用
模糊进程匹配或批量停止命令。

在 1Panel 一次性完成最后的运行参数：

- 启动命令从 `sleep infinity` 改为 `pnpm start`；
- 宿主机只绑定 `127.0.0.1:3001` 到容器 `3001`，禁止 `0.0.0.0:3001`；
- 三个 Skill 绝对路径仍指向 `/app/dist/private-workflows/...`；
- 首次启动不要设置无限自动重启；保留关闭状态或最多使用已有的有界
  `on-failure:5`，先观察第一次非零退出。

1Panel 保存环境变量、端口或启动命令时可能重新生成 Compose，并把派生镜像恢复成
`1panel/node:${NODE_VERSION}`。所以保存后先不要直接启动：重新读取实际 Compose
标签和文件，按第 7 节再次把唯一 `image:` 改回本次 release SHA 的派生镜像，重新执行
`config --services`、`config --images`，再只对精确 `node` service 执行
`up -d --force-recreate --pull never`。不要另外手工启动第二个 `pnpm start`。

检查：

```bash
DASHBOARD_RELEASE_SHA="$(git -C /frontmind-dashboard rev-parse HEAD)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$(
  docker inspect frontmind-dashboard --format '{{.Image}}'
)" = "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" --format '{{.Id}}'
)"

docker exec frontmind-dashboard sh -lc '
set -eu
test "$(pnpm --version)" = "10.4.1"
test -d /app/node_modules
test -f /app/dist/index.js
test -f /app/dist/pdf-prepare-worker.js
command -v pdfinfo
command -v pdftotext
command -v pdfseparate
command -v pdfunite
command -v gs
'

docker exec frontmind-dashboard \
  node /app/scripts/validate-production-runtime.mjs

docker inspect frontmind-dashboard --format '{{json .Mounts}}' |
  docker exec -i frontmind-dashboard node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const mounts = JSON.parse(input);
  const expected = new Map([
    ["/var/lib/frontmind/prepared-files", "/srv/frontmind-dashboard/prepared-files"],
    ["/var/lib/frontmind/dashboard-assets", "/srv/frontmind-dashboard/dashboard-assets"],
    ["/var/lib/frontmind/icp-materials", "/srv/frontmind-dashboard/icp-materials"],
  ]);
  for (const [destination, source] of expected) {
    const mount = mounts.find(item => item.Destination === destination);
    if (!mount || mount.Source !== source || mount.RW !== true) process.exit(1);
  }
  console.log("PERSISTENT_MOUNTS_OK");
});
'

docker exec frontmind-dashboard sh -lc '
set -eu
for directory in \
  /var/lib/frontmind/prepared-files \
  /var/lib/frontmind/dashboard-assets \
  /var/lib/frontmind/icp-materials
do
  test -d "$directory"
  test -w "$directory"
  probe="$(mktemp "$directory/.frontmind-write-test.XXXXXX")"
  rm -f -- "$probe"
done
echo "PERSISTENT_MOUNTS_WRITABLE"
'

docker inspect frontmind-dashboard \
  --format '{{json .NetworkSettings.Networks}}' |
  docker exec -i frontmind-dashboard node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const networks = JSON.parse(input);
  const network = networks["1panel-network"];
  if (!network || !network.Aliases?.includes("frontmind-dashboard")) {
    process.exit(1);
  }
  console.log("PRIVATE_NETWORK_ALIAS_OK");
});
'

docker exec frontmind-dashboard getent hosts mysql >/dev/null
docker exec frontmind-dashboard getent hosts frontmind-dashboard >/dev/null

test "$(
  docker port frontmind-dashboard 3001/tcp
)" = "127.0.0.1:3001"

docker inspect frontmind-dashboard \
  --format 'status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} restarts={{.RestartCount}}'

READY=false
for attempt in $(seq 1 60); do
  if test "$(
    docker inspect frontmind-dashboard --format '{{.State.Running}}'
  )" != "true"; then
    break
  fi
  if docker exec frontmind-dashboard node --input-type=module -e '
const response = await fetch("http://127.0.0.1:3001/healthz");
const payload = await response.json();
if (!response.ok || payload?.status !== "ok") process.exit(1);
' >/dev/null 2>&1
  then
    READY=true
    break
  fi
  sleep 1
done
test "$READY" = "true"
test "$(
  docker inspect frontmind-dashboard --format '{{.RestartCount}}'
)" = "$INITIAL_RESTART_COUNT"
echo "LOCAL_DASHBOARD_READY"
```

启动日志不得包含数据库密码、API Key 或 service token。
`pnpm start` 如果初始化失败必须以非零状态退出；1Panel 必须显示启动失败/不健康，禁止用
`|| true`、守护循环或其他包装吞掉退出码。

如果状态不是持续 `running` 或健康检查失败，只在服务器私有控制台本地检查
`docker logs --tail 200 frontmind-dashboard`，不要复制原始日志到聊天、工单或截图。健康
稳定后才能启用最终自动重启策略；该 UI 保存若再次重建 Compose，仍须重复派生镜像、
pnpm、产物、PDF、端口和健康检查。

## 14. 配置 dashboard.frontmind.net

在 1Panel 新建反向代理网站：

```text
域名：dashboard.frontmind.net
上游：http://127.0.0.1:3001
HTTPS：开启
HTTP → HTTPS：开启
```

根路径整体代理，不能部署在 `/dashboard/` 子路径。建议配置：

```nginx
client_max_body_size 0;
proxy_http_version 1.1;
proxy_request_buffering off;
proxy_buffering off;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

Website 通过私有 Docker DNS 调用内部接口，因此公网代理必须同时拒绝无尾斜杠入口和
全部子路径。下面两个 `location` 都要放在网站的同一个 `server {}` 内，并与反向代理的
`location /` 同级，不能嵌套在 `location /` 内：

```nginx
location = /api/internal {
    return 404;
}

location ^~ /api/internal/ {
    return 404;
}
```

验证：

```bash
curl -fsS https://dashboard.frontmind.net/healthz
for path in \
  /api/internal \
  /api/internal/presales/status \
  /api/internal/provisioning/payment-receipts/ready \
  /api/internal/not-public
do
  code="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      "https://dashboard.frontmind.net$path"
  )"
  test "$code" = "404"
  echo "PUBLIC_INTERNAL_404_OK $path"
done
```

四条都必须为 `404`，不能是由应用返回的 `401`、`403` 或上游正文。

## 15. Dashboard 健康门

```bash
curl -fsS https://dashboard.frontmind.net/healthz | jq -e '
  .status == "ok" and
  .configuration.monitorCredentialConfigured == true and
  .configuration.monitorApiBaseUrlConfigured == true and
  .configuration.publicUrlConfigured == true and
  .configuration.upstreamBaseUrlConfigured == true and
  .preparedFiles.status == "ok" and
  .internalLedgers.paymentReceipts.ready == true and
  .internalLedgers.projectOrders.ready == true and
  ([.skills[].name] | sort) ==
    ([
      "brand-question-portfolio",
      "response-logic-builder",
      "socratic-kb-builder"
    ] | sort)
'
```

`/healthz` 不检查管理员录入的售前 API Key。管理员完成第 16 节的“验证并启用”后，
还必须在 Dashboard 容器内部验证三条受保护接口。以下检查直接由 Node 进程从环境读取
token，不把真实值放进宿主机命令历史或 `curl` 子进程参数，只输出就绪标记：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
const checks = [
  {
    name: "PRESALES",
    url: "http://127.0.0.1:3001/api/internal/presales/status",
    header: "x-frontmind-service-token",
    token: process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
    valid: p =>
      p?.ok === true &&
      p?.credentialConfigured === true &&
      p?.monitorCredentialConfigured === true &&
      p?.publicUrlConfigured === true,
  },
  {
    name: "PAYMENT_LEDGER",
    url: "http://127.0.0.1:3001/api/internal/provisioning/payment-receipts/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
  {
    name: "PROJECT_LEDGER",
    url: "http://127.0.0.1:3001/api/internal/provisioning/project-orders/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
];
for (const c of checks) {
  if (!c.token) throw new Error(`${c.name}_TOKEN_MISSING`);
  const response = await fetch(c.url, {
    headers: { [c.header]: c.token },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok || !c.valid(payload)) {
    throw new Error(`${c.name}_NOT_READY_HTTP_${response.status}`);
  }
  console.log(`${c.name}_READY`);
}
'
```

## 16. 配置并真实验证上游凭据

1. 打开 `https://dashboard.frontmind.net/login`。
2. 使用系统管理员登录。
3. 进入 `侧栏 → 售前页面`。
4. 输入售前 API Key，点击“测试连接”。
5. 测试通过后点击“验证并启用”。
6. 刷新页面，确认 Key 已由 Dashboard 加密保存到新数据库，界面只显示脱敏状态且不回显
   完整 Key。
7. 执行第 15 节的三条内部就绪检查，确认 `PRESALES_READY`、两个账本就绪标记全部出现。
8. 继续部署并重新构建 Website；真实 Base 和监控 canary 从 Website 执行，放在恢复正式
   流量之前。

只完成“连接测试”不代表 API 链路已验收；最终仍必须至少完成一次真实任务和一次真实
监控，但 Dashboard 售前页面本身不负责创建 Base。

## 17. Website 对接值

只有 Dashboard 全部健康后，才能在 Website 的 1Panel 环境变量中配置：

```env
FRONTMIND_PRESALES_AGENT_URL=http://frontmind-dashboard:3001/api/internal/presales
FRONTMIND_PRESALES_SERVICE_TOKEN=<与Dashboard完全一致>
FRONTMIND_AGENT_PROVISIONING_URL=http://frontmind-dashboard:3001/api/internal/provisioning
FRONTMIND_PROVISIONING_SERVICE_TOKEN=<与Dashboard完全一致>
FRONTMIND_AGENT_INTERNAL_HTTP_HOSTS=frontmind-dashboard
VITE_CLIENT_PORTAL_URL=https://dashboard.frontmind.net/login
```

`VITE_CLIENT_PORTAL_URL` 是浏览器构建时变量，必须在 Website 构建前存在。service token
绝不能带 `VITE_` 前缀。

Website 配置并完成新的生产构建、启动后，先从 1Panel 或 `docker ps` 核对 Website 的
精确容器名，不要猜大小写。下面用已核实的名称替换 `<Website精确容器名>`，验证真实
私有 DNS、网络和两枚 token：

```bash
docker exec <Website精确容器名> getent hosts frontmind-dashboard

docker exec <Website精确容器名> node --input-type=module -e '
const checks = [
  {
    name: "PRESALES",
    url: "http://frontmind-dashboard:3001/api/internal/presales/status",
    header: "x-frontmind-service-token",
    token: process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
    valid: p =>
      p?.ok === true &&
      p?.credentialConfigured === true &&
      p?.monitorCredentialConfigured === true &&
      p?.publicUrlConfigured === true,
  },
  {
    name: "PAYMENT_LEDGER",
    url: "http://frontmind-dashboard:3001/api/internal/provisioning/payment-receipts/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
  {
    name: "PROJECT_LEDGER",
    url: "http://frontmind-dashboard:3001/api/internal/provisioning/project-orders/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
];
for (const c of checks) {
  if (!c.token) throw new Error(`${c.name}_TOKEN_MISSING`);
  const response = await fetch(c.url, {
    headers: { [c.header]: c.token },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok || !c.valid(payload)) {
    throw new Error(`${c.name}_NOT_READY_HTTP_${response.status}`);
  }
  console.log(`${c.name}_READY`);
}
'
```

这组三条跨容器检查不能提前到 Website 配置前执行，也不能用 Website 容器中的
`127.0.0.1` 代替 `frontmind-dashboard`。

## 18. 最终验收并恢复 Website 流量

按以下顺序完成验收，任何一项失败都不得删除旧资产：

1. `FrontMind-Dashboard` 是宿主机 `3001` 的唯一监听应用，重启后仍能自动恢复。
2. `https://dashboard.frontmind.net/healthz` 通过第 15 节健康门。
3. 公网访问任意 `/api/internal/*` 路径都返回 `404`；不能是 `401`、`403` 或上游正文。
4. 三个运行时 Skill 均存在并通过名称、版本和内容哈希检查：
   `socratic-kb-builder`、`brand-question-portfolio`、`response-logic-builder`。
5. 支付回执账本、项目订单账本、Website Presales 和 Provisioning 内部接口全部通过。
6. Dashboard 新版简略看板页面及其 API 契约通过管理员和普通用户回归。
7. 普通用户看不到完整或脱敏 Key 值、上游积分、管理员身份/权限信息。
8. API 响应、Axios 错误、服务端日志和浏览器控制台不泄露 Key、service token、数据库凭据
   或上游原始敏感响应；只接受可信 assistant 输出的任务通过 canary。
9. 售前 API Key 已通过 Dashboard 售前页面加密保存，监控专用 Key 的真实监控 canary
   完成。
10. Website 容器通过 `frontmind-dashboard:3001` 成功调用内部接口，Website 重新构建并
    部署后，支付、开户和跳转 Dashboard 的完整链路通过。
11. 从 Website 使用非客户、非敏感 canary 完成 Base ZIP 与 20 题、单平台固定 5 次
    监控及引用/来源渲染、现状评估与四周预测、支付回执、项目订单、开户、导入和普通
    用户简略看板；清理 canary 后确认重试没有重复扣费或重复提交。
12. 为新 `frontmind_dashboard` 和三个新持久目录建立同一恢复点的首份备份；在隔离
    数据库和隔离临时目录中完成真实恢复演练，绝不能覆盖在线新库或在线目录。确认新的
    凭据加密密钥和 ICP 密钥可从受控密码管理恢复，否则数据库/ICP 备份不可用。备份中
    不得混入旧 Agent 数据。

以上结果需记录 release SHA、构建版本、验收时间和验收人。全部通过后才解除 Website
维护/冻结状态并恢复正式流量。不要在同一个维护窗口立即删除旧资产；先书面确定稳定
观察窗口（默认至少 24 小时且覆盖一次真实业务检查），窗口内持续通过全部健康门后再
进入永久退役。

## 19. 永久退役旧 Agent

只有第 18 节已签字验收、新 Dashboard 连续稳定运行且新系统备份可恢复后，才能永久删除
旧生产资产。旧 GitHub `frontmind-agent` Private Repo 始终保留为历史仓库，不删除、
不归档本地改动到该仓库，也不接收 Dashboard push。

严格按以下顺序执行，每一步只处理第 3 节清单中已经双人复核的一个精确目标：

1. 再次确认旧 Agent 已停止且自动重启关闭，并确认 `3001` 的唯一监听者是
   `FrontMind-Dashboard`。
2. 在 1Panel 中删除清单所列的旧 Agent 运行环境；删除前逐字比对运行环境名称和容器
   ID，确认不是 `FrontMind-Dashboard`。删除弹窗不得勾选含义不明确的级联删除数据、
   卷或共享镜像选项。
3. 在 1Panel 中删除 `agent.frontmind.net` 对应的精确网站、反向代理和证书绑定；随后在
   DNS 控制台按清单中的精确记录 ID 删除 `agent.frontmind.net` DNS 记录。不得影响
   `dashboard.frontmind.net` 或 `www.frontmind.net`。
4. 对旧服务器代码目录执行只读核对：显示其规范化绝对路径、挂载来源和一级内容，并确认
   `realpath -e` 结果、`findmnt`、symlink 状态和所有容器 Mount Source；确认路径不等于、
   不包含且不指向 `/frontmind-dashboard`、`/srv/frontmind-dashboard`、三个新目录、
   `/` 或其他父目录，并确认没有新容器引用。只在 1Panel 文件管理器中选中清单记录的
   那个精确旧叶子目录删除。
5. 在 1Panel 数据库界面逐字核对数据库实例、旧数据库名、完整旧 `username@host` 主体
   和 `SHOW GRANTS`；确认该主体未被 Website、新 Dashboard 或其他数据库共享，且
   Dashboard 当前连接的是 `frontmind_dashboard`。先撤销旧库授权并删除该精确旧用户
   主体，再删除旧数据库。发现共享授权立即停止；不得删除 `frontmind_dashboard` 或其
   用户。
6. 分别核对旧 `prepared-files`、旧 `dashboard-assets`、旧 ICP 目录及清单中的其他旧
   持久目录/卷。每个目标都要显示规范化绝对路径或精确卷名，确认不指向三个
   `/srv/frontmind-dashboard/...` 新目录后，在 1Panel 中逐项删除。命名卷还必须先
   `inspect` 并确认没有任何其他容器引用。
7. 先按精确计划任务 ID 停用旧 Agent 的备份、快照、同步、清理和导出任务；再按任务
   ID、快照 ID、规范化导出路径、远端 bucket/object/version ID 逐个永久删除旧副本。
   若远端存储有版本控制或回收站，还要确认永久删除语义。不得删除新 Dashboard 的备份。
8. 在上游提供方按凭据 ID/名称撤销只属于旧 Agent 的外部 Key 和 token，不读取、不
   回显真实值；共享情况不清楚时立即停止。
9. 重新执行 Dashboard、Website 私有接口、公网 `/api/internal/* = 404`、登录和账本
   健康检查，确认退役动作未影响新系统。

禁止使用通配符、变量展开、前缀匹配、批量容器/数据库删除或宽泛 `rm -rf`。本文故意不
提供旧目录删除命令：任何删除都必须在 1Panel/DNS 界面中针对已记录的精确名称、ID 或
规范化绝对路径逐项完成。目标不完全明确或与新资产有交叉时立即停止。

## 20. 回滚边界

旧 Agent、旧数据库和旧持久目录不是回滚目标，即使它们在最终删除前仍暂存于服务器，也
不得重新承接 Dashboard 流量。

- 尚未产生新业务数据时：停止 Dashboard，精确删除并重建它自己的
  `frontmind_dashboard` 空库和三个 `/srv/frontmind-dashboard/...` 新持久目录，重新执行
  `0000`–`0034` 共 35 个迁移，再重新验收。
- 已产生新业务数据时：先冻结 Website 支付、开户和写入，保存故障现场，只允许恢复
  新 Dashboard 自己的已验证数据库与持久目录备份，或进行向前修复。
- 只有 Website 失败时：Website 只能回滚到与当前 Dashboard 内部接口契约兼容的已验证
  产物，内部地址仍为 `frontmind-dashboard:3001`。

永久删除旧数据库后，不存在、也不允许设计“回滚到旧数据库”的路径。无法确认新系统备份
可恢复时保持维护状态，不得用旧 Agent 应急。

## 21. 后续更新

以后只从新的 `frontmind-dashboard` 仓库发布 Dashboard：

```bash
git -C /frontmind-dashboard status --short --branch
git -C /frontmind-dashboard pull --ff-only origin main
```

然后原样执行第 10 节带完整 `env -u` 的安装、检查、测试、固定版本构建、产物验证和
审计，不能让这些子进程继承生产密钥。确认目标数据库和迁移源后，schema 变更仍然只允许
`pnpm db:migrate`；禁止
`pnpm db:push`、`pnpm db:generate`、服务器临时改代码和并行启动第二个 Node 进程。
全部成功后才从 1Panel 重启；任何 1Panel UI 保存后都要重新确认固定派生镜像没有被
恢复为基础镜像。

## 22. 完成标准

- [ ] 本次代码只推送到新 Private Repo `xiafanzeng/frontmind-dashboard`，旧
  `frontmind-agent` 仓库未接收 push。
- [ ] 本地文件夹最终命名为 `frontmind-dashboard`；服务器代码目录为
  `/frontmind-dashboard`，容器工作目录为 `/app`。
- [ ] 新 Dashboard 是 `3001` 的唯一监听应用，公开域名为
  `https://dashboard.frontmind.net`。
- [ ] 新 `frontmind_dashboard` 空库已通过 `pnpm db:migrate` 完成 `0000`–`0034` 共
  35 个迁移；未执行 `db:push` 或 `db:generate`。
- [ ] 三个全新 `/srv/frontmind-dashboard/...` 持久目录正确挂载。
- [ ] 凭据加密密钥、ICP 密钥和 service token 均为全新值且只存放于 1Panel 服务端
  环境变量；仓库目录和容器 `/app` 不存在 `.env`、`.env.local` 或 `.env.production`，
  1Panel 内部运行配置未被挂入 `/app`。
- [ ] 售前 API Key 已由管理员在 Dashboard 售前页面录入并加密保存；
  `FRONTMIND_MONITOR_API_KEY` 只存在于 Dashboard 服务端环境变量。
- [ ] 五个 PDF 命令均存在，Dashboard `/healthz` 和三个运行时 Skill 全部通过。
- [ ] 支付回执账本、项目订单账本、Presales、Provisioning 和简略看板接口契约全部通过。
- [ ] Website 通过 `frontmind-dashboard:3001` 调用内部接口，任何 service token 都没有
  `VITE_` 前缀。
- [ ] 公网 `/api/internal/*` 返回 `404`。
- [ ] 普通用户看不到 Key、积分或管理员信息；API/Axios 错误、日志和构建产物不含敏感值。
- [ ] 新 Dashboard 验收后，旧 Agent 运行环境、`agent.frontmind.net` 网站与 DNS、旧
  服务器代码目录、旧数据库与用户、旧 prepared-files、旧 dashboard-assets、旧
  ICP/其他持久目录均已按精确目标永久删除。
- [ ] 新系统备份可恢复；回滚方案只使用新 Dashboard 空库重建或新系统自身备份。
