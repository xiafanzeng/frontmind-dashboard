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
| 私有容器 DNS    | `frontmind-dashboard`                 |
| 应用端口        | `3001`                                |
| 公开域名        | `https://dashboard.frontmind.net`     |
| Website 域名    | `https://www.frontmind.net`           |
| MySQL 数据库    | `frontmind_dashboard`                 |
| MySQL 用户      | `frontmind_dashboard`                 |
| Node            | `22.12+`                              |
| pnpm            | 仓库 `packageManager` 声明的 `10.4.1` |

生产环境的敏感配置只写入 1Panel 运行环境变量界面。不要在服务器创建 `.env`、
`.env.local` 或 `.env.production`，也不要执行 `cp .env.example .env`。

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
| 旧数据库用户 | 精确用户名和授权来源 |
| 旧 prepared-files | 规范化后的唯一绝对路径或卷名 |
| 旧 dashboard-assets | 规范化后的唯一绝对路径或卷名 |
| 旧 ICP/其他持久数据 | 每一个规范化绝对路径或卷名，逐项记录 |

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

数据库不映射公网 `3306`。Dashboard 与 MySQL 必须加入同一个私有 Docker 网络，并使用
1Panel 中实际的 MySQL 服务 DNS 名（下文示例为 `mysql`），不能在 Dashboard 容器中使用
`127.0.0.1`。

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
宿主机代码目录：/frontmind-dashboard
容器内工作目录：/app
Node：22.12+ LTS
端口：3001
初始启动命令：sleep infinity
自动重启：迁移完成前关闭
```

不同 1Panel 版本对“代码目录/运行目录”的字段命名不同：宿主机仓库应挂载到容器
`/app`，后文所有容器命令都以 `/app` 为准。创建后先运行
`docker exec FrontMind-Dashboard pwd` 和 `ls -la /app/package.json`；若实际挂载点不同，
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

Dashboard 镜像必须永久包含：

```text
poppler-utils
ghostscript
```

容器内验证：

```bash
docker exec FrontMind-Dashboard sh -lc \
'command -v pdfinfo &&
 command -v pdftotext &&
 command -v pdfseparate &&
 command -v pdfunite &&
 command -v gs'
```

五项都必须返回路径。缺少时应修改 1Panel 使用的固定镜像/构建配置后重建运行环境；
不要只 `apt install` 到一次性容器中。

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
生产服务器不创建 `.env`、`.env.local` 或 `.env.production`。所有敏感值只保存在
1Panel 的服务端环境变量配置中。

`FRONTMIND_MONITOR_API_KEY` 是监控专用 Key，只允许出现在 Dashboard 服务端的 1Panel
环境变量中；禁止写入 Website、前端配置或任何 `VITE_` 变量。两枚 service token 也禁止
使用 `VITE_` 前缀。

通常不需要设置 `FRONTMIND_UPSTREAM_BASE_URL` 和 `FRONTMIND_MONITOR_API_BASE_URL`；
代码内已有安全的正式默认地址。只有实际服务提供方要求更换时才配置，且必须是无账号、
查询参数和 fragment 的 HTTPS URL。

## 10. 安装、检查、测试和构建

在 Dashboard 容器中执行：

```bash
docker exec FrontMind-Dashboard sh -lc \
  'cd /app && corepack enable && node -v && pnpm -v'

docker exec FrontMind-Dashboard sh -lc \
  'cd /app && pnpm install --prod=false --frozen-lockfile'

docker exec FrontMind-Dashboard sh -lc \
  'cd /app && pnpm check'

docker exec FrontMind-Dashboard sh -lc \
  'cd /app && pnpm test'

docker exec FrontMind-Dashboard sh -lc \
  'cd /app && FRONTMIND_BUILD_VERSION=dashboard-20260728-r1 pnpm build'

docker exec FrontMind-Dashboard sh -lc \
  'cd /app && pnpm audit:production'
```

如果 1Panel 实际挂载目录不是 `/app`，以容器中的真实工作目录替换，但 Skill 环境变量也
必须与生产构建产物绝对路径一致。

验证产物：

```bash
docker exec FrontMind-Dashboard sh -lc '
set -eu
test -f /app/dist/index.js
test -f /app/dist/pdf-prepare-worker.js
test -f /app/dist/public/index.html
test -f /app/dist/private-workflows/socratic-kb-builder.skill
test -f /app/dist/private-workflows/brand-question-portfolio.skill/SKILL.md
test -f /app/dist/private-workflows/response-logic-builder.skill/SKILL.md
'
```

任何命令失败都不能继续迁移。

## 11. 在空库执行 0000–0034 共 35 个迁移

数据库必须是刚创建且不含旧 Agent 数据的 `frontmind_dashboard`。唯一允许的 schema
变更命令是：

```bash
docker exec -it FrontMind-Dashboard sh -lc '
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

