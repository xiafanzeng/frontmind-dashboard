import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import JSZip, { type JSZipObject } from "jszip";
import { z } from "zod";

import { fetchPinnedPublicHttps } from "./remote-preview";

export const FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME =
  "frontmind-site-source-v1.zip";
export const FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME =
  "frontmind-site-source-receipt-v1.json";
export const FRONTMIND_SITE_SOURCE_ARCHIVE_MIME = "application/zip";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const siteSourceReceiptV1Schema = z
  .object({
    operationToken: z.string().min(1).max(256),
    baseSourceSha256: z.string().regex(SHA256_PATTERN),
    archiveSha256: z.string().regex(SHA256_PATTERN),
    fileCount: z.number().int().min(1).max(512),
  })
  .strict();

export type SiteSourceReceiptV1 = z.infer<typeof siteSourceReceiptV1Schema>;

/**
 * This is an instruction boundary, not a byte/pixel comparison gate. The
 * returned archive still has to pass the local archive, dependency, execution
 * and network safety checks below before it can be compiled.
 */
export const TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT = `你是企业官网内容替换与信息架构执行者，不是视觉设计师。

附件中的 21st React 项目是唯一源码基线。你必须返回一份完整、可独立构建的源码 ZIP，不得返回 diff、代码围栏、解释或摘要。

绝对禁止重新设计。不得主动修改：
- CSS、SCSS、Tailwind 配置和设计 Token
- className、style 属性、颜色、字体、间距、圆角、阴影和边框
- SVG 几何结构、图形构图和装饰
- 动画、transition、响应式断点
- 已保留区块的组件层级、排列和视觉结构
- import、依赖、构建配置和文件组织

只允许：
- 使用知识库事实替换用户可见文案
- 替换为已提供且经过验证的企业媒体
- 调整路由、导航和页面数据
- 删除知识库没有依据的可选页面或完整可选区块
- 复用原有页面外壳和组件创建知识库确实需要的子页面

保留页面中所有原生样式、组件与交互。删除页面或区块时必须同步删除对应导航入口，不得破坏其余页面。

任何企业事实都必须来自给定 sourceId。禁止编造价格、客户、案例、评价、新闻、资质、联系人或产品能力。

没有公开价格时：
- 若价格页属于可选页面，删除该页面和导航入口；
- 若原模板必须保留该区块，保持原卡片和布局，只将内容改为“联系咨询”或“获取方案”。

没有新闻或案例时：
- 可选页面直接移除；
- SiteBrief 明确要求保留时，使用原有组件展示可信空状态。

文案长度必须适配原有内容空间；优先摘要，不得通过修改字号、间距或布局容纳长文。

不得添加外部脚本、远程请求、HTML 注入、未知依赖或未提供的媒体。
package.json 中的依赖版本必须保留为附件运行清单所使用的精确版本号，不得改成范围、标签或其他版本。

最终只返回 ${FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME} 和 ${FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME}。`;

export type NativeSourceLimits = {
  maxArchiveBytes: number;
  maxFiles: number;
  maxSingleFileBytes: number;
  maxExpandedBytes: number;
  maxPathBytes: number;
  maxPathDepth: number;
};

export const NATIVE_SOURCE_DEFAULT_LIMITS: Readonly<NativeSourceLimits> =
  Object.freeze({
    maxArchiveBytes: 24 * 1024 * 1024,
    maxFiles: 512,
    maxSingleFileBytes: 8 * 1024 * 1024,
    maxExpandedBytes: 48 * 1024 * 1024,
    maxPathBytes: 240,
    maxPathDepth: 16,
  });

