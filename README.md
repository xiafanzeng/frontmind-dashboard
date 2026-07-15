# FrontMind Client

FrontMind Client 是一个面向内容生产工作流的现代 Web 应用，用于通过兼容式智能体 API 完成对话、文件上传、文件预览与结果下载。当前交付版本已加入统一品牌替换机制，面向用户展示的对话文本、文件名、文件预览标题、下载文件名以及可处理文件内容会从原始品牌词替换为 **FrontMind**。

## Features

- **Modern Chat Interface**: 玻璃拟态风格界面与平滑动效。
- **File Upload**: 支持图片与文档上传。
- **Markdown Rendering**: 支持 Markdown、代码块与语法高亮。
- **Image Preview**: 支持图片全屏预览、缩放与旋转。
- **File Preview and Download Sanitization**: 文件预览、代理下载、文本类文件、PDF 与 Office Open XML 文件会经过品牌替换处理。
- **Real-time Updates**: 任务状态轮询与重试逻辑。
- **Account Sync**: 内部账号登录、跨设备会话同步与管理员账号管理。
- **Server-side Credentials**: 每个账号的 API Key 经验证后使用 AES-256-GCM 加密保存，浏览器不再长期保存或随请求发送明文 Key。
- **Mobile Responsive**: 支持不同屏幕尺寸。
- **Keyboard Shortcuts**: 支持常用快捷键。

## Brand Replacement Scope

本版本在前端与服务端都增加了品牌替换层。前端会在消息内容、附件名称、文件预览标题、下载名称以及内联图片替代文本中调用统一替换函数；服务端会在 JSON 响应、外部文件代理下载、同源文件下载、响应头文件名以及可处理文件内容中执行替换。

| 位置 | 当前处理方式 | 说明 |
|---|---|---|
| 聊天消息文本 | 前端与服务端双层替换 | API 返回中的品牌词会在进入 UI 前替换。 |
| 附件和生成文件名称 | 前端显示名替换，下载响应头替换 | 用户看到的文件名和下载保存名会显示 FrontMind。 |
| Markdown、HTML、纯文本、CSV、JSON 等文本文件 | 服务端代理下载时替换正文 | 文件预览与下载不再绕过替换层。 |
| PDF 文件 | 服务端尝试文本流替换与覆盖处理 | 对标准文本型 PDF 有效；扫描图像型 PDF 需要 OCR/重制才能完全替换。 |
| DOCX、PPTX、XLSX 等 Office Open XML 文件 | 服务端替换压缩包内 XML 文本 | 对普通 Office 文档有效。 |
| 底层兼容路径和第三方依赖名 | 保留必要内部标识 | 例如调试插件、兼容 API 路由、依赖包名可能仍含底层标识，但不作为用户界面内容展示。 |

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Radix UI
- **Backend**: Express, tRPC, Drizzle ORM, MySQL 8
- **Styling**: Custom CSS with oklch colors, Framer Motion animations
- **Build**: Vite 7

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 8+
- MySQL 8+

### Installation

```bash
pnpm install
cp .env.example .env
```

编辑 `.env`，至少设置 `DATABASE_URL` 和 `FRONTMIND_CREDENTIAL_ENCRYPTION_KEY`。加密主密钥必须长期保持不变；更换或丢失会导致已保存的 API Key 无法解密。

```bash
pnpm db:migrate
pnpm admin:init
pnpm dev
```

开发服务启动后，请以控制台输出的本地地址为准。默认情况下，服务会由项目内 Express/Vite 集成入口提供。

### Configuration

1. 使用 `pnpm admin:init` 创建首个管理员；密码通过隐藏输入读取，不写入命令行历史。
2. 管理员登录后可在“账号管理”中创建、停用账号或重置密码。
3. 每个账号首次进入“API Key 设置”时填写自己的 Key。服务端验证后加密入库，后续设备只需登录。
4. 旧版本浏览器中的本地 Key 与会话不会导入账号；登录后只读取该账号的云端数据。

同一个 API Key 可以由多个 FrontMind 账号共同使用。账号之间的会话和文件权限仍然隔离，但这些账号共享该 Key 对应的上游额度，积分统计会反映该 Key 的整体使用量。

### Database Commands

```bash
# 根据 schema 生成迁移（开发时）
pnpm db:generate

# 只执行仓库内已有迁移（部署时）
pnpm db:migrate

# 永久清理超过 30 天未更新的会话（供 1Panel 计划任务调用）
pnpm db:cleanup-expired
```

不要在发布服务器上用 schema push 替代版本化迁移。数据库备份、1Panel 应用配置、反向代理和正式发布属于部署阶段，需在检查目标面板后单独执行。

用户主动删除会话时，服务端会立即物理删除该会话，并由外键级联删除消息、附件和对话轮次。`db:cleanup-expired` 按会话最后更新时间执行 30 天滚动保留；超过 30 天未更新的会话及其关联记录将无法恢复。

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + N` | New conversation |
| `Cmd/Ctrl + Enter` | Send message |
| `Esc` | Stop current operation |
| `Cmd/Ctrl + ,` | Open settings |

## Project Structure

```text
frontmind-client/
├── client/                 # Frontend React application
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── contexts/       # React Context providers
│   │   ├── hooks/          # Custom React hooks
│   │   ├── lib/            # Utilities and API client
│   │   └── pages/          # Page components
├── server/                 # Backend Express server
├── drizzle/                # MySQL schema and versioned migrations
├── scripts/                # Operational CLI (initial administrator)
├── shared/                 # Shared types and constants
└── package.json            # Root package.json
```

## Development

### Build for Production

```bash
pnpm build
pnpm db:migrate
pnpm start
```

生产进程固定监听 `PORT`（默认 `3001`），`GET /healthz` 会同时检查数据库连接。生产启动时若缺少数据库地址或凭据加密主密钥会直接失败，避免以不完整配置对外服务。

### Run Tests

```bash
pnpm test
```

### Type Checking

```bash
pnpm check
```

## Notes

如果在源代码扫描、依赖包名、调试插件目录或临时预览域名中仍看到底层标识，这通常属于兼容层、第三方依赖或沙盒预览基础设施，并不是应用返回给最终用户的内容。最终用户可见文本、API JSON 响应以及通过文件代理返回的可处理文件内容已接入 FrontMind 替换机制。

## License

MIT
