# 项目 Clone 到 1Panel 后的完整上线教程

> 适用范围：代码已经从 GitHub clone 到 1Panel 服务器，需要为项目创建独立 Node.js 运行环境、MySQL 数据库、账号系统和公网访问端口。
>
> 本教程根据 `FrontMind-Agent` 和 `CYCQ-FrontMind-Agent` 的实际成功部署过程整理。本次不包含定时清理和自动备份。

---

## 1. 部署参数

开始前先确定并记录以下参数。下文中的示例值必须替换为实际值。

| 参数 | CYCQ 实际示例 |
|---|---|
| 项目目录 | `/cycq-frontmind-agent` |
| 1Panel 运行环境名称 | `CYCQ-FrontMind-Agent` |
| Docker 容器名称 | `CYCQ-FrontMind-Agent` |
| 数据库名称 | `cycq_frontmind` |
| 数据库用户 | `cycq_frontmind` |
| Node 内部端口 | `3002` |
| 宿主机端口 | `3002` |
| 启动命令 | `pnpm start` |
| 管理员用户名 | `admin` |
| 管理员显示名称 | `CYCQ Admin` |

现有 FrontMind 使用 `/frontmind-agent`、`FrontMind-Agent`、`frontmind` 数据库和 `3001` 端口。新项目不得复用这些资源。

---

## 2. 验证 Clone 后的代码

```bash
git -C /cycq-frontmind-agent status --short --branch
git -C /cycq-frontmind-agent remote -v
git -C /cycq-frontmind-agent log -1 --oneline
```

确认：

- 仓库和分支正确。
- 最新提交是准备部署的版本。
- 没有服务器本地未提交修改。

检查必要文件：

```bash
test -f /cycq-frontmind-agent/package.json && echo PACKAGE_OK
test -f /cycq-frontmind-agent/drizzle.config.ts && echo DRIZZLE_CONFIG_OK
test -d /cycq-frontmind-agent/drizzle && echo MIGRATIONS_OK
test -f /cycq-frontmind-agent/dist/index.js && echo BUILD_EXISTS
```

如果缺少 `dist/index.js`，后续必须执行 `pnpm build`。

---

## 3. 核对代码要求的生产环境变量

不同品牌代码可能会把 `FRONTMIND_CREDENTIAL_ENCRYPTION_KEY` 改名。部署前必须以代码实际内容为准。

```bash
grep -RhoE 'process\.env\.[A-Z0-9_]+' \
  /cycq-frontmind-agent/server \
  /cycq-frontmind-agent/scripts \
  2>/dev/null | sort -u
```

重点搜索凭据加密变量：

```bash
grep -RIn 'CREDENTIAL_ENCRYPTION_KEY' \
  /cycq-frontmind-agent/server \
  /cycq-frontmind-agent/scripts \
  /cycq-frontmind-agent/.env.example \
  2>/dev/null
```

CYCQ 当前代码实际要求：

```text
CYQC_CREDENTIAL_ENCRYPTION_KEY
```

注意这里是代码中的 `CYQC`，不是项目名称顺序 `CYCQ`。部署时必须严格使用代码实际要求的变量名。之后如需统一拼写，应在本地修改代码、测试、提交和重新发布，不能直接猜测变量名。

---

## 4. 选择未占用端口

```bash
ss -lntp | grep -E ':3001\b|:3002\b|:8089\b'
```

已知：

- `3001`：现有 FrontMind。
- `8089`：phpMyAdmin。
- CYCQ 使用 `3002`。

确认目标端口没有被其他服务占用。

---

## 5. 先创建 Node.js 运行环境

进入：

```text
1Panel
→ 网站
→ 运行环境
→ Node.js
→ 创建运行环境
```

填写：

```text
名称：CYCQ-FrontMind-Agent
项目目录：/cycq-frontmind-agent
启动命令：pnpm start
容器名称：CYCQ-FrontMind-Agent
包管理器：pnpm
Node 版本：与 FrontMind-Agent 相同，至少 Node 20
端口：3002
```

其他设置：

