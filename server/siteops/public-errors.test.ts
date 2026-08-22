import { describe, expect, it } from "vitest";
import {
  publicSiteOpsErrorProjection,
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
      "FrontMind AI 建站任务未能完成，请根据错误码重置后重新开始。",
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
      message: "FrontMind AI 建站任务未能完成，请根据错误码重置后重新开始。",
    });
    expect(JSON.stringify(projected)).not.toMatch(/manus/iu);
  });
});
