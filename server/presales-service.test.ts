import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthServiceError, decryptApiKey, encryptApiKey } from "./auth-service";
import {
  presalesTaskRequests,
  presalesUpstreamResources,
} from "../drizzle/schema";
import {
  PRESALES_REVOKABLE_STATUSES,
  aggregatePresalesCreditUsagePage,
  acquirePresalesTaskReservation,
  completePresalesTaskReservation,
  deletePresalesApiCredential,
  decryptPresalesApiKey,
  encryptPresalesApiKey,
  hashPresalesOutputUrl,
  hashPresalesIdempotencyKey,
  hashPresalesTaskPayload,
  releasePresalesTaskReservation,
  resolvePresalesTaskCredentialForFiles,
  syncPresalesOutputUrlGrants,
} from "./presales-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

describe("presales credential encryption", () => {
  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (originalMasterKey === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalMasterKey;
    }
  });

  it("round-trips without persisting plaintext", () => {
    const id = randomUUID();
    const apiKey = "sk-presales-secret-that-must-stay-server-side";
    const encrypted = encryptPresalesApiKey(id, apiKey);

    expect(Object.values(encrypted).join(" ")).not.toContain(apiKey);
    expect(decryptPresalesApiKey({ id, ...encrypted })).toBe(apiKey);
  });

  it("binds ciphertext to the website presales slot and credential id", () => {
    const encrypted = encryptPresalesApiKey(randomUUID(), "sk-presales-secret");
    expect(() =>
      decryptPresalesApiKey({ id: randomUUID(), ...encrypted }),
    ).toThrowError(AuthServiceError);
  });

  it("allows the website credential to independently store an account's raw Key", () => {
    const apiKey = "sk-shared-between-website-and-account";
    const websiteCredentialId = randomUUID();
    const accountCredentialId = randomUUID();
    const websiteEncrypted = encryptPresalesApiKey(websiteCredentialId, apiKey);
    const accountEncrypted = encryptApiKey(7, accountCredentialId, apiKey);

    expect(websiteEncrypted.encryptedKey).not.toBe(
      accountEncrypted.encryptedKey,
    );
    expect(
      decryptPresalesApiKey({
        id: websiteCredentialId,
        ...websiteEncrypted,
      }),
    ).toBe(apiKey);
    expect(
      decryptApiKey({
        id: accountCredentialId,
        userId: 7,
        ...accountEncrypted,
      }),
    ).toBe(apiKey);
  });
});

describe("presales rolling usage aggregation", () => {
  it("deduplicates the same task returned by multiple credential versions and enforces the 30-day boundary", () => {
    const now = Date.parse("2026-08-02T08:00:00.000Z");
    const cutoff = now - 30 * 86_400_000;
    const seenTaskIds = new Set<string>();
    const currentVersion = aggregatePresalesCreditUsagePage({
      tasks: [
        { id: "shared-task", created_at: cutoff, credit_usage: 40 },
        { id: "future-task", created_at: now, credit_usage: 100 },
      ],
      websiteTaskIds: new Set(["shared-task", "future-task"]),
      cutoffMs: cutoff,
      endExclusive: now,
      seenTaskIds,
    });
    const retiredVersion = aggregatePresalesCreditUsagePage({
      tasks: [
        { id: "shared-task", created_at: cutoff, credit_usage: 40 },
        { id: "old-task", created_at: cutoff - 1, credit_usage: 80 },
      ],
      websiteTaskIds: new Set(["shared-task", "old-task"]),
      cutoffMs: cutoff,
      endExclusive: now,
      seenTaskIds,
    });
    expect(currentVersion).toMatchObject({
      keyTotalUsed: 40,
      websiteUsed: 40,
    });
    expect(retiredVersion).toMatchObject({
      keyTotalUsed: 0,
      websiteUsed: 0,
      reachedCutoff: true,
    });
  });

  it("marks a page incomplete instead of reporting a false total when a task timestamp is unknown", () => {
    const result = aggregatePresalesCreditUsagePage({
      tasks: [{ id: "unknown-time", credit_usage: 50 }],
      websiteTaskIds: new Set(["unknown-time"]),
      cutoffMs: 0,
      endExclusive: Date.now(),
      seenTaskIds: new Set(),
    });
    expect(result).toMatchObject({
      keyTotalUsed: 0,
      websiteUsed: 0,
      complete: false,
    });
  });

  it("keeps scanning a page when an expired task appears before a recent task", () => {
    const now = Date.parse("2026-08-02T08:00:00.000Z");
    const cutoff = now - 30 * 86_400_000;
    const result = aggregatePresalesCreditUsagePage({
      tasks: [
        { id: "old-first", created_at: cutoff - 1, credit_usage: 99 },
        { id: "new-later", created_at: cutoff + 1, credit_usage: 40 },
      ],
      websiteTaskIds: new Set(["new-later"]),
      cutoffMs: cutoff,
      endExclusive: now,
      seenTaskIds: new Set(),
    });
    expect(result).toMatchObject({
      keyTotalUsed: 40,
      websiteUsed: 40,
      reachedCutoff: false,
      complete: true,
    });
  });
});

