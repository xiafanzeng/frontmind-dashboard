import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildId = "123e4567-e89b-42d3-a456-426614174000";
const oauthCredentialId = "223e4567-e89b-42d3-a456-426614174000";
const rosCapability = `ar1.${"a".repeat(16)}.${"b".repeat(32)}.${"c".repeat(22)}`;

const mocks = vi.hoisted(() => ({
  completeSiteOpsAliyunOAuth: vi.fn(),
  exchangeAliyunOAuthCode: vi.fn(),
  getDb: vi.fn(),
  getPublicSiteOpsAliyunRosTemplate: vi.fn(),
  getSiteOpsAliyunRoleConfiguration: vi.fn(),
  readSiteOpsArtifact: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("./artifact-store", () => ({
  readSiteOpsArtifact: mocks.readSiteOpsArtifact,
}));
vi.mock("./aliyun-platform-service", () => ({
  exchangeAliyunOAuthCode: mocks.exchangeAliyunOAuthCode,
}));
vi.mock("./service", () => ({
  completeSiteOpsAliyunOAuth: mocks.completeSiteOpsAliyunOAuth,
  getPublicSiteOpsAliyunRosTemplate: mocks.getPublicSiteOpsAliyunRosTemplate,
  getSiteOpsAliyunRoleConfiguration: mocks.getSiteOpsAliyunRoleConfiguration,
}));

import {
  publicSiteOpsArtifactError,
  siteOpsAliyunRosTemplateApi,
  siteOpsArtifactApi,
} from "./artifact-api";

const servers: Server[] = [];
let distZip: Buffer;

beforeEach(async () => {
  const archive = new JSZip();
  archive.file(
    "index.html",
    `<!doctype html><html><head>
      <link rel="icon" href="/favicon.svg">
      <link rel="stylesheet" href="/styles.css">
      <style>.hero{background:url('/images/hero.png')}</style>
    </head><body>
      <a href="/">首页</a><a href="/about/">关于</a>
      <img src="/images/hero.png" srcset="/images/hero.png 1x, /images/hero@2x.png 2x">
      <a href="https://example.com/">外部链接</a>
    </body></html>`,
  );
  archive.file("about/index.html", '<!doctype html><a href="/">返回首页</a>');
  archive.file(
    "styles.css",
    `.hero{background-image:url(/images/hero.png)}\n@import "/fonts/site.css";`,
  );
  archive.file("favicon.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  archive.file("images/hero.png", Buffer.from("preview-image"));
  archive.file("images/hero@2x.png", Buffer.from("preview-image-2x"));
  distZip = await archive.generateAsync({ type: "nodebuffer" });

  mocks.getDb.mockReset().mockResolvedValue({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                build: {
                  id: buildId,
                  userId: 42,
                  distLocalAssetId: "dist-asset",
                  distHash: "a".repeat(64),
                },
                project: { id: "project-1", userId: 42 },
              },
            ],
          }),
        }),
      }),
    }),
  });
  mocks.readSiteOpsArtifact.mockReset().mockResolvedValue({
    row: {
      id: "dist-asset",
      mimeType: "application/zip",
      sizeBytes: distZip.length,
      contentSha256: "a".repeat(64),
      filename: "dist.zip",
    },
    stored: { createReadStream: () => Readable.from([distZip]) },
  });
  mocks.exchangeAliyunOAuthCode.mockReset().mockResolvedValue({
    credentialId: oauthCredentialId,
    projectId: "project-1",
    accountUid: "1234567890123456",
  });
  mocks.completeSiteOpsAliyunOAuth.mockReset().mockResolvedValue(undefined);
  mocks.getPublicSiteOpsAliyunRosTemplate.mockReset().mockResolvedValue({
    ROSTemplateFormatVersion: "2015-09-01",
    Resources: { FrontMindSiteOpsRole: { Type: "ALIYUN::RAM::Role" } },
  });
  mocks.getSiteOpsAliyunRoleConfiguration.mockReset();
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function startApp(options: { authenticated?: boolean } = {}) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (options.authenticated !== false) {
      req.frontmindUser = { id: 42, username: "site-owner", role: "user" };
    }
    next();
  });
  app.use("/api/site-ops", siteOpsArtifactApi);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function startRosTemplateApp() {
  const app = express();
  app.use("/api/site-ops/aliyun/ros-template", siteOpsAliyunRosTemplateApi);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function expectSecureOAuthCompletionPage(
  response: Response,
  html: string,
  status: "success" | "cancelled" | "failed",
) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");

  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain(`style-src 'nonce-${nonce}'`);
  expect(html).toContain(`<script nonce="${nonce}">`);
  expect(html).toContain(`<style nonce="${nonce}">`);
  expect(html).toContain('type: "frontmind:siteops:aliyun-oauth"');
  expect(html).toContain(`status: "${status}"`);
  expect(html).toContain(
    "window.opener.postMessage(message, window.location.origin)",
  );
  expect(html).toContain("window.close()");
  expect(html).toContain('if (message.status === "cancelled")');
  expect(html).toContain('href="/"');
}

