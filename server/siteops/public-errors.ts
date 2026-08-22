import type { SiteOpsProviderResult } from "./providers";

const VENDOR_NAME = /manus/iu;
const VENDOR_CODE = /(?:^|_)MANUS(?:_|$)/iu;

export function sanitizeFrontMindPublicText(value: string) {
  if (!VENDOR_NAME.test(value)) return value;
  return "FrontMind AI 建站任务未能完成，请根据错误码重置后重新开始。";
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
      message: "FrontMind AI 建站输入未通过上游协议校验，请重置后重新开始。",
    };
  }
  if (
    /(?:QA|AXE|LIGHTHOUSE|ASTRO|MATERIALIZATION|GENERATED_|CONTENT_)/iu.test(
      code,
    )
  ) {
    return {
      code: "FRONTMIND_BUILD_QA_FAILED",
      message: "FrontMind AI 建站未通过网站构建或质量检查，请重置后重新开始。",
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
      message: "FrontMind AI 建站输出连续未通过结构校验，请重置后重新开始。",
    };
  }
  if (input.status === "attention_required") {
    return {
      code: "FRONTMIND_BUILD_REQUIRES_ATTENTION",
      message:
        "FrontMind AI 建站任务需要处理后才能继续，请稍后重试或重置流程。",
    };
  }
  return {
    code: "FRONTMIND_BUILD_SERVICE_UNAVAILABLE",
    message: "FrontMind AI 建站服务暂时不可用，请稍后重试。",
  };
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