迁移成功后，在 1Panel 数据库终端核对：

```sql
SELECT COUNT(*) AS migration_count
FROM __drizzle_migrations;

SELECT *
FROM __drizzle_migrations
ORDER BY id DESC
LIMIT 5;

SHOW TABLES;
```

当前 release 预期 `migration_count = 35`，最新迁移对应 `0034_known_scarlet_spider`。
空库中除迁移账本外没有任何旧 Agent 客户数据。

## 12. 初始化唯一系统管理员

在 TTY 中执行，密码不会进入命令历史：

```bash
docker exec -it FrontMind-Dashboard sh -lc '
cd /app
pnpm admin:init -- --username admin --display-name "FrontMind Admin"
'
```

然后核对：

```sql
SELECT id, username, displayName, role, adminAccessLevel, isActive
FROM users
ORDER BY id;
```

预期只有刚创建的管理员，且：

```text
role = admin
adminAccessLevel = system_admin
isActive = 1
```

## 13. 停止旧 Agent，并让 Dashboard 接管 3001

进入维护窗口后先冻结 Website 的支付、开户和所有会写入旧 Agent 的入口。根据第 3 节
记录的精确运行环境名称，在 1Panel 中停止旧 Agent 并关闭其自动重启；此时只停止，不删除
任何旧资产。然后确认宿主机 `3001` 已释放：

```bash
ss -lntp | grep ':3001 ' || true
```

必须没有监听者。若仍有输出，只根据 1Panel 中核实过的精确容器名称/ID查明来源；不要用
模糊进程匹配或批量停止命令。

在 1Panel 把启动命令从：

```text
sleep infinity
```

改为：

```text
pnpm start
```

启用自动重启策略并重建/重启运行环境。不要另外手工启动第二个 `pnpm start`。

检查：

```bash
docker logs --tail 200 FrontMind-Dashboard
curl -fsS http://127.0.0.1:3001/healthz
```

启动日志不得包含数据库密码、API Key 或 service token。
`pnpm start` 如果初始化失败必须以非零状态退出；1Panel 必须显示启动失败/不健康，禁止用
`|| true`、守护循环或其他包装吞掉退出码。

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

Website 通过私有 Docker DNS 调用内部接口，因此公网代理应拒绝：

```nginx
location ^~ /api/internal/ {
    return 404;
}
```

验证：

```bash
curl -fsS https://dashboard.frontmind.net/healthz
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://dashboard.frontmind.net/api/internal/presales/status
```

第二条应为 `404`，不能公开内部 service-token 接口。

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

先在 Dashboard 容器内部验证三条受保护接口；命令中的变量只在容器内展开，不会把 token
写进宿主机命令历史：

```bash
docker exec FrontMind-Dashboard sh -lc '
set -eu
curl -fsS \
  -H "x-frontmind-service-token: $FRONTMIND_PRESALES_SERVICE_TOKEN" \
  http://127.0.0.1:3001/api/internal/presales/status

curl -fsS \
  -H "x-frontmind-provisioning-token: $FRONTMIND_PROVISIONING_SERVICE_TOKEN" \
  http://127.0.0.1:3001/api/internal/provisioning/payment-receipts/ready

curl -fsS \
  -H "x-frontmind-provisioning-token: $FRONTMIND_PROVISIONING_SERVICE_TOKEN" \
  http://127.0.0.1:3001/api/internal/provisioning/project-orders/ready
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
7. 使用非客户、非敏感 canary 内容创建一个 Base 任务，轮询到完成并下载结果。
8. 用专用监控 Key 发起单平台固定 5 次回答的监控 canary，确认答案、引用和来源可渲染。
9. 删除 canary 任务，确认不会再次扣费或因重试重复提交。

只完成“连接测试”不代表 API 链路已验收；必须至少完成一次真实任务和一次真实监控。

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

Website 配置并启动后，再从 Website 容器验证真实私有 DNS、网络和两枚 token：

```bash
docker exec FrontMind-Website sh -lc '
set -eu
curl -fsS \
  -H "x-frontmind-service-token: $FRONTMIND_PRESALES_SERVICE_TOKEN" \
  http://frontmind-dashboard:3001/api/internal/presales/status