describe("SiteOps Aliyun OAuth callback", () => {
  it("completes authorization and returns a secure same-origin success page", async () => {
    const origin = await startApp();
    const response = await fetch(
      `${origin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
    );
    const html = await response.text();

    expectSecureOAuthCompletionPage(response, html, "success");
    expect(mocks.exchangeAliyunOAuthCode).toHaveBeenCalledWith({
      code: "secret-code-sentinel",
      state: "secret-state-sentinel",
      userId: 42,
    });
    expect(mocks.completeSiteOpsAliyunOAuth).toHaveBeenCalledWith({
      actor: { id: 42, username: "site-owner", role: "user" },
      credentialId: oauthCredentialId,
      projectId: "project-1",
      accountUid: "1234567890123456",
    });
    expect(html).not.toContain("secret-code-sentinel");
    expect(html).not.toContain("secret-state-sentinel");
    expect(html).not.toContain('if (message.status !== "success")');
  });

  it("projects access_denied as a cancelled page without exposing provider input", async () => {
    const origin = await startApp();
    const response = await fetch(
      `${origin}/api/site-ops/aliyun/oauth/callback?error=access_denied&error_description=${encodeURIComponent("customer-secret-provider-description")}&state=secret-state-sentinel`,
    );
    const html = await response.text();

    expectSecureOAuthCompletionPage(response, html, "cancelled");
    expect(mocks.exchangeAliyunOAuthCode).not.toHaveBeenCalled();
    expect(mocks.completeSiteOpsAliyunOAuth).not.toHaveBeenCalled();
    expect(html).not.toContain("access_denied");
    expect(html).not.toContain("customer-secret-provider-description");
    expect(html).not.toContain("secret-state-sentinel");
  });

  it("projects other provider failures as a safe failed page", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const origin = await startApp();
      const response = await fetch(
        `${origin}/api/site-ops/aliyun/oauth/callback?error=invalid_client&error_description=${encodeURIComponent("App not exists: client-id-secret-sentinel")}&state=secret-state-sentinel`,
      );
      const html = await response.text();

      expectSecureOAuthCompletionPage(response, html, "failed");
      expect(mocks.exchangeAliyunOAuthCode).not.toHaveBeenCalled();
      expect(mocks.completeSiteOpsAliyunOAuth).not.toHaveBeenCalled();
      expect(html).not.toContain("invalid_client");
      expect(html).not.toContain("client-id-secret-sentinel");
      expect(html).not.toContain("secret-state-sentinel");
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          event: "siteops_aliyun_oauth_callback_stage_failed",
          stage: "provider_authorization",
          userId: 42,
          errorCode: "PROVIDER_AUTHORIZATION_FAILED",
          releaseSha: null,
        }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "client-id-secret-sentinel",
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "secret-state-sentinel",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("returns a safe failed page when the callback has no authenticated user", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const origin = await startApp({ authenticated: false });
      const response = await fetch(
        `${origin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
      );
      const html = await response.text();

      expectSecureOAuthCompletionPage(response, html, "failed");
      expect(mocks.exchangeAliyunOAuthCode).not.toHaveBeenCalled();
      expect(mocks.completeSiteOpsAliyunOAuth).not.toHaveBeenCalled();
      expect(html).not.toContain("secret-code-sentinel");
      expect(html).not.toContain("secret-state-sentinel");
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          stage: "session",
          userId: null,
          errorCode: "UNAUTHENTICATED",
        }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "secret-code-sentinel",
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "secret-state-sentinel",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("classifies exchange and bind failures by safe stage without logging OAuth material", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const exchangeError = Object.assign(
        new Error("secret-code-sentinel secret-state-sentinel"),
        { code: "INVALID_CREDENTIAL" },
      );
      mocks.exchangeAliyunOAuthCode.mockRejectedValueOnce(exchangeError);
      const exchangeOrigin = await startApp();
      const exchangeResponse = await fetch(
        `${exchangeOrigin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
      );
      expectSecureOAuthCompletionPage(
        exchangeResponse,
        await exchangeResponse.text(),
        "failed",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          stage: "oauth_exchange",
          errorCode: "INVALID_CREDENTIAL",
        }),
      );

      mocks.completeSiteOpsAliyunOAuth.mockRejectedValueOnce(
        Object.assign(new Error("account-uid-secret-sentinel"), {
          code: "STATE_CONFLICT",
        }),
      );
      const bindOrigin = await startApp();
      const bindResponse = await fetch(
        `${bindOrigin}/api/site-ops/aliyun/oauth/callback?code=secret-code-sentinel&state=secret-state-sentinel`,
      );
      expectSecureOAuthCompletionPage(
        bindResponse,
        await bindResponse.text(),
        "failed",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[SiteOps Aliyun OAuth] callback_stage_failed",
        expect.objectContaining({
          stage: "account_bind",
          errorCode: "STATE_CONFLICT",
        }),
      );

      const serializedLogs = JSON.stringify(consoleError.mock.calls);
      expect(serializedLogs).not.toContain("secret-code-sentinel");
      expect(serializedLogs).not.toContain("secret-state-sentinel");
      expect(serializedLogs).not.toContain("account-uid-secret-sentinel");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("SiteOps public Aliyun ROS template", () => {
  it("mounts before global body parsers so malformed public requests stay uniform", async () => {
    const coreSource = await readFile(
      new URL("../_core/index.ts", import.meta.url),
      "utf8",
    );
    const mountIndex = coreSource.indexOf(
      '"/api/site-ops/aliyun/ros-template"',
    );
    expect(mountIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeLessThan(
      coreSource.indexOf('express.json({ limit: "50mb" })'),
    );
  });

  it("serves a capability-bound template without a FrontMind session", async () => {
    const origin = await startRosTemplateApp();
    const response = await fetch(
      `${origin}/api/site-ops/aliyun/ros-template/${rosCapability}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(await response.json()).toEqual({
      ROSTemplateFormatVersion: "2015-09-01",
      Resources: { FrontMindSiteOpsRole: { Type: "ALIYUN::RAM::Role" } },
    });
    expect(mocks.getPublicSiteOpsAliyunRosTemplate).toHaveBeenCalledWith(
      rosCapability,
    );
  });

  it("makes invalid and expired capabilities indistinguishable", async () => {
    mocks.getPublicSiteOpsAliyunRosTemplate.mockRejectedValueOnce(
      new Error("secret-token-sentinel"),
    );
    const origin = await startRosTemplateApp();
    const response = await fetch(
      `${origin}/api/site-ops/aliyun/ros-template/${rosCapability}`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
  });

  it("returns the same secure 404 for missing, extra-path, and non-GET requests", async () => {
    const origin = await startRosTemplateApp();
    const requests = [
      fetch(`${origin}/api/site-ops/aliyun/ros-template`),
      fetch(
        `${origin}/api/site-ops/aliyun/ros-template/${rosCapability}/extra`,
      ),
      fetch(`${origin}/api/site-ops/aliyun/ros-template/${rosCapability}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{malformed-json",
      }),
    ];
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "NOT_FOUND" });
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-robots-tag")).toBe(
        "noindex, nofollow, noarchive",
      );
    }
    expect(mocks.getPublicSiteOpsAliyunRosTemplate).not.toHaveBeenCalled();
  });
});

describe("SiteOps private preview proxy", () => {
  it("never projects internal artifact codes to a customer response", () => {
    expect(
      publicSiteOpsArtifactError(
        new Error("SITEOPS_PREVIEW_PATH_INVALID:/private/storage"),
      ),
    ).toEqual({
      status: 409,
      body: { error: "文件暂时无法打开，请稍后重试。" },
    });
    expect(publicSiteOpsArtifactError(new Error("NOT_FOUND"))).toEqual({
      status: 404,
      body: { error: "NOT_FOUND" },
    });
  });

  it("keeps HTML, CSS, favicon and internal navigation under the authenticated preview prefix", async () => {
    const origin = await startApp();
    const prefix = `/api/site-ops/builds/${buildId}/preview/`;
    const response = await fetch(`${origin}${prefix}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    const html = await response.text();
    expect(html).toContain(`href="${prefix}favicon.svg"`);
    expect(html).toContain(`href="${prefix}styles.css"`);
    expect(html).toContain(`href="${prefix}"`);
    expect(html).toContain(`href="${prefix}about/"`);
    expect(html).toContain(`src="${prefix}images/hero.png"`);
    expect(html).toContain(
      `srcset="${prefix}images/hero.png 1x, ${prefix}images/hero@2x.png 2x"`,
    );
    expect(html).toContain(`url('${prefix}images/hero.png')`);
    expect(html).toContain('href="https://example.com/"');

    const [cssResponse, faviconResponse, aboutResponse] = await Promise.all([
      fetch(`${origin}${prefix}styles.css`),
      fetch(`${origin}${prefix}favicon.svg`),
      fetch(`${origin}${prefix}about/`),
    ]);
    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toBe(
      `.hero{background-image:url(${prefix}images/hero.png)}\n@import "${prefix}fonts/site.css";`,
    );
    expect(faviconResponse.status).toBe(200);
    expect(faviconResponse.headers.get("content-type")).toContain(
      "image/svg+xml",
    );
    expect(aboutResponse.status).toBe(200);
    expect(await aboutResponse.text()).toContain(`href="${prefix}"`);
  });
});
