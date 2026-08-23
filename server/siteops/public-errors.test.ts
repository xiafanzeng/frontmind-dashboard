import { describe, expect, it } from "vitest";
import {
  publicSiteOpsErrorProjection,
  publicSiteOpsMessageText,
  publicSiteOpsProviderResult,
  sanitizeFrontMindPublicText,
} from "./public-errors";

describe("SiteOps public error projection", () => {
  it("hides the provider name and raw invalid argument from customers", () => {
    const projected = publicSiteOpsErrorProjection({
      code: "invalid_argument",
      message: "Manus task.create failed (invalid_argument)",
      status: "failed",
    });
    expect(projected).toEqual({
      code: "FRONTMIND_BUILD_REQUEST_INVALID",
      message: "FrontMind AI 建站输入未通过上游协议校验，请重置后重新开始。",
    });
    expect(JSON.stringify(projected)).not.toMatch(/manus|invalid_argument/iu);
  });

  it("keeps non-build provider errors unchanged", () => {
    expect(
      publicSiteOpsErrorProjection({
        code: "QUOTE_CHANGED",
        message: "报价已变化。",
      }),
    ).toEqual({ code: "QUOTE_CHANGED", message: "报价已变化。" });
  });

  it("projects provider results before persistence", () => {
    const projected = publicSiteOpsProviderResult("manus", {
      status: "outcome_unknown",
      code: "PROVIDER_TIMEOUT",
      message: "Manus 外部操作结果未知。",
    });
    expect(projected).toMatchObject({
      status: "outcome_unknown",
      code: "FRONTMIND_BUILD_RESULT_PENDING",
    });
    expect(JSON.stringify(projected)).not.toMatch(/manus/iu);
  });

  it("sanitizes historical server-owned message text", () => {
    expect(sanitizeFrontMindPublicText("Manus 暂时无法完成该任务")).toBe(
      "FrontMind AI 建站任务未能完成，请提交工单获取协助。",
    );
  });

  it("sanitizes technical history at the server observation boundary", () => {
    for (const content of [
      "SiteOps 使用 React 静态生成官网。",
      "21st 视觉候选已完成。",
      "个人 API Key 与 Pro 已随官网版本锁定。",
    ]) {
      const projected = publicSiteOpsMessageText({ content });
      expect(projected).not.toMatch(/SiteOps|React|21st|API\s*Key|\bPro\b/iu);
    }
    expect(
      publicSiteOpsMessageText({ content: "SiteOps 项目已打开。" }),
    ).toContain("AI友好官网管理");
    expect(
      publicSiteOpsMessageText({
        content: "Manus invalid_argument",
        errorCode: "invalid_argument",
      }),
    ).toBe("FrontMind AI 建站输入未通过上游协议校验，请重置后重新开始。");
  });

  it("does not project publishing runtime diagnostics into customer readiness", () => {
    const projected = sanitizeFrontMindPublicText(
      "ESA 缺少可用的阿里云标准服务身份（环境 STS/AK、OIDC、凭据文件、ECS RAM Role 或 Credentials URI）",
    );
    expect(projected).toBe(
      "FrontMind 暂未完成网站配置，请稍后重试或提交工单获取协助。",
    );
    expect(projected).not.toMatch(
      /ESA|STS|AK|OIDC|ECS|RAM|Role|Credentials|URI/iu,
    );
  });

  it("keeps the stable output-invalid code after three FrontMind repairs", () => {
    const projected = publicSiteOpsErrorProjection({
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message: "同一 Manus 建站任务已自动修复 3 次。",
      status: "failed",
    });
    expect(projected).toEqual({
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message: "FrontMind AI 建站输出连续未通过结构校验，请重置后重新开始。",
    });
    expect(JSON.stringify(projected)).not.toMatch(/manus/iu);
  });

  it("normalizes a frozen customer credential failure to the public configuration code", () => {
    expect(
      publicSiteOpsErrorProjection({
        code: "FRONTMIND_CUSTOMER_CREDENTIAL_VERSION_UNAVAILABLE",
        message: "当前账号绑定的 AI 建站 API Key 版本不可用。",
        status: "attention_required",
      }),
    ).toEqual({
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      message: "FrontMind AI 建站服务配置暂不可用，系统已停止继续创建任务。",
    });
  });

  it("keeps host QA failures distinct from platform configuration failures", () => {
    expect(
      publicSiteOpsErrorProjection({
        code: "SITEOPS_HOST_MATERIALIZATION_FAILED",
        message: "受信 Astro 构建或 QA 未完成。",
        status: "attention_required",
        forceBuildProvider: true,
      }),
    ).toEqual({
      code: "FRONTMIND_BUILD_QA_FAILED",
      message: "FrontMind AI 建站未通过网站构建或质量检查，请重置后重新开始。",
    });
    expect(
      publicSiteOpsErrorProjection({
        code: "MANUS_CREDENTIAL_VERSION_UNAVAILABLE",
        message: "provider credential unavailable",
        status: "attention_required",
        forceBuildProvider: true,
      }),
    ).toEqual({
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      message: "FrontMind AI 建站服务配置暂不可用，系统已停止继续创建任务。",
    });
  });

  it.each([
    [
      "FRONTMIND_BUILD_ASSET_CONFLICT",
      "FrontMind AI 建站检测到知识资产冲突，请重置后重新开始。",
    ],
    [
      "FRONTMIND_BUILD_COMPILE_FAILED",
      "FrontMind AI 建站未能完成可信网站编译，请重置后重新开始。",
    ],
    [
      "FRONTMIND_BUILD_RUNTIME_UNAVAILABLE",
      "FrontMind AI 建站运行环境暂时不可用，请稍后重试或重置流程。",
    ],
  ] as const)("keeps %s as a distinct FrontMind error", (code, message) => {
    expect(
      publicSiteOpsErrorProjection({
        code,
        message: "provider internals",
        status: "failed",
        forceBuildProvider: true,
      }),
    ).toEqual({ code, message });
  });
});