```text
挂载：保持 1Panel 默认项目挂载
主机映射：留空
镜像源：根据服务器网络选择可用源
```

“主机映射”不是端口映射，不要把 `3002` 填入主机映射。

如果此时环境变量还没配置，`pnpm start` 会因为缺少 `DATABASE_URL` 或加密密钥而退出。这不代表代码损坏。

创建出运行环境后先点击“停止”，不要让它持续重启。1Panel 停止运行环境时可能删除运行容器，因此 `docker ps -a` 看不到它属于正常现象；运行环境配置仍保留在 1Panel 中，重新启动时会重新创建容器。

---

## 6. 创建独立 MySQL 数据库

进入：

```text
1Panel
→ 数据库
→ MySQL
→ 创建数据库
```

填写：

```text
数据库名称：cycq_frontmind
数据库用户：cycq_frontmind
字符集：utf8mb4
数据库密码：独立随机强密码
访问权限：参考现有 frontmind 数据库的成功配置
```

推荐用 URL 安全的十六进制密码：

```bash
openssl rand -hex 24
```

注意：

- 密码不要发送到聊天中。
- 如果密码曾出现在聊天、日志或截图中，立即重置。
- 不要修改现有 `frontmind` 数据库。
- 不要开放 MySQL 公网端口 `3306`。

创建后只读验证：

```bash
docker exec mysql sh -lc \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -NBe "SHOW DATABASES"' \
  | grep '^cycq_frontmind$'
```

预期输出：

```text
cycq_frontmind
```

---

## 7. 生成 API Key 加密密钥

```bash
openssl rand -base64 32
```

生成结果只保存到 1Panel 环境变量，不要发送到聊天中。

最终值格式：

```text
base64:<生成的完整Base64内容>
```

要求：

- `base64:` 前缀不能遗漏。
- 每个品牌实例使用独立密钥。
- 不要使用 FrontMind 原来的密钥。
- 密钥丢失或更换后，已经加密保存的 API Key 将无法解密。

---

## 8. 配置 1Panel 运行环境变量

进入：

```text
1Panel
→ 网站
→ 运行环境
→ CYCQ-FrontMind-Agent
→ 编辑
→ 环境变量
```

如果是 Key/Value 表格，添加：

| 变量名 | 变量值 |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3002` |
| `DATABASE_URL` | `mysql://cycq_frontmind:<数据库密码>@mysql:3306/cycq_frontmind` |
| `CYQC_CREDENTIAL_ENCRYPTION_KEY` | `base64:<生成的32字节密钥>` |
| `FRONTMIND_PREPARED_FILE_DIR` | `/var/lib/frontmind/prepared-files` |
| `FRONTMIND_PDF_WORKERS` | `1` |

如果是多行文本框：

```env
NODE_ENV=production
PORT=3002
DATABASE_URL=mysql://cycq_frontmind:<数据库密码>@mysql:3306/cycq_frontmind
CYQC_CREDENTIAL_ENCRYPTION_KEY=base64:<生成的32字节密钥>
FRONTMIND_PREPARED_FILE_DIR=/var/lib/frontmind/prepared-files
FRONTMIND_PDF_WORKERS=1
```

关键规则：

- `PORT` 必须和 1Panel 运行环境端口一致。
- Node 在 Docker 容器内运行时，数据库主机使用 `mysql`，不是 `127.0.0.1`。
- 加密变量名必须以第 3 节的代码核对结果为准。
- 不要同时保留多个拼写不同的旧加密变量，避免后续维护混乱。
- 环境变量保存后，必须重新启动运行环境才能注入新容器。
- 为 PDF 缓存增加持久卷挂载：宿主机
  `/cycq-frontmind-agent-data/prepared-files` 映射到容器
  `/var/lib/frontmind/prepared-files`。宿主机目录权限只授予运行容器。

---

## 9. 启动运行环境

在 1Panel 点击：

```text
CYCQ-FrontMind-Agent
→ 启动
```

等待数秒后：

```bash
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' \
  | grep -Ei 'cycq|frontmind|mysql'
```

预期同时看到：

