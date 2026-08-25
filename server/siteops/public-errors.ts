import type { SiteOpsProviderResult } from "./providers";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "../../shared/siteops-branding";

const VENDOR_NAME = /manus/iu;
const VENDOR_CODE = /(?:^|_)MANUS(?:_|$)/iu;
const INFRASTRUCTURE_TERM =
  /(?:\bESA\b|AliDNS|\bDNS\b|RecordId|\bCNAME\b|\bTXT\b|\bTLS\b|\bSTS\b|ExternalId|Role\s*ARN|principal\s*ARN|\bARN\b|\bUID\b|record\s*tuple|remark\s*marker|provider)/iu;
const FRESH_RESET_MESSAGE =
  "本次没有生成可安全展示的版本；可申请重置，批准后请全新上传并从头生成。";

export function sanitizeFrontMindPublicText(value: string) {
  if (VENDOR_NAME.test(value)) {
    return "FrontMind AI 建站任务未能完成，请提交工单获取协助。";
  }
  if (
    /(?:API\s*Key|frontmind-(?:base|pro)|\bBase\b|\bPro\b|已随官网版本锁定|个人(?:建站)?凭据)/iu.test(
      value,
    )
  ) {
    return /(?:未配置|不可用|失效|缺少|尚未)/u.test(value)
      ? "AI 建站服务尚未就绪，请联系 FrontMind。"
      : "FrontMind 已准备好官网制作服务。";
  }
  const sanitized = value
    .replace(/21st/giu, "视觉候选服务")
    .replace(/SiteOps/giu, SITEOPS_CUSTOMER_DISPLAY_NAME)
    .replace(/(?:原生\s*)?Astro/giu, "官网")
    .replace(/React(?:\s*静态)?/giu, "官网")
    .replace(/API\s*Key/giu, "服务配置")
    .replace(/frontmind-(?:base|pro)/giu, "建站模式")
    .replace(/\b(?:Base|Pro)\b/giu, "建站模式")
    .replace(/A[–-]I\s*(?:候选|视觉方向)?/giu, "9 个视觉候选");
  if (!INFRASTRUCTURE_TERM.test(sanitized)) return sanitized;
  if (
    /(?:成功|完成|已在线|已上线|active|succeeded|verified)/iu.test(sanitized)
  ) {
    return "FrontMind 已完成当前网站配置。";
  }
  if (
    /(?:等待|正在|传播|验证中|pending|running|verifying|reconciling)/iu.test(
      sanitized,
    )
  ) {
    return "FrontMind 正在自动完成网站配置，请稍后查看。";
  }
  return "FrontMind 暂未完成网站配置，请稍后重试或提交工单获取协助。";
}

export type SiteOpsCustomerDomainIssue =
  | "quote_changed"
  | "authorization_needed"
  | "payment_required"
  | "identity_required"
  | "service_unavailable"
  | "needs_help";

export function publicSiteOpsDomainIssue(
  code: string | null | undefined,
  status: string | null | undefined,
): SiteOpsCustomerDomainIssue | null {
  const normalized = String(code ?? "").toUpperCase();
  if (
    !normalized &&
    !["failed", "attention_required", "outcome_unknown"].includes(
      String(status),
    )
  ) {
    return null;
  }
  if (/(?:QUOTE|PRICE|EXPIRED)/u.test(normalized)) return "quote_changed";
  if (/(?:AUTH|PERMISSION|ROLE|CALLER|ACCOUNT|CREDENTIAL)/u.test(normalized)) {
    return "authorization_needed";
  }
  if (/(?:BALANCE|PAYMENT|FUNDS|CREDIT)/u.test(normalized))
    return "payment_required";
  if (/(?:REGISTRANT|REAL_NAME|IDENTITY|EMAIL)/u.test(normalized)) {
    return "identity_required";
  }
  if (
    String(status) === "outcome_unknown" ||
    /(?:TIMEOUT|UNAVAILABLE|THROTTL|RATE_LIMIT)/u.test(normalized)
  ) {
    return "service_unavailable";
  }
  return "needs_help";
}