export const NATIVE_SOURCE_ALLOWED_DEPENDENCIES = Object.freeze([
  "@base-ui/react",
  "@devnomic/marquee",
  "@dnd-kit/core",
  "@dnd-kit/modifiers",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "@hookform/resolvers",
  "@number-flow/react",
  "@radix-ui/react-accordion",
  "@radix-ui/react-alert-dialog",
  "@radix-ui/react-aspect-ratio",
  "@radix-ui/react-avatar",
  "@radix-ui/react-checkbox",
  "@radix-ui/react-collapsible",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-icons",
  "@radix-ui/react-label",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-progress",
  "@radix-ui/react-radio-group",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slider",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-toggle",
  "@radix-ui/react-toggle-group",
  "@radix-ui/react-toast",
  "@radix-ui/react-tooltip",
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "@tanstack/react-table",
  "class-variance-authority",
  "clsx",
  "cmdk",
  "date-fns",
  "embla-carousel-react",
  "framer-motion",
  "gsap",
  "hls.js",
  "input-otp",
  "lucide-react",
  "motion",
  "next-themes",
  "react",
  "react-day-picker",
  "react-dom",
  "react-hook-form",
  "react-markdown",
  "react-resizable-panels",
  "react-router-dom",
  "recharts",
  "shaders",
  "sonner",
  "tailwind-merge",
  "tailwindcss",
  "tailwindcss-animate",
  "tw-animate-css",
  "vaul",
  "vite",
  "wouter",
  "zod",
  "zustand",
] as const);

/** Host-owned, data-only Tailwind v3 coordinates. Templates cannot import or
 * declare this as a package; the controlled compiler consumes the JSON. */
export const NATIVE_SOURCE_TAILWIND_V3_CONFIG_PATH =
  "frontmind-tailwind-v3.json" as const;

export type NativeReactSourceErrorCode =
  | "NATIVE_SOURCE_ARCHIVE_INVALID"
  | "NATIVE_SOURCE_ARCHIVE_HASH_MISMATCH"
  | "NATIVE_SOURCE_TOKEN_MISMATCH"
  | "NATIVE_SOURCE_BASE_HASH_MISMATCH"
  | "NATIVE_SOURCE_PATH_INVALID"
  | "NATIVE_SOURCE_PATH_COLLISION"
  | "NATIVE_SOURCE_SYMLINK_FORBIDDEN"
  | "NATIVE_SOURCE_LIMIT_EXCEEDED"
  | "NATIVE_SOURCE_TEXT_INVALID"
  | "NATIVE_SOURCE_SECRET_FORBIDDEN"
  | "NATIVE_SOURCE_DYNAMIC_EXECUTION_FORBIDDEN"
  | "NATIVE_SOURCE_SERVER_API_FORBIDDEN"
  | "NATIVE_SOURCE_NETWORK_FORBIDDEN"
  | "NATIVE_SOURCE_HTML_INJECTION_FORBIDDEN"
  | "NATIVE_SOURCE_STYLE_EXECUTION_FORBIDDEN"
  | "NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN"
  | "NATIVE_SOURCE_DEPENDENCY_FORBIDDEN"
  | "NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH"
  | "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN"
  | "NATIVE_SOURCE_ENTRYPOINT_INVALID"
  | "NATIVE_SOURCE_RECEIPT_INVALID"
  | "NATIVE_SOURCE_ATTACHMENT_INVALID"
  | "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE";

export class NativeReactSourceError extends Error {
  constructor(readonly code: NativeReactSourceErrorCode) {
    super(code);
    this.name = "NativeReactSourceError";
  }
}

export type ValidatedNativeReactSource = {
  receipt: SiteSourceReceiptV1;
  archiveSha256: string;
  sourceSha256: string;
  sourceZip: Buffer;
  fileCount: number;
  htmlEntrypoint: "index.html";
  entrypoint: string;
  packageJson: Readonly<Record<string, unknown>>;
  files: ReadonlyMap<string, Buffer>;
};

type ZipMetadata = {
  uncompressedSize?: number;
};

type UnsafeZipObject = JSZipObject & {
  unsafeOriginalName?: string;
  _data?: ZipMetadata;
};

const TEXT_FILE_PATTERN =
  /(?:^|\/)(?:[^/]+\.(?:cjs|css|html|js|jsx|json|less|md|mdx|mjs|sass|scss|svg|toml|ts|tsx|txt|xml|ya?ml)|Dockerfile|Makefile|LICENSE|NOTICE)$/iu;
const LOCK_FILE_PATTERN =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u;
const ALLOWED_BINARY_FILE_PATTERN =
  /\.(?:avif|eot|gif|ico|jpe?g|mp3|mp4|ogg|otf|png|ttf|wav|webm|webp|woff2?)$/iu;
