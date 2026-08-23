import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildId = "123e4567-e89b-42d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readSiteOpsArtifact: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("./artifact-store", () => ({
  readSiteOpsArtifact: mocks.readSiteOpsArtifact,
}));

import {
  publicSiteOpsArtifactError,
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

async function startApp() {
  const app = express();
  app.use((req: any, _res, next) => {
    req.frontmindUser = { id: 42, username: "site-owner", role: "user" };
    next();
  });
  app.use("/api/site-ops", siteOpsArtifactApi);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

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
