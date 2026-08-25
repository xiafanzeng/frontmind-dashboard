import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  aliyunOAuthConfigurationDisplayState,
  presalesUsageDisplayState,
} from "./AdminPresales";

describe("presalesUsageDisplayState", () => {
  it("does not contain the retired attribution or emergency-replacement gates", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).not.toContain("attributionComplete");
    expect(source).not.toContain("allowIncompleteHistory");
    expect(source).not.toContain("历史任务未能全部归因到官网");
  });

  it("keeps Website usage and 21st AI building as separate administrator sections", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).toContain('title="官网任务与AI建站"');
    expect(source).toContain("官网任务与积分");
    expect(source).toContain("AI建站（21st）");
    expect(source).toContain("search");
    expect(source).toContain("get_component");
    expect(source).toContain("不与官网任务积分混算");
    expect(source).toContain("域名与发布平台");
    expect(source).toContain("1244409121609391");
  });

  it("never retains Aliyun broker or OAuth plaintext in mutation caches", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "utils.client.admin.presales.aliyun.replaceBroker.mutate",
    );
    expect(source).toContain(
      "utils.client.admin.presales.aliyun.replaceOAuth.mutate",
    );
    expect(source).not.toContain("aliyun.replaceBroker.useMutation");
    expect(source).not.toContain("aliyun.replaceOAuth.useMutation");
  });

  it("distinguishes the OAuth application ID from its secret identifiers", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).toContain("OAuth 应用 ID（Client ID）");
    expect(source).toContain("仅请求 openid 和 aliuid");
    expect(source).toContain("aliuid 设为必需并删除 profile");
    expect(source).toContain("客户角色命名");
    expect(source).toContain("FrontMindSiteOps-<连接标识>");
    expect(source).toContain("FrontMindSiteOpsAccess");
    expect(source).toContain("FrontMindSiteOps-*");
    expect(source).toContain("不是应用密钥");
    expect(source).toContain("应用密钥内容（Client Secret）");
    expect(source).toContain("AppSecretValue");
    expect(source).toContain("AppSecretId");
    expect(source).toContain(
      "当前填写的是应用密钥 ID，请改填 OAuth 应用基本信息中的应用 ID。",
    );
    expect(source).toContain(
      "OAuth 应用 ID 必须填写应用基本信息中的数字型 AppId。",
    );
    expect(source).toContain('inputMode="numeric"');
    expect(source).toContain("applicationIdTail");
    expect(source).toContain('label="凭据指纹"');
    expect(source).not.toContain('label="应用标识"');
  });

  it("uses the server-owned callback and surfaces unusable historical OAuth versions", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).toContain("usableForAuthorization");
    expect(source).toContain("requiresReplacement");
    expect(source).toContain("configurationIssue");
    expect(source).toContain("application_id_is_secret_id");
    expect(source).toContain(
      "当前版本保存的是 AppSecretId，不能发起客户授权。",
    );
    expect(source).toContain('value={aliyunStatus.oauth.callbackUrl ?? ""}');
    expect(source).toContain("readOnly");
    expect(source).not.toContain("setAliyunOAuthCallbackUrl");
    expect(source).not.toContain("callbackUrl: aliyunOAuthCallbackUrl");
  });

  it("preserves a valid legacy status without guessing from a short numeric tail", () => {
    expect(
      aliyunOAuthConfigurationDisplayState({
        configured: true,
        applicationIdTail: "1234",
      }),
    ).toEqual({
      configurationIssue: null,
      requiresReplacement: false,
      usableForAuthorization: true,
    });
    expect(
      aliyunOAuthConfigurationDisplayState({
        configured: false,
        usableForAuthorization: false,
        requiresReplacement: true,
        configurationIssue: "application_id_is_secret_id",
      }),
    ).toEqual({
      configurationIssue: "application_id_is_secret_id",
      requiresReplacement: true,
      usableForAuthorization: false,
    });
  });

  it("sends 21st plaintext through the direct tRPC client without retaining mutation variables", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "utils.client.admin.presales.twentyFirst.replace.mutate",
    );
    expect(source).toContain(
      "utils.client.admin.presales.twentyFirst.test.mutate",
    );
    expect(source).not.toContain("twentyFirst.replace.useMutation");
    expect(source).not.toContain("twentyFirst.test.useMutation");
  });
  it("keeps the locally recorded Website total visible without a Key pool snapshot", () => {
    expect(
      presalesUsageDisplayState({
        keyPoolTotalUsed: null,
        rollingWebsiteUsed: 12_345,
        limit: 230_000,
      }),
    ).toEqual({
      keyTotalLabel: "—",
      websiteUsedLabel: "12,345",
      percentageLabel: "—",
      progressPercentage: 0,
    });
  });

  it("shows the latest Key pool snapshot independently from the rolling Website total", () => {
    const display = presalesUsageDisplayState({
      keyPoolTotalUsed: 115_000,
      rollingWebsiteUsed: 12_345,
      limit: 230_000,
    });
    expect(display.keyTotalLabel).not.toBe("—");
    expect(display.websiteUsedLabel).not.toBe("—");
    expect(display.percentageLabel).toBe("50%");
    expect(display.progressPercentage).toBe(50);
  });

  it("never gates the rolling Website total on account attribution", () => {
    expect(
      presalesUsageDisplayState({
        keyPoolTotalUsed: 216_314,
        rollingWebsiteUsed: 144_360,
        limit: 230_000,
      }),
    ).toEqual({
      keyTotalLabel: "216,314",
      websiteUsedLabel: "144,360",
      percentageLabel: "94%",
      progressPercentage: 94,
    });
  });
});