```text
CYCQ-FrontMind-Agent
FrontMind-Agent
mysql
```

如果实际容器名称带随机后缀，后续命令使用 `Names` 列中的完整名称。

---

## 10. 检查启动日志

```bash
docker logs --tail 200 CYCQ-FrontMind-Agent
```

成功时应出现：

```text
Server running on http://0.0.0.0:3002/
```

常见错误：

```text
DATABASE_URL is required in production
```

表示 `DATABASE_URL` 没有保存或没有注入。

```text
CYQC_CREDENTIAL_ENCRYPTION_KEY is not configured
```

表示加密变量名或值没有正确注入。

日志中的下面警告不是本次启动失败原因：

```text
npm warn Unknown env config "manage-package-manager-versions"
```

---

## 11. 安全验证环境变量

不要直接运行 `env` 或 `printenv` 输出全部变量。

```bash
docker exec CYCQ-FrontMind-Agent sh -lc '
for key in NODE_ENV PORT DATABASE_URL CYQC_CREDENTIAL_ENCRYPTION_KEY; do
  if [ -n "$(printenv "$key")" ]; then
    echo "$key=SET"
  else
    echo "$key=MISSING"
  fi
done
'
```

预期：

```text
NODE_ENV=SET
PORT=SET
DATABASE_URL=SET
CYQC_CREDENTIAL_ENCRYPTION_KEY=SET
```

检查 Base64 密钥是否正好解码为 32 字节：

```bash
docker exec CYCQ-FrontMind-Agent node -e '
const value = process.env.CYQC_CREDENTIAL_ENCRYPTION_KEY || "";
const encoded = value.startsWith("base64:") ? value.slice(7) : value;
const length = Buffer.from(encoded, "base64").length;
console.log(length === 32 ? "KEY_LENGTH_OK" : "KEY_LENGTH_INVALID");
'
```

预期：

```text
KEY_LENGTH_OK
```

---

## 12. 检查源码挂载和 Docker 网络

源码挂载：

```bash
docker inspect CYCQ-FrontMind-Agent \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

预期：

```text
/cycq-frontmind-agent -> /app
```

检查文件：

```bash
docker exec CYCQ-FrontMind-Agent sh -lc '
cd /app &&
test -f package.json &&
test -d drizzle &&
echo APP_FILES_OK
'
```

检查网络：

```bash
docker inspect CYCQ-FrontMind-Agent \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}'

docker inspect mysql \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}'
```

两边至少需要一个相同的网络。

如果网络不同，应在 1Panel 中修改运行环境的持久网络配置。不要只依赖一次性的 `docker network connect`，因为 1Panel 停止运行环境后可能删除并重建容器。

---

## 13. 安装依赖和构建

```bash
docker exec CYCQ-FrontMind-Agent sh -lc \
  'cd /app && node -v && pnpm -v'
```

安装依赖：

```bash
docker exec CYCQ-FrontMind-Agent sh -lc \
  'cd /app && pnpm install --frozen-lockfile'
```

PDF 大文件分页处理依赖 Poppler，合并后的兼容性压缩依赖 Ghostscript。运行镜像必须预装
`pdfinfo`、`pdftotext`、`pdfseparate` 和 `pdfunite`（Debian/Ubuntu 软件包名为
`poppler-utils`）以及 `gs`（软件包名为 `ghostscript`），并把该安装写入自定义运行镜像，
不能只在一次性容器中临时安装。

只读验证：

```bash
docker exec CYCQ-FrontMind-Agent sh -lc \
  'command -v pdfinfo && command -v pdftotext && command -v pdfseparate && command -v pdfunite && command -v gs'
```

构建：

```bash
docker exec CYCQ-FrontMind-Agent sh -lc \
  'cd /app && pnpm build'