export function publicSiteOpsErrorProjection(input: {
  code: string | null | undefined;
  message: string | null | undefined;
  status?: "failed" | "attention_required" | "outcome_unknown";
  forceBuildProvider?: boolean;
}) {
  const code = String(input.code ?? "").trim();
  const message = String(input.message ?? "").trim();
  const isBuildProviderError =
    input.forceBuildProvider === true ||
    code.startsWith("FRONTMIND_BUILD_") ||
    code.startsWith("FRONTMIND_CUSTOMER_CREDENTIAL_") ||
    VENDOR_CODE.test(code) ||
    /manus/iu.test(message) ||
    code === "invalid_argument";
  if (!isBuildProviderError) {
    return { code, message };
  }
  if (input.status === "outcome_unknown") {
    return {
      code: "FRONTMIND_BUILD_RESULT_PENDING",
      message: "FrontMind AI 建站任务结果仍在确认中，系统不会重复创建任务。",
    };
  }
  if (
    code === "invalid_argument" ||
    /(?:INVALID_ARGUMENT|REQUEST_INVALID|SCHEMA|PROMPT)/iu.test(code)
  ) {
    return {
      code: "FRONTMIND_BUILD_REQUEST_INVALID",
      message: FRESH_RESET_MESSAGE,
    };
  }
  if (code === "FRONTMIND_BUILD_ASSET_CONFLICT") {
    return {
      code,
      message: FRESH_RESET_MESSAGE,
    };
  }
  if (code === "FRONTMIND_BUILD_COMPILE_FAILED") {
    return {
      code,
      message: FRESH_RESET_MESSAGE,
    };
  }
  if (code === "FRONTMIND_BUILD_RUNTIME_UNAVAILABLE") {
    return {
      code,
      message:
        "FrontMind AI 建站运行环境暂时不可用；若任务已经结束，可申请重置，批准后全新开始。",
    };
  }
  if (code === "FRONTMIND_BUILD_OUTPUT_INVALID") {
    return {
      code,
      message: FRESH_RESET_MESSAGE,
    };
  }
  if (
    /^(?:BUILD_INPUT_UNSAFE|BUILD_CANONICALIZATION_FAILED|BUILD_PRIMARY_RENDER_FAILED|BUILD_FALLBACK_RENDER_FAILED|BUILD_ARTIFACT_PERSIST_FAILED|BUILD_ARTIFACT_BINDING_FAILED)$/u.test(
      code,
    )
  ) {
    return {
      code,
      message: FRESH_RESET_MESSAGE,
    };
  }
  if (
    /(?:QA|AXE|LIGHTHOUSE|ASTRO|MATERIALIZATION|GENERATED_|CONTENT_)/iu.test(
      code,
    )
  ) {
    return {
      code: "FRONTMIND_BUILD_QA_FAILED",
      message: FRESH_RESET_MESSAGE,
    };
  }
  if (
    /(?:AUTH|UNAUTHENTICATED|PERMISSION|FORBIDDEN|CREDENTIAL|CONFIGURATION)/iu.test(
      code,
    )
  ) {
    return {
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      message: "FrontMind AI 建站服务配置暂不可用，系统已停止继续创建任务。",
    };
  }
  if (/(?:OUTPUT|EXTRACT|CONTENT|DESIGN|VALIDATION)/iu.test(code)) {
    return {
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message: FRESH_RESET_MESSAGE,
    };
  }
  if (input.status === "attention_required") {
    return {
      code: "FRONTMIND_BUILD_REQUIRES_ATTENTION",
      message: FRESH_RESET_MESSAGE,
    };
  }
  return {
    code: "FRONTMIND_BUILD_SERVICE_UNAVAILABLE",
    message: "FrontMind AI 建站服务暂时不可用，请稍后重试。",
  };
}

export function publicSiteOpsMessageText(input: {
  content: string;
  errorCode?: string | null;
}) {
  const projected = input.errorCode
    ? publicSiteOpsErrorProjection({
        code: input.errorCode,
        message: input.content,
      }).message || input.content
    : input.content;
  return sanitizeFrontMindPublicText(projected);
}

export function publicSiteOpsProviderResult(
  provider: string | null,
  result: SiteOpsProviderResult,
): SiteOpsProviderResult {
  if (provider !== "manus") return result;
  if (result.status === "pending") return result;
  if (result.status === "succeeded") {
    return result.message
      ? { ...result, message: sanitizeFrontMindPublicText(result.message) }
      : result;
  }
  const projected = publicSiteOpsErrorProjection({
    code: result.code,
    message: result.message,
    status: result.status,
    forceBuildProvider: true,
  });
  return { ...result, ...projected };
}
