import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ post: vi.fn(), delete: vi.fn() }));
vi.mock("axios", () => ({
  default: { post: provider.post, delete: provider.delete },
}));

import {
  createManagedUploadIntent,
  createManagedUploadIntentTicket,
  managedUploadIntentStorageRoot,
  receiveManagedUploadIntentBody,
} from "./managed-upload-intent";
import {
  inspectResetPollutionUploadIntents,
  removeResetPollutionRetainedSources,
  retireResetPollutionUploadIntents,
} from "./knowledge-base-reset-pollution-upload-cleanup";

const temporary: string[] = [];

afterEach(async () => {
  delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
  delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  provider.post.mockReset();
  provider.delete.mockReset();
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("reset-pollution local upload cleanup", () => {
  it("retires a sealed generation-zero local intent and is idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kb-reset-upload-"));
    temporary.push(root);
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = root;
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(
      32,
      7,
    ).toString("base64");
    const coordinate = {
      userId: 42,
      projectAssignmentId: null,
      conversationId: "conversation-reset-pollution",
      turnId: "00000000-0000-4000-8000-000000000142",
      clientRequestId: "request-reset-pollution",
    };
    const manifest = await createManagedUploadIntent({
      operationId: "reset-pollution:1",
      batchId: "reset-pollution",
      ordinal: 1,
      total: 1,
      filename: "private-customer.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
      userId: 42,
      projectAssignmentId: null,
      credentialId: "credential-1",
      credentialOwnerUserId: 42,
      credentialVersion: 1,
      resumeScope: {
        kind: "knowledge_base",
        conversationId: coordinate.conversationId,
        turnId: coordinate.turnId,
        clientRequestId: coordinate.clientRequestId,
      },
    });
    const ticket = createManagedUploadIntentTicket(manifest).ticket;
    const request = Readable.from([Buffer.from("hello world")]) as Readable & {
      complete: boolean;
    };
    request.complete = true;
    const sealed = await receiveManagedUploadIntentBody({
      intentId: manifest.intentId,
      ticket,
      userId: coordinate.userId,
      projectAssignmentId: null,
      contentLength: 11,
      request,
    });
    expect(sealed).toMatchObject({
      state: "sealed",
      phase: "sealed",
      providerGeneration: 0,
      provider: [],
      receipt: null,
    });
    const proof = await inspectResetPollutionUploadIntents(coordinate);
    expect(proof).toMatchObject({
      intentCount: 1,
      stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      localOnlyItems: [
        {
          intentIdSha256: createHash("sha256")
            .update(manifest.intentId)
            .digest("hex"),
          operationIdSha256: createHash("sha256")
            .update(manifest.operationId)
            .digest("hex"),
          ordinal: 1,
          total: 1,
          state: "sealed",
          sizeBytes: 11,
          sha256: createHash("sha256").update("hello world").digest("hex"),
        },
      ],
    });
    await expect(
      retireResetPollutionUploadIntents({
        ...coordinate,
        expectedStateSha256: proof.stateSha256,
      }),
    ).resolves.toEqual({ retiredCount: 1 });
    await expect(
      retireResetPollutionUploadIntents({
        ...coordinate,
        expectedStateSha256: proof.stateSha256,
      }),
    ).resolves.toEqual({ retiredCount: 1 });
    const directory = path.join(
      managedUploadIntentStorageRoot(),
      createHash("sha256").update(manifest.intentId).digest("hex"),
    );
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const retiredProof = await inspectResetPollutionUploadIntents(coordinate);
    expect(retiredProof).toEqual(proof);
    expect(provider.post).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    const files = await fs.readdir(
      path.join(managedUploadIntentStorageRoot(), "by-operation"),
    );
    const retired = await fs.readFile(
      path.join(managedUploadIntentStorageRoot(), "by-operation", files[0]!),
      "utf8",
    );
    expect(retired).not.toContain(manifest.intentId);
    expect(retired).not.toContain("private-customer.pdf");
  });

  it("removes only the exact proved build-owned staged bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kb-reset-source-"));
    temporary.push(root);
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = root;
    const content = Buffer.from("retained-local-source");
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const buildId = "00000000-0000-4000-8000-000000000142";
    const localStorageKey = [
      "knowledge-base",
      "build-sources",
      "42",
      buildId,
      "g1",
      `${contentSha256}.bin`,
    ].join("/");
    const target = path.join(root, ...localStorageKey.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    await expect(
      removeResetPollutionRetainedSources({
        userId: 42,
        buildId,
        generation: 1,
        sources: [
          { localStorageKey, contentSha256, sizeBytes: content.length },
        ],
      }),
    ).resolves.toEqual({ removedOrMissingCount: 1 });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(provider.post).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });
});
