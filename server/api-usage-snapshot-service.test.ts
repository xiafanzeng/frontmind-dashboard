import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  API_USAGE_SCAN_CONCURRENCY,
  apiUsageSeverity,
  assertManagedApiKeyTarget,
  isRollingUsageSnapshotCurrent,
  latestUsageSnapshotByPolicy,
  resolveEffectiveUsageCredentials,
  usageCredentialPoolKey,
  usageSnapshotUsageValues,
} from "./api-usage-snapshot-service";

it("serializes overlapping historical credential scans", () => {
  expect(API_USAGE_SCAN_CONCURRENCY).toBe(1);
});

describe("apiUsageSeverity", () => {
  it("warns exactly at 184,000 of the default 230,000 limit", () => {
    expect(
      apiUsageSeverity({
        used: 183_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("normal");
    expect(
      apiUsageSeverity({
        used: 184_000,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("warning");
  });

  it("becomes critical exactly at the configured limit", () => {
    expect(
      apiUsageSeverity({
        used: 229_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("warning");
    expect(
      apiUsageSeverity({
        used: 230_000,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("critical");
  });

  it("does not turn a failed or unconfigured sync into a usage alert", () => {
    expect(
      apiUsageSeverity({
        used: 999_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "error",
      }),
    ).toBe("unavailable");
  });
});

describe("resolveEffectiveUsageCredentials", () => {
  it("prefers a managed customer's direct Key over the assigned manager's Key", () => {
    const result = resolveEffectiveUsageCredentials({
      userIds: [7, 42],
      credentialRows: [
        {
          id: "cred-manager",
          userId: 7,
          version: 3,
          fingerprint: "fp_manager",
        },
        {
          id: "cred-customer",
          userId: 42,
          version: 5,
          fingerprint: "fp_customer",
        },
      ],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.get(42)).toBe("fp_customer");
    expect(result.credentialOwnerByUser.get(42)).toBe(42);
    expect(result.credentialIdByUser.get(42)).toBe("cred-customer");
    expect(result.credentialVersionByUser.get(42)).toBe(5);
  });

  it("keeps the assigned manager's Key as a legacy fallback", () => {
    const result = resolveEffectiveUsageCredentials({
      userIds: [7, 42],
      credentialRows: [
        {
          id: "cred-manager",
          userId: 7,
          version: 3,
          fingerprint: "fp_manager",
        },
      ],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.get(42)).toBe("fp_manager");
    expect(result.credentialOwnerByUser.get(42)).toBe(7);
    expect(result.credentialIdByUser.get(42)).toBe("cred-manager");
  });

  it("leaves an account unconfigured when neither direct nor fallback Key exists", () => {
    const result = resolveEffectiveUsageCredentials({
      userIds: [42],
      credentialRows: [],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.has(42)).toBe(false);
    expect(result.credentialOwnerByUser.has(42)).toBe(false);
  });

  it("deduplicates inherited snapshots by credential id/version without merging separate credentials", () => {
    expect(
      usageCredentialPoolKey({
        credentialId: "manager-v3",
        credentialVersion: 3,
      }),
    ).toBe(
      usageCredentialPoolKey({
        credentialId: "manager-v3",
        credentialVersion: 3,
      }),
    );
    expect(
      usageCredentialPoolKey({
        credentialId: "customer-v1",
        credentialVersion: 1,
      }),
    ).not.toBe(
      usageCredentialPoolKey({
        credentialId: "manager-v3",
        credentialVersion: 3,
      }),
    );
  });

  it("uses the physical Key fingerprint to merge copied/shared active credentials", () => {
    const first = usageCredentialPoolKey({
      fingerprint: "shared-fingerprint",
      credentialId: "owner-a-v2",
      credentialVersion: 2,
      windowDays: 30,
    });
    const second = usageCredentialPoolKey({
      fingerprint: "shared-fingerprint",
      credentialId: "owner-b-v7",
      credentialVersion: 7,
      windowDays: 30,
    });
    expect(first).toBe(second);
  });
});

describe("rolling usage snapshot identity", () => {
  it("keeps last-good values when a retired credential makes a refresh partial", () => {
    expect(
      usageSnapshotUsageValues({
        status: "error",
        credentialFingerprint: "current-C",
        used: 20,
        accountUsed: 20,
        existing: {
          credentialFingerprint: "current-C",
          used: 20,
          accountUsed: 30,
        },
      }),
    ).toEqual({ used: 20, accountUsed: 30 });
  });

  it("accepts only the exact rolling window fetched after the current credential version existed", () => {
    const fetchedAt = new Date("2026-08-02T08:00:00.000Z");
    const startAt = new Date(fetchedAt.getTime() - 30 * 86_400_000);
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: startAt,
          fetchedAt,
        },
        fingerprint: "same-fingerprint",
        credentialCreatedAt: fetchedAt.getTime() - 1,
        windowDays: 30,
        now: fetchedAt.getTime(),
      }),
    ).toBe(true);
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: startAt,
          fetchedAt,
        },
        fingerprint: "same-fingerprint",
        credentialCreatedAt: fetchedAt.getTime() + 1,
        windowDays: 30,
        now: fetchedAt.getTime(),
      }),
    ).toBe(false);
  });

  it("keeps a failed refresh current by updatedAt without treating partial data as ok", () => {
    const updatedAt = new Date("2026-08-02T08:00:00.000Z");
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: new Date(updatedAt.getTime() - 30 * 86_400_000),
          fetchedAt: null,
          updatedAt,
        },
        fingerprint: "same-fingerprint",
        windowDays: 30,
        now: updatedAt.getTime(),
      }),
    ).toBe(true);
  });

  it("rejects an otherwise matching snapshot after the freshness TTL", () => {
    const fetchedAt = new Date("2026-08-02T08:00:00.000Z");
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: new Date(fetchedAt.getTime() - 30 * 86_400_000),
          fetchedAt,
        },
        fingerprint: "same-fingerprint",
        windowDays: 30,
        now: fetchedAt.getTime() + 31 * 60_000,
      }),
    ).toBe(false);
  });

  it("selects only the newest duplicate snapshot row for a policy", () => {
    const older = {
      id: "older",
      policyId: "policy-1",
      fetchedAt: new Date("2026-08-02T07:00:00.000Z"),
    };
    const newer = {
      id: "newer",
      policyId: "policy-1",
      fetchedAt: new Date("2026-08-02T08:00:00.000Z"),
    };
    expect(latestUsageSnapshotByPolicy([newer, older]).get("policy-1")).toBe(
      newer,
    );
  });
});