function resourceCredential(id: string, status: "active" | "retired") {
  return {
    id,
    version: id === "credential-1" ? 1 : 2,
    apiKey: `sk-${id}`,
    fingerprint: `fingerprint-${id}`,
    status,
    verifiedAt: new Date("2026-07-22T00:00:00.000Z"),
    resource: {
      id: `resource-${id}`,
      apiCredentialId: id,
      kind: "file" as const,
      upstreamId: `file-${id}`,
      parentTaskId: null,
      createdAt: new Date("2026-07-22T00:00:00.000Z"),
    },
  };
}

describe("presales credential version binding", () => {
  it("rejects retired attachments even when they all belong to one old version", async () => {
    const oldCredential = resourceCredential("credential-1", "retired");
    const active = resourceCredential("credential-2", "active");
    await expect(
      resolvePresalesTaskCredentialForFiles(
        ["kb.zip", "evidence.pdf", "kb.zip"],
        {
          getActive: async () => {
            const { resource: _resource, ...value } = active;
            return value;
          },
          getForFile: async () => oldCredential,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects attachments owned by multiple credential versions", async () => {
    await expect(
      resolvePresalesTaskCredentialForFiles(["old.zip", "new.pdf"], {
        getActive: async () => {
          const { resource: _resource, ...value } = resourceCredential(
            "credential-2",
            "active",
          );
          return value;
        },
        getForFile: async (fileId) =>
          fileId === "old.zip"
            ? resourceCredential("credential-1", "retired")
            : resourceCredential("credential-2", "active"),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an attachment whose credential was revoked", async () => {
    await expect(
      resolvePresalesTaskCredentialForFiles(["revoked.zip"], {
        getActive: async () => {
          const { resource: _resource, ...value } = resourceCredential(
            "credential-2",
            "active",
          );
          return value;
        },
        getForFile: async () => null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses the active credential only when there are no attachments", async () => {
    const active = resourceCredential("credential-2", "active");
    const credential = await resolvePresalesTaskCredentialForFiles([], {
      getActive: async () => {
        const { resource: _resource, ...value } = active;
        return value;
      },
    });
    expect(credential?.id).toBe("credential-2");
  });

  it("returns the current credential when every attachment belongs to it", async () => {
    const activeResource = resourceCredential("credential-2", "active");
    const { resource: _resource, ...active } = activeResource;
    const credential = await resolvePresalesTaskCredentialForFiles(
      ["current.zip", "current.skill.zip"],
      {
        getActive: async () => active,
        getForFile: async () => activeResource,
      },
    );
    expect(credential).toEqual(active);
  });
});

describe("presales credential revocation", () => {
  it("destroys only an unbound active version and preserves retired history", async () => {
    let update: Record<string, unknown> | undefined;
    let selectIndex = 0;
    const executor = {
      select: () => {
        const rows = selectIndex++ === 0 ? [{ id: "active-credential" }] : [];
        return {
          from: () => ({
            where: () => ({
              for: async () => rows,
              limit: () => ({ for: async () => rows }),
            }),
          }),
        };
      },
      update: () => ({
        set: (value: Record<string, unknown>) => {
          update = value;
          return { where: async () => undefined };
        },
      }),
    };

    await deletePresalesApiCredential(executor);

    expect(PRESALES_REVOKABLE_STATUSES).toEqual(["active"]);
    expect(update).toMatchObject({
      status: "deleted",
      validationStatus: "unverified",
    });
    expect(update?.deletedAt).toBeInstanceOf(Date);
    expect(String(update?.encryptedKey)).toHaveLength(44);
    expect(String(update?.encryptionIv)).toHaveLength(16);
    expect(String(update?.encryptionAuthTag)).toHaveLength(24);
  });

  it("fails closed when the active website Key still owns a task, file or monitor run", async () => {
    let selectIndex = 0;
    let updateCalled = false;
    const executor = {
      select: () => {
        const rows =
          selectIndex++ === 0
            ? [{ id: "active-credential" }]
            : selectIndex === 2
              ? [{ id: "bound-resource" }]
              : [];
        return {
          from: () => ({
            where: () => ({
              for: async () => rows,
              limit: () => ({ for: async () => rows }),
            }),
          }),
        };
      },
      update: () => {
        updateCalled = true;
        return { set: () => ({ where: async () => undefined }) };
      },
    };

    await expect(deletePresalesApiCredential(executor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(updateCalled).toBe(false);
  });

  it("stores only a deterministic hash for signed task output URLs", () => {
    const url = "https://objects.example.com/result.zip?signature=secret";
    const hash = hashPresalesOutputUrl(url);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashPresalesOutputUrl(url)).toBe(hash);
    expect(hash).not.toContain("signature");
    expect(hashPresalesOutputUrl(`${url}-different`)).not.toBe(hash);
  });

  it("replaces URL grants so removed task outputs are revoked", async () => {
    const operations: Array<string | { insert: unknown[] }> = [];
    const transaction = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: "resource-task-1" }] }),
        }),
      }),
      delete: () => ({
        where: async () => {
          operations.push("delete");
        },
      }),
      insert: () => ({
        values: async (values: unknown[]) => {
          operations.push({ insert: values });
        },
      }),
    };
    const executor = {
      transaction: async (run: (tx: typeof transaction) => Promise<void>) =>
        run(transaction),
    };

    await syncPresalesOutputUrlGrants(
      {
        apiCredentialId: "credential-1",
        parentTaskId: "task-1",
        urls: [
          {
            url: "https://objects.example.com/current.zip?signature=secret",
            hostname: "objects.example.com",
          },
        ],
      },
      executor,
    );
    expect(operations[0]).toBe("delete");
    expect(operations[1]).toMatchObject({
      insert: [
        {
          apiCredentialId: "credential-1",
          parentTaskId: "task-1",
          hostname: "objects.example.com",
        },
      ],
    });
    expect(JSON.stringify(operations)).not.toContain("signature=secret");

    operations.length = 0;
    await syncPresalesOutputUrlGrants(
      {
        apiCredentialId: "credential-1",
        parentTaskId: "task-1",
        urls: [],
      },
      executor,
    );
    expect(operations).toEqual(["delete"]);
  });
});

function createIdempotencyExecutor() {
  let request: any = null;
  const resources: any[] = [];

  const result = (values: any[]) => {
    const promise = Promise.resolve(values);
    return {
      for: async () => values,
      then: promise.then.bind(promise),
    };
  };

  const insert = (table: unknown) => ({
    values: async (value: any) => {
      if (table === presalesTaskRequests) {
        if (request)
          throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
        request = { ...value };
        return;
      }
      if (table === presalesUpstreamResources) {
        resources.push({ ...value });
      }
    },
  });
  const transaction = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            result(
              table === presalesTaskRequests
                ? request
                  ? [request]
                  : []
                : resources.slice(0, 1),
            ),
        }),
      }),
    }),
    insert,
    update: (table: unknown) => ({
      set: (value: any) => ({
        where: async () => {
          if (table === presalesTaskRequests && request) {
            request = { ...request, ...value };
          }
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === presalesTaskRequests) request = null;
      },
    }),
  };

  return {
    insert,
    transaction: async (run: (tx: typeof transaction) => Promise<unknown>) =>
      run(transaction),
    get request() {
      return request;
    },
    resources,
  };
}

