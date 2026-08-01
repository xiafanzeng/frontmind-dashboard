import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKnowledgeSnapshotForWorkspace: vi.fn(),
  readKnowledgeSnapshotArchive: vi.fn(),
}));

vi.mock("./_core/express-auth", () => ({
  requireExpressAuth: (req: any, res: any, next: () => void) => {
    if (req.header("x-test-auth") !== "user") {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    req.frontmindUser = {
      id: 42,
      username: "knowledge-user",
      role: "user",
      isActive: true,
    };
    next();
  },
}));

vi.mock("./dashboard-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-service")>();
  return {
    ...actual,
    getKnowledgeSnapshotForWorkspace: mocks.getKnowledgeSnapshotForWorkspace,
  };
});

vi.mock("./knowledge-snapshot-archive-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./knowledge-snapshot-archive-store")>();
  return {
    ...actual,
    readKnowledgeSnapshotArchive: mocks.readKnowledgeSnapshotArchive,
  };
});

import dashboardRouter from "./dashboard-api";

const servers: Server[] = [];
const snapshotId = "00000000-0000-4000-8000-000000000123";
const archive = Buffer.from(
  "PK\u0003\u0004verified-knowledge-archive",
  "binary",
);

beforeEach(() => {
  mocks.getKnowledgeSnapshotForWorkspace.mockReset().mockResolvedValue({
    id: snapshotId,
    userId: 42,
    sourceFileName: "企业知识库.zip",
    archiveHash: "a".repeat(64),
    totalBytes: archive.length,
  });
  mocks.readKnowledgeSnapshotArchive.mockReset().mockResolvedValue(archive);
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
  app.use("/api/dashboard", dashboardRouter);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/dashboard/knowledge/snapshots/${snapshotId}/archive`;
}

describe("knowledge snapshot ZIP endpoint", () => {
  it("requires an authenticated workspace before reading archive bytes", async () => {
    const url = await startApp();
    const response = await fetch(url);

    expect(response.status).toBe(401);
    expect(mocks.getKnowledgeSnapshotForWorkspace).not.toHaveBeenCalled();
    expect(mocks.readKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });

  it("serves the snapshot-bound ZIP with download-safe headers", async () => {
    const url = await startApp();
    const response = await fetch(url, {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/zip");
    expect(response.headers.get("content-length")).toBe(String(archive.length));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E4%BC%81%E4%B8%9A%E7%9F%A5%E8%AF%86%E5%BA%93.zip",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(archive);
    expect(mocks.getKnowledgeSnapshotForWorkspace).toHaveBeenCalledWith({
      actor: expect.objectContaining({ id: 42, role: "user" }),
      snapshotId,
    });
    expect(mocks.readKnowledgeSnapshotArchive).toHaveBeenCalledWith({
      userId: 42,
      snapshotId,
      expectedSha256: "a".repeat(64),
      expectedBytes: archive.length,
    });
  });

  it("round-trips the persisted ZIP through the authenticated download endpoint", async () => {
    const assetRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-knowledge-route-roundtrip-"),
    );
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
    try {
      const zip = new JSZip();
      zip.file("company_knowledge_base/README.md", "# 可下载的企业知识库");
      const bytes = await zip.generateAsync({ type: "nodebuffer" });
      const archiveHash = createHash("sha256").update(bytes).digest("hex");
      const archiveStore = await vi.importActual<
        typeof import("./knowledge-snapshot-archive-store")
      >("./knowledge-snapshot-archive-store");
      await archiveStore.persistKnowledgeSnapshotArchive({
        userId: 42,
        snapshotId,
        buffer: bytes,
        expectedSha256: archiveHash,
      });
      mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce({
        id: snapshotId,
        userId: 42,
        sourceFileName: "企业知识库.zip",
        archiveHash,
        totalBytes: bytes.length,
      });
      mocks.readKnowledgeSnapshotArchive.mockImplementationOnce((input) =>
        archiveStore.readKnowledgeSnapshotArchive(input),
      );

      const url = await startApp();
      const response = await fetch(url, {
        headers: { "x-test-auth": "user" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      if (previousAssetRoot === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
      }
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it("does not disclose or read an archive outside the authenticated workspace", async () => {
    mocks.getKnowledgeSnapshotForWorkspace.mockResolvedValueOnce(null);
    const url = await startApp();
    const response = await fetch(url, {
      headers: { "x-test-auth": "user" },
    });

    expect(response.status).toBe(404);
    expect(mocks.readKnowledgeSnapshotArchive).not.toHaveBeenCalled();
  });
});