const SOURCE_CODE_PATTERN = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/iu;
const BUILD_CONFIG_PATTERN =
  /(?:^|\/)(?:vite|tailwind|postcss)\.config\.(?:cjs|js|mjs|ts)$/u;

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function secureStringEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function effectiveLimits(
  requested: Partial<NativeSourceLimits> | undefined,
): NativeSourceLimits {
  const bounded = (key: keyof NativeSourceLimits) => {
    const requestedValue = requested?.[key];
    if (!Number.isSafeInteger(requestedValue) || Number(requestedValue) < 1) {
      return NATIVE_SOURCE_DEFAULT_LIMITS[key];
    }
    return Math.min(Number(requestedValue), NATIVE_SOURCE_DEFAULT_LIMITS[key]);
  };
  return {
    maxArchiveBytes: bounded("maxArchiveBytes"),
    maxFiles: bounded("maxFiles"),
    maxSingleFileBytes: bounded("maxSingleFileBytes"),
    maxExpandedBytes: bounded("maxExpandedBytes"),
    maxPathBytes: bounded("maxPathBytes"),
    maxPathDepth: bounded("maxPathDepth"),
  };
}

function zipMode(entry: JSZipObject) {
  const value = entry.unixPermissions;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[0-7]+$/u.test(value)) {
    return Number.parseInt(value, 8);
  }
  return 0;
}

function assertSafeArchivePath(
  entry: UnsafeZipObject,
  limits: NativeSourceLimits,
) {
  const rawName = entry.unsafeOriginalName ?? entry.name;
  const normalized = rawName.normalize("NFKC");
  const withoutTrailingSlash = normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  const parts = withoutTrailingSlash.split("/");
  if (
    rawName !== normalized ||
    withoutTrailingSlash.length < 1 ||
    normalized.startsWith("/") ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.includes("//") ||
    parts.some((part) => part === "." || part === ".." || part.length < 1) ||
    Buffer.byteLength(normalized, "utf8") > limits.maxPathBytes ||
    parts.length > limits.maxPathDepth ||
    parts.some((part) => Buffer.byteLength(part, "utf8") > 100)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_PATH_INVALID");
  }
  const mode = zipMode(entry);
  if (mode && (mode & 0o170000) === 0o120000) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SYMLINK_FORBIDDEN");
  }
  return withoutTrailingSlash;
}

function commonArchiveRoot(paths: readonly string[]) {
  if (paths.length < 1) return null;
  const first = paths[0]!.split("/");
  if (first.length < 2) return null;
  const root = first[0]!;
  return paths.every((path) => path.startsWith(`${root}/`)) ? root : null;
}

function decodeUtf8(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new NativeReactSourceError("NATIVE_SOURCE_TEXT_INVALID");
  }
}

function dependencyAllowed(name: string, allowed: ReadonlySet<string>) {
  return allowed.has(name);
}

const installedDependencyVersions = new Map<string, string>();

