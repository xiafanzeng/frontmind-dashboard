import { createHash } from "node:crypto";

import {
  containsPrivateProviderBrand,
  sanitizeFrontMindPublicText,
} from "../shared/frontmind-public-brand";

type PublicJson = null | boolean | number | string | PublicJson[] | {
  [key: string]: PublicJson;
};

function publicSupportId(value: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.key ?? null,
        value.code ?? null,
        value.turnId ?? null,
        value.createdAt ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
}

function publicNotice(value: Record<string, unknown>): Record<string, unknown> {
  const supportId = publicSupportId(value);
  const action = String(value.recoveryAction || "");
  const terminal =
    action === "stopped" ||
    action === "contact_support" ||
    value.failureClass === "terminal_nonregenerable";
  const reselect = [
    "fix_attachments",
    "reupload_logo",
    "reselect_start_sources",
  ].includes(action);
  const newGeneration = [
    "start_new_generation",
    "create_new_canonical_from_snapshot",
    "regenerate_turn",
  ].includes(action);
  const explicitRecovery =
    action === "retry_request" || action === "start_new_generation";
  const code = terminal
    ? "FRONTMIND_KB_STOPPED"
    : reselect
      ? "FRONTMIND_KB_RESELECT_FILES"
      : newGeneration
        ? "FRONTMIND_KB_NEW_GENERATION_REQUIRED"
        : "FRONTMIND_KB_RETRY_AVAILABLE";
  const message = terminal
    ? "本轮已停止，不会自动重发。已完成内容不受影响。"
    : reselect
      ? "需要重新选择所需文件后继续。已完成内容不受影响。"
      : explicitRecovery
        ? "需要你确认后继续。已完成内容不受影响。"
        : newGeneration
          ? "需要你确认后创建一个新的 FrontMind 任务继续。已完成内容不受影响。"
          : "FrontMind 正在核对当前操作；如需继续，系统会显示明确操作。已完成内容不受影响。";
  return {
    key: `frontmind-kb:${supportId}`,
    code,
    severity: value.severity ?? "warning",
    message,
    retryable: value.retryable === true,
    failureClass: value.failureClass ?? null,
    recoveryAction: value.recoveryAction ?? null,
    recoveryToken: value.recoveryToken ?? null,
    canRegenerate: value.canRegenerate === true,
    traceId: supportId,
    attachmentCount: value.attachmentCount ?? null,
    turnId: null,
    createdAt: value.createdAt ?? null,
  };
}

function project(value: unknown, key = ""): PublicJson {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeFrontMindPublicText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => project(item));
  if (typeof value !== "object") return sanitizeFrontMindPublicText(value);

  const source = value as Record<string, unknown>;
  const normalized = key === "notice" ? publicNotice(source) : source;
  const result: Record<string, PublicJson> = {};
  for (const [entryKey, entryValue] of Object.entries(normalized)) {
    if (entryKey === "protocolError" || entryKey === "canonicalTaskUrl") {
      result[entryKey] = null;
      continue;
    }
    if (entryKey === "code") {
      if (containsPrivateProviderBrand(entryValue)) {
        result[entryKey] = "FRONTMIND_KB_STOPPED";
        continue;
      }
      if (
        typeof entryValue === "string" &&
        /^UPSTREAM_/u.test(entryValue)
      ) {
        result[entryKey] = "FRONTMIND_KB_RETRY_AVAILABLE";
        continue;
      }
    }
    if (entryKey === "recoveryToken") {
      result[entryKey] =
        typeof entryValue === "string" && /^[a-f0-9]{64}$/u.test(entryValue)
          ? entryValue
          : null;
      continue;
    }
    result[entryKey] = project(entryValue, entryKey);
  }
  return result;
}

/** The single final transform for every authenticated customer KB response. */
export function toKnowledgeBasePublicPayload<T>(value: T): T {
  return project(value) as T;
}
