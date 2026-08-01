import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePresalesFileCreateReservation,
  completePresalesFileCreateReservation,
  hashPresalesFileCreatePayload,
  hashPresalesFileIdempotencyKey,
  removePresalesFileCreateReservation,
} from "./presales-file-store";

const originalAssetDir = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
let assetDir = "";

describe("durable presales file-create reservations", () => {
  beforeEach(async () => {
    assetDir = await mkdtemp(path.join(tmpdir(), "presales-file-ledger-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDir;
  });

  afterEach(async () => {
    if (originalAssetDir === undefined) {
      delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    } else {
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = originalAssetDir;
    }
    await rm(assetDir, { recursive: true, force: true });
  });

  it("replays one completed file after response loss and a fresh caller", async () => {
    const idempotencyKey = "geo-custom-file:stable-operation:archive:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "knowledge.zip",
      mimeType: "application/zip",
      sizeBytes: 123,
    });
    const acquired = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 3,
      now: new Date("2026-08-02T08:00:00.000Z"),
    });
    expect(acquired.state).toBe("acquired");
    if (acquired.state !== "acquired") throw new Error("not acquired");

    await completePresalesFileCreateReservation({
      keyHash: acquired.keyHash,
      attemptId: acquired.attemptId,
      upstreamFileId: "upstream-file-1",
      upstreamFilename: "knowledge.zip",
      upstreamStatus: "pending",
      uploadUrl: "https://uploads.example.test/knowledge.zip?signature=secret",
      uploadExpiresAt: "2026-08-02T08:10:00.000Z",
      now: new Date("2026-08-02T08:00:01.000Z"),
    });

    // The API response can disappear here. A new process has no in-memory
    // state; it resolves the same operation solely from the persistent volume.
    const replay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 3,
      now: new Date("2026-08-02T08:00:02.000Z"),
    });
    expect(replay).toMatchObject({
      state: "completed",
      upstreamFileId: "upstream-file-1",
      upstreamFilename: "knowledge.zip",
    });

    const reservationPath = path.join(
      assetDir,
      "presales-files",
      "create-reservations",
      `${hashPresalesFileIdempotencyKey(idempotencyKey)}.json`,
    );
    const persisted = await readFile(reservationPath, "utf8");
    expect(persisted).not.toContain(idempotencyKey);
    expect((await stat(reservationPath)).mode & 0o777).toBe(0o600);
  });

  it("replays the completed file after response loss, restart, and credential rotation", async () => {
    const idempotencyKey = "geo-custom-file:rotation-loss:skill:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "classifier.skill.zip",
      mimeType: "application/zip",
      sizeBytes: 456,
    });
    const first = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-old",
      credentialVersion: 7,
    });
    if (first.state !== "acquired") throw new Error("not acquired");
    await completePresalesFileCreateReservation({
      keyHash: first.keyHash,
      attemptId: first.attemptId,
      upstreamFileId: "file-created-before-rotation",
      upstreamFilename: "classifier.skill.zip",
    });

    // A restarted proxy sees only the durable ledger and the newly active
    // credential. The immutable completed operation still resolves to the
    // original file instead of creating or exposing a second file.
    const replay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-new",
      credentialVersion: 8,
    });
    expect(replay).toMatchObject({
      state: "completed",
      upstreamFileId: "file-created-before-rotation",
    });
    const mismatchedReplay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash: hashPresalesFileCreatePayload({
        filename: "different.skill.zip",
        mimeType: "application/zip",
        sizeBytes: 456,
      }),
      apiCredentialId: "credential-new",
      credentialVersion: 8,
    });
    expect(mismatchedReplay).toEqual({ state: "conflict" });

    await removePresalesFileCreateReservation("file-created-before-rotation");
    const retiredReplay = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-newer",
      credentialVersion: 9,
    });
    expect(retiredReplay).toEqual({
      state: "deleted",
      upstreamFileId: "file-created-before-rotation",
    });
  });

  it("keeps a permanent compact tombstone after cleanup", async () => {
    const idempotencyKey = "geo-custom-file:stable-operation:skill:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "classifier.skill.zip",
      mimeType: "application/zip",
      sizeBytes: 456,
    });
    const input = {
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 3,
    };
    const acquired = await acquirePresalesFileCreateReservation(input);
    if (acquired.state !== "acquired") throw new Error("not acquired");
    await completePresalesFileCreateReservation({
      keyHash: acquired.keyHash,
      attemptId: acquired.attemptId,
      upstreamFileId: "upstream-file-cleaned",
      upstreamFilename: "classifier.skill.zip",
      uploadUrl: "https://uploads.example.test/skill.zip?secret=value",
    });

    await removePresalesFileCreateReservation("upstream-file-cleaned");
    const replay = await acquirePresalesFileCreateReservation(input);
    expect(replay).toEqual({
      state: "deleted",
      upstreamFileId: "upstream-file-cleaned",
    });

    const root = path.join(assetDir, "presales-files", "create-reservations");
    const entries = await readdir(root);
    const tombstonePath = path.join(
      root,
      `${hashPresalesFileIdempotencyKey(idempotencyKey)}.json`,
    );
    const tombstone = await readFile(tombstonePath, "utf8");
    expect(entries).toContain(path.basename(tombstonePath));
    expect(tombstone).not.toContain("uploads.example.test");
    expect(tombstone).not.toContain("classifier.skill.zip");
    expect(Buffer.byteLength(tombstone)).toBeLessThan(1_024);
  });

  it("reclaims only an expired lease with the same upstream key hash", async () => {
    const idempotencyKey = "geo-custom-file:ambiguous-response:archive:v1";
    const requestHash = hashPresalesFileCreatePayload({
      filename: "archive.zip",
      sizeBytes: 10,
    });
    const first = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 1,
      now: new Date("2026-08-02T08:00:00.000Z"),
      leaseMs: 1_000,
    });
    expect(first.state).toBe("acquired");

    const pending = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 1,
      now: new Date("2026-08-02T08:00:00.500Z"),
      leaseMs: 1_000,
    });
    expect(pending.state).toBe("pending");

    const recovered = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash,
      apiCredentialId: "credential-1",
      credentialVersion: 1,
      now: new Date("2026-08-02T08:00:02.000Z"),
      leaseMs: 1_000,
    });
    expect(recovered).toMatchObject({
      state: "acquired",
      keyHash: hashPresalesFileIdempotencyKey(idempotencyKey),
    });
    if (first.state === "acquired" && recovered.state === "acquired") {
      expect(recovered.attemptId).not.toBe(first.attemptId);
    }
  });

  it("rejects reusing one operation key for different file metadata", async () => {
    const idempotencyKey = "geo-custom-file:metadata-conflict:skill:v1";
    await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash: hashPresalesFileCreatePayload({
        filename: "one.zip",
        sizeBytes: 10,
      }),
      apiCredentialId: "credential-1",
      credentialVersion: 1,
    });
    const conflict = await acquirePresalesFileCreateReservation({
      idempotencyKey,
      requestHash: hashPresalesFileCreatePayload({
        filename: "two.zip",
        sizeBytes: 10,
      }),
      apiCredentialId: "credential-1",
      credentialVersion: 1,
    });
    expect(conflict.state).toBe("conflict");
  });
});