describe("presales task idempotency", () => {
  const input = {
    idempotencyKey: "project-123:knowledge-base:create",
    requestHash: hashPresalesTaskPayload({
      prompt: "build",
      attachments: [],
      agentProfile: "manus-1.6",
      taskMode: "agent",
    }),
    apiCredentialId: "credential-1",
    credentialVersion: 1,
    now: new Date("2026-07-22T00:00:00.000Z"),
    leaseMs: 60_000,
  };

  it("uses a canonical payload hash while preserving array order", () => {
    expect(hashPresalesTaskPayload({ b: 2, a: 1 })).toBe(
      hashPresalesTaskPayload({ a: 1, b: 2 }),
    );
    expect(hashPresalesTaskPayload({ attachments: ["a", "b"] })).not.toBe(
      hashPresalesTaskPayload({ attachments: ["b", "a"] }),
    );
  });

  it("stores only hashes and allows only one concurrent owner", async () => {
    const executor = createIdempotencyExecutor();
    const results = await Promise.allSettled([
      acquirePresalesTaskReservation(input, executor),
      acquirePresalesTaskReservation(input, executor),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<any> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.state).toBe("acquired");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "IDEMPOTENCY_PENDING" });
    expect(executor.request.keyHash).toBe(
      hashPresalesIdempotencyKey(input.idempotencyKey),
    );
    expect(JSON.stringify(executor.request)).not.toContain(
      input.idempotencyKey,
    );
  });

  it("returns the original completed upstream task without a new owner", async () => {
    const executor = createIdempotencyExecutor();
    const first = await acquirePresalesTaskReservation(input, executor);
    expect(first.state).toBe("acquired");
    if (first.state !== "acquired") throw new Error("expected reservation");

    await completePresalesTaskReservation(
      {
        reservationId: first.reservationId,
        attemptId: first.attemptId,
        apiCredentialId: input.apiCredentialId,
        upstreamTaskId: "task-original",
      },
      executor,
    );
    const replay = await acquirePresalesTaskReservation(input, executor);
    expect(replay).toEqual({
      state: "completed",
      upstreamTaskId: "task-original",
      task: { id: "task-original", status: "queued" },
    });
    expect(executor.resources).toHaveLength(1);
    expect(executor.resources[0]).toMatchObject({
      kind: "task",
      upstreamId: "task-original",
      apiCredentialId: "credential-1",
    });
  });

  it("rejects reuse with another payload or credential version", async () => {
    const executor = createIdempotencyExecutor();
    await acquirePresalesTaskReservation(input, executor);

    await expect(
      acquirePresalesTaskReservation(
        { ...input, requestHash: "f".repeat(64) },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      acquirePresalesTaskReservation(
        {
          ...input,
          apiCredentialId: "credential-2",
          credentialVersion: 2,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("releases failed attempts and permits a safe retry", async () => {
    const executor = createIdempotencyExecutor();
    const first = await acquirePresalesTaskReservation(input, executor);
    if (first.state !== "acquired") throw new Error("expected reservation");
    await releasePresalesTaskReservation(first, executor);
    expect(executor.request).toBeNull();

    const retry = await acquirePresalesTaskReservation(input, executor);
    expect(retry.state).toBe("acquired");
    if (retry.state === "acquired") {
      expect(retry.attemptId).not.toBe(first.attemptId);
    }
  });

  it("allows one new owner to take over an expired lease", async () => {
    const executor = createIdempotencyExecutor();
    const first = await acquirePresalesTaskReservation(input, executor);
    const retry = await acquirePresalesTaskReservation(
      { ...input, now: new Date("2026-07-22T00:02:00.000Z") },
      executor,
    );
    expect(first.state).toBe("acquired");
    expect(retry.state).toBe("acquired");
    if (first.state === "acquired" && retry.state === "acquired") {
      expect(retry.reservationId).toBe(first.reservationId);
      expect(retry.attemptId).not.toBe(first.attemptId);
    }
  });
});

describe("presales migrations", () => {
  it("keeps every MySQL constraint identifier within 64 characters", () => {
    for (const migration of [
      "0003_natural_legion.sql",
      "0004_light_tag.sql",
      "0005_dry_invaders.sql",
    ]) {
      const sql = readFileSync(
        resolve(process.cwd(), "drizzle", migration),
        "utf8",
      );
      const names = [...sql.matchAll(/(?:CONSTRAINT|INDEX) `([^`]+)`/g)].map(
        (match) => match[1],
      );
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
    }
    const idempotencySql = readFileSync(
      resolve(process.cwd(), "drizzle", "0005_dry_invaders.sql"),
      "utf8",
    );
    expect(idempotencySql).toContain(
      "CONSTRAINT `presales_task_requests_key_uq` UNIQUE(`keyHash`)",
    );
  });
});
