import path from "node:path";

export function decodeKnowledgeArchiveHeader(
  value: string | undefined,
  fallback: string,
) {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value).slice(0, 512);
  } catch {
    return value.slice(0, 512);
  }
}

export function parseDashboardRevisionHeader(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("看板版本号无效，请刷新后重试");
  }
  return Number(value);
}

export function safeKnowledgeArchivePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 512);
}

export function validateKnowledgeArchiveEntryPath(value: string) {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value)
  ) {
    throw new Error("知识库 ZIP 包含不安全的文件路径");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("知识库 ZIP 包含不安全的文件路径");
  }
  const normalized = parts.join("/");
  if (normalized.length > 512) {
    throw new Error("知识库 ZIP 中的文件路径过长");
  }
  return normalized;
}

export function knowledgeArchiveTitleFromPath(filePath: string) {
  return (
    path
      .basename(filePath, path.extname(filePath))
      .replace(/^\d+[._-]*/, "")
      .replace(/[-_]+/g, " ")
      .trim() || "知识文档"
  );
}

function htmlToMarkdownLikeText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeKnowledgeArchiveTextDocument(
  filePath: string,
  content: string,
) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    return htmlToMarkdownLikeText(content);
  }
  if (extension === ".json") {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(content), null, 2)}\n\`\`\``;
    } catch {
      return content;
    }
  }
  return content.replace(/^\uFEFF/, "").trim();
}
