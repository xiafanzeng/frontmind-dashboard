import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import JSZip from "jszip";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildId = "123e4567-e89b-42d3-a456-426614174000";
const oauthCredentialId = "223e4567-e89b-42d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  StaticTemplateCatalogError: class StaticTemplateCatalogError extends Error {
    constructor(public readonly code: string) {
      super(code);
      this.name = "StaticTemplateCatalogError";
    }
  },
  completeSiteOpsAliyunOAuth: vi.fn(),
  exchangeAliyunOAuthCode: vi.fn(),
  getDb: vi.fn(),
  openStaticTemplateCatalogVersionPreview: vi.fn(),
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
}));
vi.mock("./static-template-catalog", () => ({
  StaticTemplateCatalogError: mocks.StaticTemplateCatalogError,
  openStaticTemplateCatalogVersionPreview:
    mocks.openStaticTemplateCatalogVersionPreview,
}));

import { publicSiteOpsArtifactError, siteOpsArtifactApi } from "./artifact-api";
import {
  CUSTOMER_VISIBLE_STYLE_BATCH_STATUSES,
  customerVisibleStyleBatchStatusCondition,
} from "./visual-batch-visibility";

const servers: Server[] = [];
let distZip: Buffer;

beforeEach(async () => {
  const archive = new JSZip();
  archive.file(
    "index.html",
    `<!doctype html><html><head>
      <link rel="icon" href="/favicon.svg">
      <link rel="stylesheet" href="/styles.css">
      <script type="module" src="/assets/app.js"></script>
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
  archive.file("fonts/site.css", "body{font-family:system-ui}");
  archive.file("favicon.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  archive.file("images/hero.png", Buffer.from("preview-image"));
  archive.file("images/hero@2x.png", Buffer.from("preview-image-2x"));
  archive.file(
    "assets/app.js",
    'const routes={"/":"home","/about/":"about"};const logo="/images/hero.png";const product=(slug)=>`/products/${slug}/`;document.body.dataset.route=routes[location.pathname]??"missing";document.body.dataset.logo=logo;document.body.dataset.product=product("demo");',
  );
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
    refreshToken: "refresh-token-secret-sentinel",
  });
  mocks.completeSiteOpsAliyunOAuth.mockReset().mockResolvedValue(undefined);
  mocks.openStaticTemplateCatalogVersionPreview.mockReset();
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

function stylePreviewDatabase(
  localAssetId: string | null,
  sourceMetadata: unknown = {
    schemaVersion: 6,
    renderer: "twenty_first_native_template_v1",
    previewSha256: "b".repeat(64),
  },
  includeNullAssetRow = false,
) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () =>
              localAssetId === null && !includeNullAssetRow
                ? []
                : [{ localAssetId, sourceMetadata }],
          }),
        }),
      }),
    }),
  };
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
      refreshToken: "refresh-token-secret-sentinel",
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

  it("serves one opaque-origin self-contained document without authenticated subresources", async () => {
    const origin = await startApp();
    const prefix = `/api/site-ops/builds/${buildId}/preview/`;
    const response = await fetch(`${origin}${prefix}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const html = await response.text();
    expect(html).toContain('href="data:image/svg+xml;base64,');
    expect(html).not.toContain(`href="${prefix}styles.css"`);
    expect(html).not.toContain(`src="${prefix}assets/app.js"`);
    expect(html).toContain('<script nonce="');
    expect(html).toContain('type="module"');
    expect(html).toContain("document.body.dataset.route");
    expect(html).toContain(`href="${prefix}"`);
    expect(html).toContain(`href="${prefix}about/"`);
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain("url('data:image/png;base64,");
    expect(html).toContain("body{font-family:system-ui}");
    expect(html).toContain('href="https://example.com/"');

    const [cssResponse, faviconResponse, aboutResponse, jsResponse] =
      await Promise.all([
        fetch(`${origin}${prefix}styles.css`),
        fetch(`${origin}${prefix}favicon.svg`),
        fetch(`${origin}${prefix}about/`),
        fetch(`${origin}${prefix}assets/app.js`),
      ]);
    expect(cssResponse.status).toBe(404);
    expect(faviconResponse.status).toBe(404);
    expect(aboutResponse.status).toBe(200);
    expect(await aboutResponse.text()).toContain(`href="${prefix}"`);
    expect(jsResponse.status).toBe(404);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-forms");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/u);
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9_-]+'/u);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

describe("SiteOps visual sample preview", () => {
  const previewAssetId = "323e4567-e89b-42d3-a456-426614174000";
  const realizationAssetId = "423e4567-e89b-42d3-a456-426614174000";
  const previewBytes = Buffer.from("durable-preview-image");
  const referenceHash = "a".repeat(64);
  const realizationHash = "d".repeat(64);

  function v7StaticPreviewMetadata(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const candidateId = "static-template-01-arfazrll-portfolio";
    return {
      schemaVersion: 7,
      renderer: "frontmind_static_template_catalog_v1",
      workflowVersion: "2.8.0",
      catalogVersion: "21st-included-recommended-20260828-v1",
      catalogPosition: 1,
      catalogCandidateId: candidateId,
      providerTemplateId: "827",
      providerSlug: "arfazrll-portfolio",
      sourceAssetId:
        "21st-included-recommended-20260828-v1/source/static-template-01-arfazrll-portfolio",
      sourceArchiveSha256: "d".repeat(64),
      previewAssetId:
        "21st-included-recommended-20260828-v1/preview/static-template-01-arfazrll-portfolio",
      previewSha256: "c".repeat(64),
      previewMimeType: "image/png",
      previewWidth: 1440,
      previewHeight: 900,
      ...overrides,
    };
  }

  function v4DualPreviewMetadata(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      referenceBlueprint: {
        schemaVersion: 4,
        referencePreviewLocalAssetId: previewAssetId,
        referencePreviewSha256: referenceHash,
        previewLocalAssetId: realizationAssetId,
        previewSha256: realizationHash,
      },
      realizationPreviewLocalAssetId: realizationAssetId,
      realizationPreviewSha256: realizationHash,
      ...overrides,
    };
  }

  it("shares one published-or-selected predicate with observation", () => {
    expect(CUSTOMER_VISIBLE_STYLE_BATCH_STATUSES).toEqual([
      "published",
      "selected",
    ]);
    expect(
      new MySqlDialect().sqlToQuery(customerVisibleStyleBatchStatusCondition()),
    ).toMatchObject({
      params: ["published", "selected"],
    });
  });

  it("serves a selected owner's preview after a fresh request without caching it", async () => {
    mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(previewAssetId));
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: "b".repeat(64),
        filename: "preview.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/selected-sample`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(previewBytes);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: "b".repeat(64),
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("serves an authorized V7 preview from the active static catalog without a tenant asset copy", async () => {
    const candidateId = "static-template-01-arfazrll-portfolio";
    const staticBytes = Buffer.from("static-template-preview");
    const staticHash = "c".repeat(64);
    const sourceHash = "d".repeat(64);
    const metadata = v7StaticPreviewMetadata();
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(null, metadata, true),
    );
    mocks.openStaticTemplateCatalogVersionPreview.mockResolvedValueOnce({
      entry: {
        order: 1,
        providerTemplateId: "827",
        providerSlug: "arfazrll-portfolio",
        sourceAssetId: metadata.sourceAssetId,
        previewAssetId: metadata.previewAssetId,
        previewSha256: staticHash,
        previewMimeType: "image/png",
        previewWidth: 1440,
        previewHeight: 900,
        previewBytes: staticBytes.length,
        sourceSha256: sourceHash,
      },
      path: "/static/preview.png",
      stream: Readable.from([staticBytes]),
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-static-sample`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"sha256:${staticHash}"`);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(staticBytes);
    expect(mocks.openStaticTemplateCatalogVersionPreview).toHaveBeenCalledWith(
      metadata.catalogVersion,
      candidateId,
    );
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("serves a frozen V7 preview after the active catalog switches to a future version", async () => {
    const candidateId = "static-template-01-arfazrll-portfolio";
    const catalogVersion = "21st-included-recommended-20260828-v2";
    const previewAssetId = `${catalogVersion}/preview/${candidateId}`;
    const sourceAssetId = `${catalogVersion}/source/${candidateId}`;
    const metadata = v7StaticPreviewMetadata({
      catalogVersion,
      previewAssetId,
      sourceAssetId,
    });
    const staticBytes = Buffer.from("frozen-version-preview");
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(null, metadata, true),
    );
    mocks.openStaticTemplateCatalogVersionPreview.mockResolvedValueOnce({
      entry: {
        order: 1,
        providerTemplateId: "827",
        providerSlug: "arfazrll-portfolio",
        sourceAssetId,
        previewAssetId,
        previewSha256: "c".repeat(64),
        previewMimeType: "image/png",
        previewWidth: 1440,
        previewHeight: 900,
        previewBytes: staticBytes.length,
        sourceSha256: "d".repeat(64),
      },
      path: "/static/catalog-v2/preview.png",
      stream: Readable.from([staticBytes]),
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-frozen-version-sample`,
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(staticBytes);
    expect(mocks.openStaticTemplateCatalogVersionPreview).toHaveBeenCalledWith(
      catalogVersion,
      candidateId,
    );
  });

  it.each([
    [
      "preview asset coordinate",
      { previewAssetId: "catalog/preview/wrong-candidate" },
    ],
    ["source asset coordinate", { sourceAssetId: "catalog/source/wrong" }],
    ["provider slug", { providerSlug: "wrong-provider-slug" }],
    ["preview hash", { previewSha256: "e".repeat(64) }],
    ["source hash", { sourceArchiveSha256: "f".repeat(64) }],
  ])(
    "returns 404 when a V7 %s disagrees with the active catalog",
    async (_label, override) => {
      const metadata = v7StaticPreviewMetadata(override);
      const stream = Readable.from([Buffer.from("must-not-leak")]);
      const destroy = vi.spyOn(stream, "destroy");
      mocks.getDb.mockResolvedValueOnce(
        stylePreviewDatabase(null, metadata, true),
      );
      mocks.openStaticTemplateCatalogVersionPreview.mockResolvedValueOnce({
        entry: {
          order: 1,
          providerTemplateId: "827",
          providerSlug: "arfazrll-portfolio",
          sourceAssetId:
            "21st-included-recommended-20260828-v1/source/static-template-01-arfazrll-portfolio",
          previewAssetId:
            "21st-included-recommended-20260828-v1/preview/static-template-01-arfazrll-portfolio",
          previewSha256: "c".repeat(64),
          previewMimeType: "image/png",
          previewWidth: 1440,
          previewHeight: 900,
          previewBytes: 13,
          sourceSha256: "d".repeat(64),
        },
        path: "/static/preview.png",
        stream,
      });
      const origin = await startApp();

      const response = await fetch(
        `${origin}/api/site-ops/style-previews/v7-coordinate-mismatch`,
      );

      expect(response.status).toBe(404);
      expect(destroy).toHaveBeenCalled();
      expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
    },
  );

  it("projects static catalog path and hash verification failures as 404", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(null, v7StaticPreviewMetadata(), true),
    );
    mocks.openStaticTemplateCatalogVersionPreview.mockRejectedValueOnce(
      new mocks.StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ASSET_HASH_MISMATCH",
      ),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v7-static-hash-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("serves a V4 reference with its reference hash instead of the distinct realization hash", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, v4DualPreviewMetadata()),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: referenceHash,
        filename: "reference.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-reference`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: referenceHash,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("uses the realization hash only when the sample explicitly points to the V4 realization asset", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(realizationAssetId, v4DualPreviewMetadata()),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: realizationAssetId,
        mimeType: "image/webp",
        sizeBytes: previewBytes.length,
        contentSha256: realizationHash,
        filename: "realization.webp",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-realization`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: realizationAssetId,
      expectedSha256: realizationHash,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("allows independently frozen V4 images to contain identical bytes", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(
        previewAssetId,
        v4DualPreviewMetadata({
          referenceBlueprint: {
            schemaVersion: 4,
            referencePreviewLocalAssetId: previewAssetId,
            referencePreviewSha256: referenceHash,
            previewLocalAssetId: realizationAssetId,
            previewSha256: referenceHash,
          },
          realizationPreviewSha256: referenceHash,
        }),
      ),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: referenceHash,
        filename: "reference.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-identical-bytes`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: referenceHash,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("fails closed when a V4 row points to neither frozen image coordinate", async () => {
    const unrelatedAssetId = "523e4567-e89b-42d3-a456-426614174000";
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(unrelatedAssetId, v4DualPreviewMetadata()),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-coordinate-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("fails closed when V4 realization metadata disagrees with its frozen blueprint", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(
        previewAssetId,
        v4DualPreviewMetadata({ realizationPreviewSha256: "e".repeat(64) }),
      ),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/v4-metadata-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("fails closed before reading a source-backed preview whose frozen hash is missing", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, {
        schemaVersion: 6,
        renderer: "twenty_first_native_template_v1",
      }),
    );
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/hash-missing`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("passes the frozen hash to storage and fails safely on a mismatch", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, {
        schemaVersion: 6,
        renderer: "twenty_first_native_template_v1",
        previewSha256: "c".repeat(64),
      }),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce(null);
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/hash-mismatch`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: "c".repeat(64),
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it("rejects a non-image asset even if storage returns it", async () => {
    mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(previewAssetId));
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "application/zip",
        sizeBytes: previewBytes.length,
        contentSha256: "b".repeat(64),
        filename: "preview.zip",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/wrong-mime`,
    );

    expect(response.status).toBe(404);
  });

  it("keeps legacy rows without a frozen hash readable through MIME checks", async () => {
    mocks.getDb.mockResolvedValueOnce(
      stylePreviewDatabase(previewAssetId, { schemaVersion: 1 }),
    );
    mocks.readSiteOpsArtifact.mockResolvedValueOnce({
      row: {
        id: previewAssetId,
        mimeType: "image/png",
        sizeBytes: previewBytes.length,
        contentSha256: "b".repeat(64),
        filename: "preview.png",
      },
      stored: { createReadStream: () => Readable.from([previewBytes]) },
    });
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/legacy-sample`,
    );

    expect(response.status).toBe(200);
    expect(mocks.readSiteOpsArtifact).toHaveBeenCalledWith({
      userId: 42,
      localAssetId: previewAssetId,
      expectedSha256: undefined,
      expectedMimeTypes: [
        "image/avif",
        "image/png",
        "image/jpeg",
        "image/webp",
      ],
    });
  });

  it.each(["superseded batch", "cross-tenant sample"])(
    "returns 404 for a %s without reading artifact bytes",
    async () => {
      mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(null));
      const origin = await startApp();

      const response = await fetch(
        `${origin}/api/site-ops/style-previews/hidden-sample`,
      );

      expect(response.status).toBe(404);
      expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
    },
  );

  it("returns 404 before the database lookup when unauthenticated", async () => {
    const origin = await startApp({ authenticated: false });

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/private-sample`,
    );

    expect(response.status).toBe(404);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.readSiteOpsArtifact).not.toHaveBeenCalled();
  });

  it("returns 404 when an owned preview row has no durable body", async () => {
    mocks.getDb.mockResolvedValueOnce(stylePreviewDatabase(previewAssetId));
    mocks.readSiteOpsArtifact.mockResolvedValueOnce(null);
    const origin = await startApp();

    const response = await fetch(
      `${origin}/api/site-ops/style-previews/missing-body`,
    );

    expect(response.status).toBe(404);
  });
});