export function installedNativeSourceDependencyVersion(name: string) {
  const cached = installedDependencyVersions.get(name);
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  try {
    let directory = path.dirname(require.resolve(name));
    for (let depth = 0; depth < 16; depth += 1) {
      const manifestPath = path.join(directory, "package.json");
      try {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as Record<string, unknown>;
        if (
          manifest.name === name &&
          typeof manifest.version === "string" &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
        ) {
          installedDependencyVersions.set(name, manifest.version);
          return manifest.version;
        }
      } catch {
        // Continue to the package root that owns the resolved entry.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // CSS-only packages may intentionally expose only the `style` condition,
    // so CommonJS resolution has no entrypoint. Resolve their package root
    // from Node's deterministic module search paths without bypassing the
    // closed dependency allowlist.
    for (const searchRoot of require.resolve.paths(name) ?? []) {
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(searchRoot, name, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        if (
          manifest.name === name &&
          typeof manifest.version === "string" &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
        ) {
          installedDependencyVersions.set(name, manifest.version);
          return manifest.version;
        }
      } catch {
        // Continue through the fixed Node module resolution roots.
      }
    }
  }
  throw new NativeReactSourceError("NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH");
}

function assertPackageSafe(
  files: ReadonlyMap<string, Buffer>,
  allowedDependencies: ReadonlySet<string>,
) {
  const bytes = files.get("package.json");
  if (!bytes) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ENTRYPOINT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof NativeReactSourceError) throw error;
    throw new NativeReactSourceError("NATIVE_SOURCE_ARCHIVE_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ARCHIVE_INVALID");
  }
  const manifest = value as Record<string, unknown>;
  const scripts = manifest.scripts;
  if (scripts !== undefined) {
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      throw new NativeReactSourceError("NATIVE_SOURCE_ARCHIVE_INVALID");
    }
    const lifecycle = new Set([
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepublish",
      "prepublishOnly",
      "publish",
      "postpublish",
    ]);
    for (const [name, command] of Object.entries(
      scripts as Record<string, unknown>,
    )) {
      if (lifecycle.has(name)) {
        throw new NativeReactSourceError(
          "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN",
        );
      }
      if (
        typeof command !== "string" ||
        /(?:^|[\s;&|])(?:bash|curl|node\s+-e|npm|npx|pnpm|powershell|rm|sh|wget)(?:[\s;&|]|$)/iu.test(
          command,
        )
      ) {
        throw new NativeReactSourceError(
          "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN",
        );
      }
    }
  }
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const dependencies = manifest[key];
    if (dependencies === undefined) continue;
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_DEPENDENCY_FORBIDDEN");
    }
    for (const [name, version] of Object.entries(
      dependencies as Record<string, unknown>,
    )) {
      if (
        !dependencyAllowed(name, allowedDependencies) ||
        typeof version !== "string" ||
        version.length > 96 ||
        /^(?:file|git(?:\+[^:]*)?|github|https?|link|workspace):/iu.test(
          version,
        )
      ) {
        throw new NativeReactSourceError("NATIVE_SOURCE_DEPENDENCY_FORBIDDEN");
      }
      if (version !== installedNativeSourceDependencyVersion(name)) {
        throw new NativeReactSourceError(
          "NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH",
        );
      }
    }
  }
  return Object.freeze(manifest);
}

function assertNoSecrets(text: string, operationToken: string) {
  const patterns = [
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /\bLTAI[A-Za-z0-9]{12,}\b/u,
    /\bsk-(?:live|proj)?-?[A-Za-z0-9_-]{20,}\b/u,
    /(?:access[_-]?key[_-]?secret|api[_-]?key|app[_-]?secret|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/iu,
  ];
  if (
    text.includes(operationToken) ||
    patterns.some((pattern) => pattern.test(text))
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SECRET_FORBIDDEN");
  }
}

function assertNoOperationTokenBytes(bytes: Buffer, operationToken: string) {
  if (bytes.indexOf(Buffer.from(operationToken, "utf8")) >= 0) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SECRET_FORBIDDEN");
  }
}

const SAFE_SOURCE_ABSOLUTE_URLS = new Set([
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/2001/XMLSchema-instance",
  "http://www.w3.org/XML/1998/namespace",
]);

function withoutSourceComments(text: string) {
  let output = "";
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]!;
    const next = text[index + 1] ?? "";
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < text.length && !/[\r\n]/u.test(text[index]!)) {
        output += " ";
        index += 1;
      }
      if (index < text.length) output += text[index];
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        output += /[\r\n]/u.test(text[index]!) ? text[index] : " ";
        index += 1;
      }
      if (index < text.length) {
        output += "  ";
        index += 1;
      }
      continue;
    }
    output += current;
  }
  return output;
}