describe("unified managed API Key target CAS", () => {
  it("post-scans the previous fingerprint after rotation", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "server/api-usage-snapshot-service.ts"),
      "utf8",
    );
    expect(source).toContain(
      "poolFingerprint: replacement.previousFingerprint",
    );
    expect(source).toContain(
      "previousFingerprint: currentCredential?.fingerprint ?? null",
    );
  });
  it.each([
    ["customer", { id: 1, role: "user" }],
    ["engineer", { id: 2, role: "delivery_member" }],
    [
      "delivery_admin",
      { id: 3, role: "admin", adminAccessLevel: "delivery_admin" },
    ],
    [
      "system_admin",
      { id: 4, role: "admin", adminAccessLevel: "system_admin" },
    ],
  ] as const)("accepts a matching %s target", (kind, target) => {
    expect(() =>
      assertManagedApiKeyTarget({
        kind,
        target,
        actualVersion: 4,
        expectedVersion: 4,
      }),
    ).not.toThrow();
  });

  it("rejects a stale replacement and a mismatched target role", () => {
    expect(() =>
      assertManagedApiKeyTarget({
        kind: "customer",
        target: { id: 1, role: "user" },
        actualVersion: 5,
        expectedVersion: 4,
      }),
    ).toThrow(/迟到请求不会覆盖/);
    expect(() =>
      assertManagedApiKeyTarget({
        kind: "engineer",
        target: { id: 1, role: "user" },
        actualVersion: 0,
        expectedVersion: 0,
      }),
    ).toThrow(/类型不匹配/);
    expect(() =>
      assertManagedApiKeyTarget({
        kind: "system_admin",
        target: {
          id: 3,
          role: "admin",
          adminAccessLevel: "delivery_admin",
        },
        actualVersion: 4,
        expectedVersion: 4,
      }),
    ).toThrow(/类型不匹配/);
  });
});
