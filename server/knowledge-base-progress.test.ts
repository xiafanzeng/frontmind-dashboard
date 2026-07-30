import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES,
  KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES,
  KNOWLEDGE_BASE_MANIFEST_KIND,
  KNOWLEDGE_BASE_PROGRESS_KIND,
  KnowledgeBaseProgressError,
  applyKnowledgeBaseProgressEnvelope,
  assertKnowledgeBaseReadyForPackage,
  canPackageKnowledgeBase,
  createKnowledgeBaseProgressState,
  formatKnowledgeBaseProgressEnvelope,
  getKnowledgeBaseProgressSummary,
  parseKnowledgeBaseProgressEnvelope,
  formatKnowledgeBaseManifestEnvelope,
  parseKnowledgeBaseManifestEnvelope,
  shouldShowKnowledgeBaseCheckmark,
  validateProductionKnowledgeBaseLeafManifest,
} from "./knowledge-base-progress";
import type {
  KnowledgeBaseLeafManifestEntry,
  KnowledgeBaseProgressEnvelope,
} from "./knowledge-base-progress";

const manifest: KnowledgeBaseLeafManifestEntry[] = [
  { id: "identity.name", title: "企业名称", branchId: "identity" },
  { id: "identity.position", title: "企业定位", branchId: "identity" },
  { id: "product.primary", title: "核心产品", branchId: "product" },
];

function envelope(
  revision: number,
  leafId: string,
  from: "current" | "needs_verification",
  to: "confirmed" | "direct_prefilled" | "needs_verification",
): KnowledgeBaseProgressEnvelope {
  return {
    kind: KNOWLEDGE_BASE_PROGRESS_KIND,
    schemaVersion: 1,
    revision,
    transition: { leafId, from, to },
  };
}

function expectProgressError(
  action: () => unknown,
  code: KnowledgeBaseProgressError["code"],
) {
  try {
    action();
    throw new Error("Expected KnowledgeBaseProgressError");
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeBaseProgressError);
    expect((error as KnowledgeBaseProgressError).code).toBe(code);
  }
}

describe("knowledge base leaf manifest validation", () => {
  it("keeps small manifests available for the pure state machine", () => {
    const state = createKnowledgeBaseProgressState(manifest);

    expect(state.leaves).toHaveLength(3);
    expect(state.currentLeafId).toBe("identity.name");
    expect(state.leaves.map((leaf) => leaf.status)).toEqual([
      "current",
      "pending",
      "pending",
    ]);
  });

  it("enforces 8–115 leaves without fixing the top-level branch count", () => {
    const createManifest = (count: number, branchCount: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `leaf-${index + 1}`,
        title: `Leaf ${index + 1}`,
        branchId: `branch-${(index % branchCount) + 1}`,
        branchTitle: `Branch ${(index % branchCount) + 1}`,
      }));

    expect(
      validateProductionKnowledgeBaseLeafManifest(
        createManifest(KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES, 4),
      ),
    ).toHaveLength(KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES);
    expect(
      validateProductionKnowledgeBaseLeafManifest(
        createManifest(KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES, 9),
      ),
    ).toHaveLength(KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES);
    expectProgressError(
      () =>
        validateProductionKnowledgeBaseLeafManifest(
          createManifest(KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES - 1, 3),
        ),
      "INVALID_MANIFEST",
    );
    expectProgressError(
      () =>
        validateProductionKnowledgeBaseLeafManifest(
          createManifest(KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES + 1, 12),
        ),
      "INVALID_MANIFEST",
    );
  });

  it("requires every branch id to keep one stable title", () => {
    const leaves = Array.from({ length: 40 }, (_, index) => ({
      id: `leaf-${index + 1}`,
      title: `Leaf ${index + 1}`,
      branchId: `branch-${(index % 4) + 1}`,
      branchTitle: `Branch ${(index % 4) + 1}`,
    }));
    leaves[4]!.branchTitle = "Conflicting title";

    expectProgressError(
      () => validateProductionKnowledgeBaseLeafManifest(leaves),
      "INVALID_MANIFEST",
    );
  });

  it("accepts exactly one hidden production manifest envelope", () => {
    const leaves = Array.from({ length: 42 }, (_, index) => ({
      id: `leaf-${index + 1}`,
      title: `Leaf ${index + 1}`,
      branchId: `branch-${(index % 5) + 1}`,
      branchTitle: `Branch ${(index % 5) + 1}`,
    }));
    const serialized = formatKnowledgeBaseManifestEnvelope({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves,
    });

    expect(parseKnowledgeBaseManifestEnvelope(serialized).leaves).toHaveLength(
      42,
    );
  });
});