function assertNoExternalUrlLiterals(text: string) {
  const inspected = withoutSourceComments(text);
  const absoluteUrls = inspected.match(/https?:\/\/[^\s"'`<>{}\\]+/giu) ?? [];
  if (
    absoluteUrls.some((url) => !SAFE_SOURCE_ABSOLUTE_URLS.has(url)) ||
    /["'`]\/\/[A-Za-z0-9\[]/u.test(inspected)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
}

function assertSourceCodeSafe(path: string, text: string) {
  if (
    /\beval\s*\(/u.test(text) ||
    /\bnew\s+Function\s*\(/u.test(text) ||
    /\bimport\s*\(/u.test(text) ||
    /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/u.test(text)
  ) {
    throw new NativeReactSourceError(
      "NATIVE_SOURCE_DYNAMIC_EXECUTION_FORBIDDEN",
    );
  }
  const allowsBuildPath = BUILD_CONFIG_PATTERN.test(path);
  if (
    /(?:from\s*|require\s*\(\s*)["'](?:node:)?(?:child_process|cluster|dgram|dns|fs|http|https|module|net|os|tls|vm|worker_threads)(?:\/[^"']*)?["']/u.test(
      text,
    ) ||
    (!allowsBuildPath &&
      /(?:from\s*|require\s*\(\s*)["'](?:node:)?(?:buffer|crypto|path|process|stream|url|util)(?:\/[^"']*)?["']/u.test(
        text,
      )) ||
    /\bprocess\s*\.\s*(?:env|binding|dlopen)\b/u.test(text)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SERVER_API_FORBIDDEN");
  }
  if (
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u.test(text) ||
    /\bnavigator\s*\.\s*sendBeacon\s*\(/u.test(text) ||
    /\baxios\s*\./u.test(text) ||
    /(?:from\s*|require\s*\(\s*)["']https?:\/\//iu.test(text) ||
    /\b(?:src|poster)\s*=\s*[{"'`]*\s*["'`]https?:\/\//iu.test(text) ||
    /<iframe\b/iu.test(text)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
  if (
    /\bdangerouslySetInnerHTML\b/u.test(text) ||
    /\.\s*(?:innerHTML|outerHTML)\s*=/u.test(text) ||
    /\binsertAdjacentHTML\s*\(/u.test(text) ||
    /\bdocument\s*\.\s*write(?:ln)?\s*\(/u.test(text)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_HTML_INJECTION_FORBIDDEN");
  }
  if (/\b(?:javascript|vbscript):|data:text\/html/iu.test(text)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
}

function importedStylePath(rawClause: string) {
  const clause = rawClause.trim();
  const quoted = /^(?:"([^"]+)"|'([^']+)')$/u.exec(clause);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  const url = /^url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s"')]+))\s*\)$/iu.exec(
    clause,
  );
  return url?.[1] ?? url?.[2] ?? url?.[3] ?? null;
}

function assertStyleImportsSafe(
  sourcePath: string,
  text: string,
  files: ReadonlyMap<string, Buffer>,
) {
  if (/@(?:plugin|config)\b/iu.test(text)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_EXECUTION_FORBIDDEN");
  }
  const importTokens = [...text.matchAll(/@import\b/giu)];
  const imports = [...text.matchAll(/@import\b([^;]*);/giu)];
  if (imports.length !== importTokens.length) {
    throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
  }
  for (const match of imports) {
    const specifier = importedStylePath(match[1] ?? "");
    if (!specifier) {
      throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
    }
    if (specifier === "tailwindcss" || specifier === "tw-animate-css") continue;
    if (
      !specifier.startsWith("./") ||
      specifier.includes("\\") ||
      specifier.includes("\0") ||
      specifier.includes("?") ||
      specifier.includes("#") ||
      specifier.split("/").some((part) => part === "..") ||
      !specifier.endsWith(".css")
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
    }
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourcePath), specifier),
    );
    if (
      resolved.startsWith("../") ||
      path.posix.isAbsolute(resolved) ||
      !files.has(resolved)
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
    }
  }
}

function assertMarkupAndStyleSafe(
  sourcePath: string,
  text: string,
  files: ReadonlyMap<string, Buffer>,
) {
  if (/\b(?:javascript|vbscript):|data:text\/html/iu.test(text)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
  if (/\.(?:html?|svg)$/iu.test(sourcePath)) {
    if (
      /<iframe\b/iu.test(text) ||
      /<(?:image|script|use)\b[^>]*(?:href|src|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//iu.test(
        text,
      ) ||
      /<(?:audio|img|source|video)\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//iu.test(
        text,
      )
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
    }
  }
  if (/\.(?:css|less|sass|scss)$/iu.test(sourcePath)) {
    assertStyleImportsSafe(sourcePath, text, files);
    if (/url\s*\(\s*["']?\s*(?:file:|(?:https?:)?\/\/)/iu.test(text)) {
      throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
    }
  }
}

function findEntrypoint(files: ReadonlyMap<string, Buffer>) {
  const indexBytes = files.get("index.html");
  if (!indexBytes) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ENTRYPOINT_INVALID");
  }
  const html = decodeUtf8(indexBytes);
  const moduleSource =
    /<script\b(?=[^>]*\btype\s*=\s*["']module["'])[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/iu.exec(
      html,
    )?.[1] ?? null;
  const candidates = moduleSource
    ? [moduleSource]
    : ["/src/main.tsx", "/src/main.jsx", "/src/main.ts", "/src/main.js"];
  for (const candidate of candidates) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate) || candidate.includes("\\")) {
      continue;
    }
    const path = candidate
      .split(/[?#]/u, 1)[0]!
      .replace(/^\.\//u, "")
      .replace(/^\//u, "");
    if (
      path.length > 0 &&
      !path.split("/").some((part) => part === "." || part === "..") &&
      files.has(path)
    ) {
      return path;
    }
  }
  throw new NativeReactSourceError("NATIVE_SOURCE_ENTRYPOINT_INVALID");
}

export async function validateNativeReactSourceArchive(input: {
  archive: Buffer;
  receipt: unknown;
  expectedOperationToken: string;
  expectedBaseSourceSha256: string;
  limits?: Partial<NativeSourceLimits>;
  allowedDependencies?: readonly string[];
}): Promise<ValidatedNativeReactSource> {
  const limits = effectiveLimits(input.limits);
  if (
    input.archive.length < 1 ||
    input.archive.length > limits.maxArchiveBytes
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
  }
  const parsedReceipt = siteSourceReceiptV1Schema.safeParse(input.receipt);
  if (!parsedReceipt.success) {
    throw new NativeReactSourceError("NATIVE_SOURCE_RECEIPT_INVALID");
  }
  const receipt = parsedReceipt.data;
  if (
    !secureStringEqual(receipt.operationToken, input.expectedOperationToken)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_TOKEN_MISMATCH");
  }
  if (
    !SHA256_PATTERN.test(input.expectedBaseSourceSha256) ||
    !secureStringEqual(receipt.baseSourceSha256, input.expectedBaseSourceSha256)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_BASE_HASH_MISMATCH");
  }
  const archiveSha256 = sha256(input.archive);
  if (!secureStringEqual(receipt.archiveSha256, archiveSha256)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ARCHIVE_HASH_MISMATCH");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(input.archive, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch {
    throw new NativeReactSourceError("NATIVE_SOURCE_ARCHIVE_INVALID");
  }
  const entries = Object.values(archive.files) as UnsafeZipObject[];
  const filesOnly = entries.filter((entry) => !entry.dir);
  if (
    filesOnly.length < 1 ||
    filesOnly.length > limits.maxFiles ||
    filesOnly.length !== receipt.fileCount
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
  }
  const rawFilePaths: string[] = [];
  const entryByRawPath = new Map<string, UnsafeZipObject>();
  const collisionKeys = new Set<string>();
  for (const entry of entries) {
    const safePath = assertSafeArchivePath(entry, limits);
    const collisionKey = safePath.toLocaleLowerCase("en-US");
    if (collisionKeys.has(collisionKey)) {
      throw new NativeReactSourceError("NATIVE_SOURCE_PATH_COLLISION");
    }
    collisionKeys.add(collisionKey);
    if (entry.dir) continue;
    const declaredSize = Number(entry._data?.uncompressedSize ?? 0);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > limits.maxSingleFileBytes
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
    }
    rawFilePaths.push(safePath);
    entryByRawPath.set(safePath, entry);
  }
  const wrapper = commonArchiveRoot(rawFilePaths);
  const files = new Map<string, Buffer>();
  let expandedBytes = 0;
  for (const rawPath of rawFilePaths.sort()) {
    const normalizedPath = wrapper
      ? rawPath.slice(wrapper.length + 1)
      : rawPath;
    if (
      !normalizedPath ||
      files.has(normalizedPath.toLocaleLowerCase("en-US"))
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_PATH_COLLISION");
    }
    if (
      !TEXT_FILE_PATTERN.test(normalizedPath) &&
      !LOCK_FILE_PATTERN.test(normalizedPath) &&
      !ALLOWED_BINARY_FILE_PATTERN.test(normalizedPath)
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_ARCHIVE_INVALID");
    }
    const bytes = await entryByRawPath.get(rawPath)!.async("nodebuffer");
    expandedBytes += bytes.length;
    if (
      bytes.length > limits.maxSingleFileBytes ||
      expandedBytes > limits.maxExpandedBytes
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
    }
    files.set(normalizedPath, bytes);
  }
  const allowedDependencies = new Set(
    input.allowedDependencies ?? NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
  );
  const packageJson = assertPackageSafe(files, allowedDependencies);
  for (const [path, bytes] of files) {
    assertNoOperationTokenBytes(bytes, input.expectedOperationToken);
    if (!TEXT_FILE_PATTERN.test(path) && !LOCK_FILE_PATTERN.test(path))
      continue;
    const text = decodeUtf8(bytes);
    assertNoSecrets(text, input.expectedOperationToken);
    if (!LOCK_FILE_PATTERN.test(path)) {
      assertMarkupAndStyleSafe(path, text, files);
      assertNoExternalUrlLiterals(text);
    }
    if (SOURCE_CODE_PATTERN.test(path)) {
      assertSourceCodeSafe(path, text);
    }
  }
  const entrypoint = findEntrypoint(files);
  return {
    receipt,
    archiveSha256,
    sourceSha256: archiveSha256,
    sourceZip: Buffer.from(input.archive),
    fileCount: files.size,
    htmlEntrypoint: "index.html",
    entrypoint,
    packageJson,
    files,
  };
}

type FetchPinned = typeof fetchPinnedPublicHttps;

function boundedDataUrl(url: string, maxBytes: number) {
  const prefix = `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,`;
  if (!url.startsWith(prefix)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const encoded = url.slice(prefix.length);
  if (
    encoded.length < 4 ||
    encoded.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const body = Buffer.from(encoded, "base64");
  if (
    body.length < 1 ||
    body.length > maxBytes ||
    body.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  return body;
}

async function readBoundedResponseBody(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE");
  }
  const contentType = response.headers.get("content-type");
  if (contentType !== FRONTMIND_SITE_SOURCE_ARCHIVE_MIME) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const declaredHeader = response.headers.get("content-length");
  const declared =
    declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared < 1 || declared > maxBytes)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteCount = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      byteCount += next.value.byteLength;
      if (byteCount > maxBytes) {
        throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (byteCount < 1) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  return Buffer.concat(chunks, byteCount);
}

export async function readNativeSourceAttachment(input: {
  attachment: {
    filename: string;
    contentType: string;
    url: string;
  };
  signal?: AbortSignal;
  fetchPinned?: FetchPinned;
  maxBytes?: number;
}) {
  if (
    input.attachment.filename !== FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME ||
    input.attachment.contentType !== FRONTMIND_SITE_SOURCE_ARCHIVE_MIME
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const requestedMaxBytes = input.maxBytes;
  const maxBytes =
    requestedMaxBytes === undefined
      ? NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes
      : Number.isSafeInteger(requestedMaxBytes) && requestedMaxBytes > 0
        ? Math.min(
            requestedMaxBytes,
            NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes,
          )
        : 0;
  if (maxBytes < 1) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  if (input.attachment.url.startsWith("data:")) {
    return boundedDataUrl(input.attachment.url, maxBytes);
  }
  let parsed: URL;
  try {
    parsed = new URL(input.attachment.url);
  } catch {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const fetched = await (input.fetchPinned ?? fetchPinnedPublicHttps)({
      url: parsed,
      signal: controller.signal,
      maxRedirects: 2,
      allowedOrigin: parsed.origin,
      headers: { Accept: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME },
    });
    return await readBoundedResponseBody(fetched.response, maxBytes);
  } catch (error) {
    if (error instanceof NativeReactSourceError) throw error;
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
