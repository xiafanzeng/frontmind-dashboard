import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireManagedUploadDeletionFence,
  assertManagedUploadScopesAvailable,
  completeManagedUploadDeletionFence,
  ManagedUploadDeletionFenceError,
  reconcileStaleManagedUploadDeletionFence,
  renewManagedUploadDeletionFence,
  rollbackManagedUploadDeletionFence,
} from "./managed-upload-intent-fence";

describe("managed upload deletion fences", () => {
  let assetDirectory: string;

  beforeEach(async () => {
    assetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intent-fence-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    await fs.rm(assetDirectory, { recursive: true, force: true });
  });

  async function writeIntent(value: Record<string, unknown>) {
    const directory = path.join(
      assetDirectory,
      "managed-upload-intents",
      "intent-directory",
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify(value),
    );
  }

  it("blocks user, credential and project deletion while a sealed intent exists", async () => {
    await writeIntent({
      userId: 42,
      credentialId: "credential-1",
      projectAssignmentId: "project-1",
      state: "sealed",
    });

    for (const scope of [
      { kind: "user" as const, userId: 42 },
      {
        kind: "credential" as const,
        userId: 42,
        credentialId: "credential-1",
      },
      {
        kind: "project" as const,
        userId: 42,
        projectAssignmentId: "project-1",
      },
    ]) {
      await expect(acquireManagedUploadDeletionFence(scope)).rejects.toEqual(
        expect.objectContaining<Partial<ManagedUploadDeletionFenceError>>({
          code: "ACTIVE_INTENT",
        }),
      );
      await expect(assertManagedUploadScopesAvailable([scope])).resolves.toBe(
        undefined,
      );
    }
  });

  it("treats a shared credential id as global across credential owner and intent actor", async () => {
    await writeIntent({
      userId: 84,
      credentialId: "admin-owned-credential",
      credentialOwnerUserId: 42,
      projectAssignmentId: null,
      state: "sealed",
    });

    await expect(
      acquireManagedUploadDeletionFence({
        kind: "credential",
        userId: 42,
        credentialId: "admin-owned-credential",
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });

    await expect(
      acquireManagedUploadDeletionFence({ kind: "user", userId: 42 }),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });
  });

  it("rolls back a deleting fence and retains a completed tombstone", async () => {
    const scope = {
      kind: "credential" as const,
      userId: 42,
      credentialId: "credential-2",
    };
    const rolledBack = await acquireManagedUploadDeletionFence(scope);
    await expect(
      assertManagedUploadScopesAvailable([scope]),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });
    await rollbackManagedUploadDeletionFence(rolledBack);
    await expect(assertManagedUploadScopesAvailable([scope])).resolves.toBe(
      undefined,
    );

    const completed = await acquireManagedUploadDeletionFence(scope);
    await completeManagedUploadDeletionFence(completed);
    await expect(
      assertManagedUploadScopesAvailable([scope]),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });
  });

  it("renews a live deletion lease and reconciles only after authoritative state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const scope = { kind: "user" as const, userId: 77 };
    const token = await acquireManagedUploadDeletionFence(scope);

    vi.setSystemTime(new Date("2026-08-12T00:01:00.000Z"));
    await renewManagedUploadDeletionFence(token);
    vi.setSystemTime(new Date("2026-08-12T00:21:01.000Z"));
    await expect(
      reconcileStaleManagedUploadDeletionFence(scope, "active"),
    ).rejects.toMatchObject({ code: "DELETION_IN_PROGRESS" });

    vi.setSystemTime(new Date("2026-08-12T00:22:01.000Z"));
    await expect(
      reconcileStaleManagedUploadDeletionFence(scope, "active"),
    ).resolves.toBe("active");
    await expect(assertManagedUploadScopesAvailable([scope])).resolves.toBe(
      undefined,
    );
  });

  it("fails closed for terminal manifests with an active lease or orphan provider", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await writeIntent({
      userId: 91,
      credentialId: "credential-terminal",
      projectAssignmentId: null,
      state: "uploaded",
      leaseOwner: "crashed-finalizer",
      leaseExpiresAt: future,
      provider: [],
    });
    const userScope = { kind: "user" as const, userId: 91 };
    await expect(
      acquireManagedUploadDeletionFence(userScope),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });

    await fs.rm(
      path.join(
        assetDirectory,
        "managed-upload-intents",
        "intent-directory",
        "manifest.json",
      ),
    );
    await writeIntent({
      userId: 91,
      credentialId: "credential-terminal",
      projectAssignmentId: null,
      state: "expired",
      leaseOwner: null,
      leaseExpiresAt: null,
      provider: [{ fileId: "provider-orphan", state: "waiting" }],
    });
    await expect(
      acquireManagedUploadDeletionFence(userScope),
    ).rejects.toMatchObject({ code: "ACTIVE_INTENT" });
  });
});