```

验证：

```bash
docker exec CYCQ-FrontMind-Agent sh -lc '
test -f /app/dist/index.js &&
test -f /app/dist/pdf-prepare-worker.js &&
test -f /app/dist/public/index.html &&
echo BUILD_OK
'
```

预期：

```text
BUILD_OK
```

每一步单独执行。不要把安装、构建、迁移和管理员初始化拼接成一个超长命令。

---

## 14. 执行数据库迁移

1Panel 已经把环境变量注入容器，因此不需要再读取 `/app/.env`：

```bash
docker exec CYCQ-FrontMind-Agent sh -lc \
  'cd /app && pnpm db:migrate'
```

成功输出：

```text
migrations applied successfully
```

生产环境不要使用：

```bash
pnpm db:push
```

只使用版本化迁移：

```bash
pnpm db:migrate
```

验证数据库表：

```bash
docker exec mysql sh -lc \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -NBe "SELECT table_name FROM information_schema.tables WHERE table_schema='\''cycq_frontmind'\'' ORDER BY table_name;"'
```

当前版本预期 10 张表：

```text
__drizzle_migrations
api_credentials
api_key_ownership
attachments
conversation_turns
conversations
messages
sessions
upstream_resources
users
```

---

## 15. 创建应用管理员

```bash
docker exec -it CYCQ-FrontMind-Agent sh -lc \
  'cd /app && pnpm admin:init -- --username admin --display-name "CYCQ Admin"'
```

这里要求输入的是 CYCQ 应用登录页中 `admin` 账号的密码，不是：

- 1Panel 密码。
- 服务器 root 密码。
- MySQL 密码。
- API Key。

输入密码时终端可能显示 `*`，也可能不显示字符。密码至少 6 位，建议使用 12 位以上强密码。

输入两次相同密码后，预期：

```text
管理员已创建：admin（ID 1）
```

交互完成前不要粘贴第二条命令。

---

## 16. 重启并验证持久配置

在 1Panel 中：

```text
CYCQ-FrontMind-Agent
→ 重启
```

然后检查：

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' \
  | grep -Ei 'cycq|frontmind|mysql'

docker logs --tail 150 CYCQ-FrontMind-Agent

curl -fsS http://127.0.0.1:3002/healthz
```

健康检查预期：

```json
{"status":"ok"}
```

这一步用于证明：

- 环境变量在容器重建后仍然有效。
- 数据库连接正常。
- 迁移记录和管理员账号已经保存到 MySQL。
- 新应用和原 FrontMind 可以同时运行。

---

## 17. 检查端口映射

```bash
docker port CYCQ-FrontMind-Agent
ss -lntp | grep ':3002'
curl -I http://127.0.0.1:3002/
```

理想映射：

```text
3002/tcp -> 0.0.0.0:3002
```

本机 `/healthz` 成功前不要开放公网。

---

## 18. 开放公网端口

进入：

```text
1Panel
→ 主机
→ 防火墙
→ 添加端口规则
```

填写：

```text
协议：TCP
端口：3002
来源：优先限制为当前测试者公网 IP
备注：CYCQ FrontMind Agent
```

确需公开访问时，来源才使用 `0.0.0.0/0`。

如果云服务商还有安全组，也要开放 TCP `3002`。

不要开放 MySQL `3306`。

公网测试：

```text
http://<服务器公网IP>:3002/
```

确认打开的是 CYCQ 登录页，而不是 FrontMind、phpMyAdmin、1Panel 或 Nginx 错误页。

---

## 19. 配置正式域名和 HTTPS

有正式域名时，在 1Panel 创建反向代理网站：

```text
域名：<CYCQ正式域名>
代理地址：http://127.0.0.1:3002
上传限制：0（不设置固定单文件大小上限）
HTTPS：开启
HTTP 跳转 HTTPS：开启
```

在该反向代理的 OpenResty 配置中，将下面指令放入应用代理的
`location` 段；`300s` 是连续无数据超时，不限制持续传输的总时长：