curl -fsS \
  -H "x-frontmind-provisioning-token: $FRONTMIND_PROVISIONING_SERVICE_TOKEN" \
  http://frontmind-dashboard:3001/api/internal/provisioning/payment-receipts/ready
curl -fsS \
  -H "x-frontmind-provisioning-token: $FRONTMIND_PROVISIONING_SERVICE_TOKEN" \
  http://frontmind-dashboard:3001/api/internal/provisioning/project-orders/ready
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
11. 为新 `frontmind_dashboard` 和三个新持久目录建立新系统首份备份，并完成可恢复性
    检查；备份中不得混入旧 Agent 数据。

以上结果需记录 release SHA、构建版本、验收时间和验收人。全部通过后才解除 Website
维护/冻结状态并恢复正式流量。

## 19. 永久退役旧 Agent

只有第 18 节已签字验收、新 Dashboard 连续稳定运行且新系统备份可恢复后，才能永久删除
旧生产资产。旧 GitHub `frontmind-agent` Private Repo 始终保留为历史仓库，不删除、
不归档本地改动到该仓库，也不接收 Dashboard push。

严格按以下顺序执行，每一步只处理第 3 节清单中已经双人复核的一个精确目标：

1. 再次确认旧 Agent 已停止且自动重启关闭，并确认 `3001` 的唯一监听者是
   `FrontMind-Dashboard`。
2. 在 1Panel 中删除清单所列的旧 Agent 运行环境；删除前逐字比对运行环境名称和容器
   ID，确认不是 `FrontMind-Dashboard`。
3. 在 1Panel 中删除 `agent.frontmind.net` 对应的精确网站、反向代理和证书绑定；随后在
   DNS 控制台按清单中的精确记录 ID 删除 `agent.frontmind.net` DNS 记录。不得影响
   `dashboard.frontmind.net` 或 `www.frontmind.net`。
4. 对旧服务器代码目录执行只读核对：显示其规范化绝对路径、挂载来源和一级内容，并确认
   路径不等于 `/frontmind-dashboard`、`/srv/frontmind-dashboard`、`/` 或其他父目录。
   只在 1Panel 文件管理器中选中清单记录的那个精确旧代码目录删除。
5. 在 1Panel 数据库界面逐字核对数据库实例、旧数据库名和旧数据库用户名；确认
   Dashboard 当前连接的是 `frontmind_dashboard` 后，先删除旧数据库用户及其授权，再
   删除旧数据库。不得删除 `frontmind_dashboard` 或其用户。
6. 分别核对旧 `prepared-files`、旧 `dashboard-assets`、旧 ICP 目录及清单中的其他旧
   持久目录/卷。每个目标都要显示规范化绝对路径或精确卷名，确认不指向三个
   `/srv/frontmind-dashboard/...` 新目录后，在 1Panel 中逐项删除。
7. 删除清单所列的旧 Agent 备份、快照和导出副本，确保不能从遗留副本恢复旧客户数据；
   新 Dashboard 的备份必须保留。
8. 重新执行 Dashboard、Website 私有接口、公网 `/api/internal/* = 404`、登录和账本
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

然后在容器中：

```bash
docker exec FrontMind-Dashboard sh -lc \
  'cd /app && pnpm install --prod=false --frozen-lockfile'
docker exec FrontMind-Dashboard sh -lc 'cd /app && pnpm check'
docker exec FrontMind-Dashboard sh -lc 'cd /app && pnpm test'
docker exec FrontMind-Dashboard sh -lc \
  'cd /app && FRONTMIND_BUILD_VERSION=<本次固定Release-ID> pnpm build'
docker exec FrontMind-Dashboard sh -lc 'cd /app && pnpm audit:production'
docker exec FrontMind-Dashboard sh -lc 'cd /app && pnpm db:migrate'
```

全部成功后才从 1Panel 重启。schema 变更仍然只允许 `pnpm db:migrate`；禁止
`pnpm db:push`、`pnpm db:generate`、服务器临时改代码和并行启动第二个 Node 进程。

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
  环境变量；生产服务器不存在 `.env`、`.env.local` 或 `.env.production`。
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