describe("knowledge base single-leaf progression", () => {
  it("confirms only the current leaf and advances exactly one position", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const next = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "confirmed"),
    );

    expect(initial.leaves.map((leaf) => leaf.status)).toEqual([
      "current",
      "pending",
      "pending",
    ]);
    expect(next.leaves.map((leaf) => leaf.status)).toEqual([
      "confirmed",
      "current",
      "pending",
    ]);
    expect(next.currentLeafId).toBe("identity.position");
    expect(next.revision).toBe(1);
    expect(getKnowledgeBaseProgressSummary(next)).toMatchObject({
      handled: 1,
      total: 3,
      overall: 1 / 3,
      confirmed: 1,
      directPrefilled: 0,
    });
  });

  it("keeps needs_verification active until that same leaf is handled", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const needsVerification = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "needs_verification"),
    );

    expect(needsVerification.currentLeafId).toBe("identity.name");
    expect(needsVerification.leaves[0].status).toBe("needs_verification");
    expect(getKnowledgeBaseProgressSummary(needsVerification).overall).toBe(0);
    expect(canPackageKnowledgeBase(needsVerification)).toBe(false);

    const confirmed = applyKnowledgeBaseProgressEnvelope(
      needsVerification,
      envelope(1, "identity.name", "needs_verification", "confirmed"),
    );
    expect(confirmed.currentLeafId).toBe("identity.position");
    expect(confirmed.leaves[0].status).toBe("confirmed");
  });

  it("counts direct prefill as handled without presenting it as confirmed", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const next = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "direct_prefilled"),
    );

    expect(next.leaves[0].status).toBe("direct_prefilled");
    expect(shouldShowKnowledgeBaseCheckmark("direct_prefilled")).toBe(false);
    expect(shouldShowKnowledgeBaseCheckmark("confirmed")).toBe(true);
    expect(getKnowledgeBaseProgressSummary(next)).toMatchObject({
      handled: 1,
      total: 3,
      overall: 1 / 3,
      confirmed: 0,
      directPrefilled: 1,
    });
  });
});

describe("model progress envelope boundary", () => {
  it("extracts one hidden machine-readable envelope from model output", () => {
    const expected = envelope(0, "identity.name", "current", "confirmed");
    const output = [
      "请确认以上企业名称。",
      formatKnowledgeBaseProgressEnvelope(expected),
    ].join("\n\n");

    expect(parseKnowledgeBaseProgressEnvelope(output)).toEqual(expected);
  });

  it("rejects a jump to a non-current leaf", () => {
    const state = createKnowledgeBaseProgressState(manifest);
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          state,
          envelope(0, "product.primary", "current", "confirmed"),
        ),
      "WRONG_LEAF",
    );
  });

  it("rejects stale updates and updates whose from status is false", () => {
    const state = createKnowledgeBaseProgressState(manifest);
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          state,
          envelope(1, "identity.name", "current", "confirmed"),
        ),
      "STALE_REVISION",
    );
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          state,
          envelope(0, "identity.name", "needs_verification", "confirmed"),
        ),
      "FROM_STATUS_MISMATCH",
    );
  });

  it("rejects batch envelopes and rollback transitions", () => {
    const state = createKnowledgeBaseProgressState(manifest);
    const first = formatKnowledgeBaseProgressEnvelope(
      envelope(0, "identity.name", "current", "confirmed"),
    );
    const second = formatKnowledgeBaseProgressEnvelope(
      envelope(0, "identity.position", "current", "confirmed"),
    );

    expectProgressError(
      () => parseKnowledgeBaseProgressEnvelope(`${first}\n${second}`),
      "INVALID_ENVELOPE",
    );
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(state, {
          kind: KNOWLEDGE_BASE_PROGRESS_KIND,
          schemaVersion: 1,
          revision: 0,
          transitions: [
            {
              leafId: "identity.name",
              from: "current",
              to: "confirmed",
            },
          ],
        }),
      "INVALID_ENVELOPE",
    );
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(state, {
          kind: KNOWLEDGE_BASE_PROGRESS_KIND,
          schemaVersion: 1,
          revision: 0,
          transition: {
            leafId: "identity.name",
            from: "current",
            to: "pending",
          },
        }),
      "INVALID_TRANSITION",
    );
  });
});

describe("knowledge base package gate", () => {
  it("blocks packaging until every leaf is confirmed or directly prefilled", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    expect(canPackageKnowledgeBase(initial)).toBe(false);
    expectProgressError(
      () => assertKnowledgeBaseReadyForPackage(initial),
      "PACKAGING_BLOCKED",
    );

    const one = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "confirmed"),
    );
    const two = applyKnowledgeBaseProgressEnvelope(
      one,
      envelope(1, "identity.position", "current", "direct_prefilled"),
    );
    const completed = applyKnowledgeBaseProgressEnvelope(
      two,
      envelope(2, "product.primary", "current", "confirmed"),
    );

    expect(completed.currentLeafId).toBeNull();
    expect(getKnowledgeBaseProgressSummary(completed)).toMatchObject({
      handled: 3,
      total: 3,
      overall: 1,
      overallPercent: 100,
      confirmed: 2,
      directPrefilled: 1,
    });
    expect(canPackageKnowledgeBase(completed)).toBe(true);
    expect(() => assertKnowledgeBaseReadyForPackage(completed)).not.toThrow();

    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          completed,
          envelope(3, "product.primary", "current", "confirmed"),
        ),
      "NO_CURRENT_LEAF",
    );
  });
});
