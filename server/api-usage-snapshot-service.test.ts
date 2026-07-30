import { describe, expect, it } from "vitest";

import {
  apiUsageSeverity,
  resolveEffectiveUsageCredentials,
} from "./api-usage-snapshot-service";

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
        { userId: 7, fingerprint: "fp_manager" },
        { userId: 42, fingerprint: "fp_customer" },
      ],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.get(42)).toBe("fp_customer");
    expect(result.credentialOwnerByUser.get(42)).toBe(42);
  });

  it("keeps the assigned manager's Key as a legacy fallback", () => {
    const result = resolveEffectiveUsageCredentials({
      userIds: [7, 42],
      credentialRows: [{ userId: 7, fingerprint: "fp_manager" }],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.get(42)).toBe("fp_manager");
    expect(result.credentialOwnerByUser.get(42)).toBe(7);
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
});