```nginx
client_max_body_size 0;
proxy_request_buffering off;
proxy_buffering off;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

验证：

```bash
curl -fsS https://<CYCQ正式域名>/healthz
```

预期：

```json
{"status":"ok"}
```

正式用户应使用 HTTPS 域名。数字 HTTP 端口适合临时验收。

---

## 20. 页面和跨设备验收

### 管理员登录

```text
用户名：admin
密码：执行 admin:init 时设置的应用管理员密码
```

### 创建普通测试用户

管理员进入账号管理，创建普通测试用户，确认可以：

- 创建用户。
- 禁用用户。
- 重置密码。
- 永久删除测试用户。

### API Key

普通用户登录后：

1. 打开 API Key 设置。
2. 查看教程。
3. 填写 Key。
4. 测试连接。
5. 保存。
6. 换浏览器登录，确认不需要重新填写。

多个应用账号可以共用一个上游 API Key；会话权限仍按应用用户隔离，但上游积分属于该 Key 的整体消耗。

### 跨设备同步

1. 设备 A 登录普通测试账号。
2. 创建会话并发送消息。
3. 设备 B或无痕窗口登录同一个账号。
4. 确认能看到设备 A 的会话和消息。
5. 在设备 B 继续发送消息。
6. 回到设备 A，确认会话继续同步。

### 用户隔离

1. 创建测试用户 A 和 B。
2. A 创建会话并上传附件。
3. B 不得看到或访问 A 的会话、任务和附件。

### 原 FrontMind 回归

确认：

- `FrontMind-Agent` 仍然运行。
- `agent.frontmind.net` 正常。
- 原 `frontmind` 数据库没有变化。
- CYCQ 只读取 `cycq_frontmind`。

---

## 21. 常见错误

### `DATABASE_URL is required in production`

1Panel 没有注入 `DATABASE_URL`，或者保存环境变量后没有重新启动运行环境。

### `*_CREDENTIAL_ENCRYPTION_KEY is not configured`

加密变量名称与新品牌代码不一致。重新执行第 3 节的代码搜索，以实际错误信息和源代码为准。

### `getaddrinfo ENOTFOUND mysql`

应用容器和 MySQL 容器不在同一个 Docker 网络，或者数据库主机名称不正确。

### `Access denied for user`

数据库用户名、密码、授权来源或 `DATABASE_URL` 不一致。

### `not valid JSON`

如果只发生在发布重启瞬间，通常是代理返回临时 502 HTML，而前端尝试按 JSON 解析。先检查 `/healthz` 和容器日志，不要删除数据库。

### 停止后 `docker ps -a` 看不到容器

1Panel 可能在停止运行环境时执行容器删除。运行环境配置仍保存在 1Panel，重新启动会重新创建容器。

---

## 22. 后续代码更新

用户新增会话直接写入 MySQL，不需要 Git pull。

代码更新流程：

```text
本地修改和测试
→ Git commit
→ Git push
→ 服务器 git pull
→ pnpm install
→ pnpm db:migrate
→ pnpm build
→ 重启新 Node 环境
→ /healthz 验证
```

服务器示例：

```bash
git -C /cycq-frontmind-agent status --short --branch
git -C /cycq-frontmind-agent pull --ff-only origin main

docker exec CYCQ-FrontMind-Agent sh -lc \
  'cd /app && pnpm install --frozen-lockfile'

docker exec CYCQ-FrontMind-Agent sh -lc \
  'cd /app && pnpm db:migrate'

docker exec CYCQ-FrontMind-Agent sh -lc \
  'cd /app && pnpm build'
```

然后只重启 `CYCQ-FrontMind-Agent`，不要重启 `FrontMind-Agent`。

---

## 23. 上线完成标准

- [ ] 新 Node 运行环境稳定运行。
- [ ] `/healthz` 返回 `{"status":"ok"}`。
- [ ] 新数据库迁移成功并包含 10 张表。
- [ ] 应用管理员创建成功。
- [ ] 普通用户可以登录。
- [ ] API Key 测试连接正常。
- [ ] 同一账号可以跨设备同步会话。
- [ ] 不同用户之间数据隔离。
- [ ] 公网端口或 HTTPS 域名可以访问。
- [ ] 原 FrontMind 应用和数据库未受影响。
- [ ] 数据库密码、加密密钥和管理员密码没有出现在对话或日志中。

本教程不配置定时清理任务和自动备份任务。
