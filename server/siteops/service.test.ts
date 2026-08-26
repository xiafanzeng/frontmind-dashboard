import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSiteOpsDeploymentTargetAvailable,
  assertCurrentVisualWorkflowVersion,
  completePublishedVisualPageCount,
  createVisualSearchOperationInput,
  currentSiteOpsBuildWorkflowCoordinates,
  freezeSiteOpsCustomerAiCredential,
  freezeSiteOpsReferenceBlueprint,
  hashSiteOpsRequest,
  isSiteOpsOperationReplay,
  isSiteOpsIcpApprovedForCurrentDomain,
  normalizeSiteOpsDomain,
  parseSiteOpsActionPayload,
  projectSiteOpsVisualGeneration,
  projectSiteOpsObservationStatuses,
  projectSiteOpsExecutionSteps,
  projectSiteOpsBuildDelivery,
  projectSiteOpsCurrentResetCycle,
  referenceBlueprintForSiteOpsRevision,
  resolvePinnedTwentyFirstCredentialForBatch,
  resolveSiteOpsAgentProfile,
  siteBriefFromSnapshot,
  siteOpsServiceErrorFromQuota,
  siteOpsVisualSelectionRecovery,
  SiteOpsServiceError,
  visualSearchAllowedForProjectStatus,
  visualSearchReadiness,
} from "./service";
import { SiteOpsQuotaError } from "./quota-service";
import { createVisualEvidenceV1 } from "../../shared/siteops-workflow";
import {
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_WORKFLOW,
  siteOpsActInputSchema,
  siteOpsAliyunConnectionInputSchema,
  siteOpsSendMessageInputSchema,
} from "../../shared/siteops";
import { siteOpsBuildProjectionSchema } from "../../shared/siteops-contract";
import {
  referenceBlueprintV3ForFamily,
  referenceBlueprintV4ForFamily,
} from "../../shared/siteops-design";

describe("SiteOps core contracts", () => {
  it("projects only the fresh workflow cycle after a successful reset", () => {
    const boundary = new Date("2026-08-26T00:00:00.000Z");
    const before = new Date("2026-08-25T23:59:59.999Z");
    const after = new Date("2026-08-26T00:00:00.001Z");
    const resetMetadata = {
      siteOps: { payload: { reset: true, unpublishCompleted: true } },
    };
    const projected = projectSiteOpsCurrentResetCycle({
      successfulResetApplied: true,
      currentTaskStartedAt: boundary,
      messageRows: [
        { id: "old", sentAt: before, metadata: null },
        { id: "same-old", sentAt: boundary, metadata: null },
        { id: "reset-complete", sentAt: boundary, metadata: resetMetadata },
        { id: "new", sentAt: after, metadata: null },
      ],
      timelineMessageRows: [
        { id: "same-timeline", sentAt: boundary, metadata: null },
        { id: "new-timeline", sentAt: after, metadata: null },
      ],
      buildRows: [
        { id: "old-build", createdAt: before, status: "failed" },
        { id: "same-build", createdAt: boundary, status: "cancelled" },
        { id: "new-cancelled", createdAt: after, status: "cancelled" },
        { id: "new-build", createdAt: after, status: "queued" },
      ],
      deploymentRows: [],
      packageRows: [],
      batchRows: [
        { id: "old-board", createdAt: boundary, status: "superseded" },
        { id: "new-board", createdAt: after, status: "published" },
      ],
      timelineOperationRows: [
        { id: "old-operation", createdAt: boundary, status: "cancelled" },
        { id: "new-operation", createdAt: after, status: "running" },
      ],
    });

    expect(projected.messageRows.map((row) => row.id)).toEqual([
      "reset-complete",
      "new",
    ]);
    expect(projected.timelineMessageRows.map((row) => row.id)).toEqual([
      "new-timeline",
    ]);
    expect(projected.buildRows.map((row) => row.id)).toEqual(["new-build"]);
    expect(projected.batchRows.map((row) => row.id)).toEqual(["new-board"]);
    expect(projected.timelineOperationRows.map((row) => row.id)).toEqual([
      "new-operation",
    ]);
  });

  it("preserves the historical projection before a fresh-root reset", () => {
    const row = {
      id: "historical-build",
      createdAt: new Date("2026-08-25T00:00:00.000Z"),
      status: "cancelled",
    };
    expect(
      projectSiteOpsCurrentResetCycle({
        successfulResetApplied: false,
        currentTaskStartedAt: new Date("2026-08-26T00:00:00.000Z"),
        messageRows: [],
        timelineMessageRows: [],
        buildRows: [row],
        deploymentRows: [],
        packageRows: [],
        batchRows: [],
        timelineOperationRows: [],
      }).buildRows,
    ).toEqual([row]);
  });

  it("keeps native build delivery visible after a later deploy succeeds", () => {
    expect(
      projectSiteOpsBuildDelivery({
        buildId: "build-1",
        operations: [
          {
            buildId: "build-1",
            kind: "deploy",
            status: "succeeded",
            result: { stage: "deployed" },
          },
          {
            buildId: "build-1",
            kind: "site_build",
            status: "succeeded",
            result: {
              buildDelivery: {
                renderMode: "twenty_first_native",
                qaStatus: "passed_with_warnings",
                warningCodes: ["AXE_COLOR_CONTRAST"],
              },
            },
          },
        ],
      }),
    ).toEqual({
      renderMode: "twenty_first_native",
      qaStatus: "passed_with_warnings",
      warningCodes: ["AXE_COLOR_CONTRAST"],
    });
  });

  it("projects real build stages once and preserves terminal elapsed time", () => {
    const steps = projectSiteOpsExecutionSteps({
      operations: [
        {
          id: "operation-build",
          buildId: "build-1",
          kind: "site_build",
          status: "failed",
          startedAt: new Date("2026-08-22T00:00:00.000Z"),
          completedAt: new Date("2026-08-22T00:04:00.000Z"),
          createdAt: new Date("2026-08-22T00:00:00.000Z"),
        },
      ],
      timelineMessages: [
        {
          id: "message-design-first",
          sentAt: new Date("2026-08-22T00:00:20.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "design_compiling",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:00:20.000Z",
              },
            },
          },
        },
        {
          id: "message-design-duplicate",
          sentAt: new Date("2026-08-22T00:00:40.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "design_compiling",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:00:40.000Z",
              },
            },
          },
        },
        {
          id: "message-content",
          sentAt: new Date("2026-08-22T00:01:00.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "content_building",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:01:00.000Z",
              },
            },
          },
        },
        {
          id: "message-qa",
          sentAt: new Date("2026-08-22T00:03:00.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "qa_running",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:03:00.000Z",
              },
            },
          },
        },
      ],
    });

    expect(steps.map((step) => step.stage)).toEqual([
      "preparing",
      "design_compiling",
      "content_building",
      "qa_running",
    ]);
    expect(steps[0]).toMatchObject({
      status: "succeeded",
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:00:20.000Z",
    });
    expect(steps[3]).toMatchObject({
      status: "failed",
      completedAt: "2026-08-22T00:04:00.000Z",
    });
  });

  it("uses one total-duration row for a historical build without stage events", () => {
    expect(
      projectSiteOpsExecutionSteps({
        operations: [
          {
            id: "legacy-operation",
            buildId: "legacy-build",
            kind: "build_revision",
            status: "succeeded",
            startedAt: new Date("2026-08-22T00:00:00.000Z"),
            completedAt: new Date("2026-08-22T00:05:00.000Z"),
            createdAt: new Date("2026-08-22T00:00:00.000Z"),
          },
        ],
        timelineMessages: [],
      }),
    ).toEqual([
      {
        id: "legacy-operation:legacy-total",
        operationKind: "build_revision",
        buildId: "legacy-build",
        stage: "completed",
        label: "官网制作",
        status: "succeeded",
        startedAt: "2026-08-22T00:00:00.000Z",
        completedAt: "2026-08-22T00:05:00.000Z",
      },
    ]);
  });

  it("allows an unselected visual board to be replaced without resetting the website", () => {
    expect(
      visualSearchAllowedForProjectStatus("awaiting_visual_selection", true),
    ).toBe(true);
    expect(
      visualSearchAllowedForProjectStatus("awaiting_visual_selection", false),
    ).toBe(false);
    expect(visualSearchAllowedForProjectStatus("collecting_brief", false)).toBe(
      true,
    );
  });

  it.each([
    ["SITEOPS_ENTITLEMENT_REQUIRED", 403, "FORBIDDEN"],
    ["SITEOPS_QUOTA_PERIOD_NOT_FOUND", 409, "STATE_CONFLICT"],
    ["SITEOPS_QUOTA_EXHAUSTED", 409, "STATE_CONFLICT"],
  ] as const)(
    "maps %s to its stable SiteOps service boundary",
    (quotaCode, statusCode, serviceCode) => {
      const mapped = siteOpsServiceErrorFromQuota(
        new SiteOpsQuotaError(quotaCode, "配额提示", statusCode),
      );

      expect(mapped).toMatchObject({
        code: serviceCode,
        message: "配额提示",
        statusCode,
      });
    },
  );

  it("freezes the selected production F reference to a hashed floating-orbit blueprint", () => {
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:8435",
      metadataSha256: "a".repeat(64),
      providerResponseSha256: "b".repeat(64),
      previewSha256: "c".repeat(64),
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const frozen = freezeSiteOpsReferenceBlueprint({
      sampleId: "10000000-0000-4000-8000-000000000001",
      note: "Hero Section 7",
      sourceMetadata: {
        providerItemKey: "n:8435",
        title: "Hero Section 7",
        sourceUrl: "https://21st.dev/@ravikatiyar162/components/hero-section-7",
        heroEligibility: {
          eligible: true,
          confidence: "explicit",
          variant: "centered_statement",
        },
        visualEvidence,
      },
    });
    expect(frozen.heroFamily).toBe("floating_orbit");
    expect(frozen.mediaStrategy).toBe("procedural_brand_svg");
    expect(frozen.blueprintHash).toHaveLength(64);

    const inherited = referenceBlueprintForSiteOpsRevision({
      parentWorkflowVersion: "2.0.0",
      parentOperationInput: { referenceBlueprint: frozen },
      derivedReferenceBlueprint: frozen,
    });
    expect(inherited).toEqual(frozen);
    expect(() =>
      referenceBlueprintForSiteOpsRevision({
        parentWorkflowVersion: "2.0.0",
        parentOperationInput: {},
        derivedReferenceBlueprint: frozen,
      }),
    ).toThrow("不能静默改变视觉方向");
    expect(
      referenceBlueprintForSiteOpsRevision({
        parentWorkflowVersion: "1.6.0",
        parentOperationInput: {},
        derivedReferenceBlueprint: frozen,
      }),
    ).toEqual(frozen);
  });

  it("freezes an exact host-rendered V3 blueprint and local preview", () => {
    const sampleId = "10000000-0000-4000-8000-000000000001";
    const previewLocalAssetId = "20000000-0000-4000-8000-000000000002";
    const providerItemKey = "s:frontmind:editorial:evidence";
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey,
      metadataSha256: "a".repeat(64),
      providerResponseSha256: "b".repeat(64),
      previewSha256: "c".repeat(64),
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const blueprint = referenceBlueprintV3ForFamily({
      candidateId: sampleId,
      providerItemKey,
      previewLocalAssetId,
      previewSha256: visualEvidence.previewSha256,
      heroFamily: "editorial",
      inspirationEvidenceIds: ["d".repeat(64)],
    });
    expect(
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId,
        note: "编辑杂志式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
        },
      }),
    ).toEqual(blueprint);
    expect(() =>
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId: "30000000-0000-4000-8000-000000000003",
        note: "编辑杂志式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
        },
      }),
    ).toThrow("所选视觉方案已失效");
  });

  it("freezes a V4 provider reference separately from its trusted realization", () => {
    const sampleId = "10000000-0000-4000-8000-000000000001";
    const referencePreviewLocalAssetId = "20000000-0000-4000-8000-000000000002";
    const realizationPreviewLocalAssetId =
      "30000000-0000-4000-8000-000000000003";
    const providerItemKey = "n:18898";
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey,
      metadataSha256: "a".repeat(64),
      providerResponseSha256: "b".repeat(64),
      previewSha256: "c".repeat(64),
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const blueprint = referenceBlueprintV4ForFamily({
      candidateId: sampleId,
      providerItemKey,
      referencePreviewLocalAssetId,
      referencePreviewSha256: visualEvidence.previewSha256,
      realizationPreviewLocalAssetId,
      realizationPreviewSha256: "d".repeat(64),
      heroFamily: "split_media",
      inspirationEvidenceId: visualEvidence.evidenceSha256,
      inspirationTaxonomy: {
        role: "foundation",
        palette: [],
        typography: [],
        layout: ["split-layout"],
        motion: [],
        accessibility: ["reduced-motion"],
      },
    });

    expect(
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId: referencePreviewLocalAssetId,
        note: "分屏媒体式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
          realizationPreviewLocalAssetId,
          realizationPreviewSha256: blueprint.previewSha256,
        },
      }),
    ).toEqual(blueprint);
    expect(() =>
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId: referencePreviewLocalAssetId,
        note: "分屏媒体式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
          realizationPreviewLocalAssetId,
          realizationPreviewSha256: "e".repeat(64),
        },
      }),
    ).toThrow("所选视觉方案已失效");
  });

  it("freezes every new root or revision build to the current complete workflow coordinates", () => {
    expect(currentSiteOpsBuildWorkflowCoordinates()).toEqual({
      workflowUpstreamVersion: SITEOPS_MATERIALIZER_V2_5.upstreamVersion,
      workflowUpstreamHash: SITEOPS_MATERIALIZER_V2_5.upstreamSha256,
      workflowVersion: SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
      workflowPackageHash: SITEOPS_MATERIALIZER_V2_5.runtimeManifestSha256,
      starterVersion: SITEOPS_MATERIALIZER_V2_5.starterVersion,
    });
  });

  it("requires a selected visual board to match the current workflow", () => {
    expect(() => assertCurrentVisualWorkflowVersion("0.0.0")).toThrow(
      "视觉检索使用的建站合同已升级",
    );
    expect(() =>
      assertCurrentVisualWorkflowVersion(
        SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
      ),
    ).not.toThrow();
  });

  it("creates a strict four-field visual operation without a Manus credential", () => {
    const input = createVisualSearchOperationInput({
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion: "1.2.0",
    });

    expect(input).toEqual({
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion: "1.2.0",
    });
    expect(Object.keys(input).sort()).toEqual([
      "credentialId",
      "credentialVersion",
      "knowledgeSnapshotId",
      "workflowVersion",
    ]);
  });

  it("creates a strict V2 supplemental visual operation pinned to the admitted revision", () => {
    expect(
      createVisualSearchOperationInput({
        schemaVersion: 2,
        knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
        credentialId: "20000000-0000-4000-8000-000000000002",
        credentialVersion: 7,
        workflowVersion: "1.2.0",
        mode: "supplemental",
        page: 2,
        admissionRevision: 9,
      }),
    ).toMatchObject({
      schemaVersion: 2,
      mode: "supplemental",
      page: 2,
      admissionRevision: 9,
    });
    expect(() =>
      createVisualSearchOperationInput({
        schemaVersion: 2,
        knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
        credentialId: "20000000-0000-4000-8000-000000000002",
        credentialVersion: 7,
        workflowVersion: "1.2.0",
        mode: "initial",
        page: 2,
        admissionRevision: 9,
      }),
    ).toThrow();
  });

  it("separates supplemental generation from selection and recovers a terminal legacy board", () => {
    const operationInput = {
      schemaVersion: 2,
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion: "1.2.0",
      mode: "supplemental",
      page: 2,
      admissionRevision: 9,
    };
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "awaiting_visual_selection",
        generatedPages: 1,
        latestVisualOperation: { status: "running", input: operationInput },
        hasActiveVisualOperation: true,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "generating",
      targetPage: 2,
      canGenerateMore: false,
      canSelectExisting: false,
    });
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "attention_required",
        generatedPages: 1,
        latestVisualOperation: {
          status: "attention_required",
          input: operationInput,
        },
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "retryable_error",
      targetPage: null,
      canGenerateMore: true,
      canSelectExisting: true,
      recoveredSelection: true,
    });
  });

  it("requires a complete board, terminal visual operation and no active work for compatibility selection", () => {
    const recoverable = {
      projectStatus: "failed",
      completePublishedPages: 1,
      latestVisualOperationStatus: "failed",
      hasActiveVisualOperation: false,
      hasActiveBuild: false,
      hasBuildAttempt: false,
    };
    expect(siteOpsVisualSelectionRecovery(recoverable)).toBe(true);
    expect(
      siteOpsVisualSelectionRecovery({
        ...recoverable,
        hasActiveVisualOperation: true,
      }),
    ).toBe(false);
    expect(
      siteOpsVisualSelectionRecovery({
        ...recoverable,
        completePublishedPages: 0,
      }),
    ).toBe(false);
    expect(
      siteOpsVisualSelectionRecovery({
        ...recoverable,
        hasBuildAttempt: true,
      }),
    ).toBe(false);
  });

  it("does not recover visual selection from a selected display fallback after a terminal build failure", () => {
    const selectedBatchId = "selected-batch";
    const generatedPages = completePublishedVisualPageCount({
      batches: [{ id: selectedBatchId, status: "selected" }],
      candidates: Array.from({ length: 9 }, () => ({
        batchId: selectedBatchId,
      })),
    });

    expect(generatedPages).toBe(0);
    for (const projectStatus of ["failed", "attention_required"]) {
      expect(
        projectSiteOpsVisualGeneration({
          projectStatus,
          generatedPages,
          latestVisualOperation: { status: "succeeded" },
          hasActiveVisualOperation: false,
          hasActiveBuild: false,
          hasBuildAttempt: true,
        }),
      ).toMatchObject({
        status: "idle",
        generatedPages: 0,
        canGenerateMore: false,
        canSelectExisting: false,
        recoveredSelection: false,
      });
    }
  });

  it("projects both the project and interaction state when a legacy board is recovered", () => {
    expect(
      projectSiteOpsObservationStatuses({
        projectStatus: "attention_required",
        recoveredSelection: true,
      }),
    ).toEqual({
      projectStatus: "awaiting_visual_selection",
      interactionState: "awaiting_visual_selection",
    });
    expect(
      projectSiteOpsObservationStatuses({
        projectStatus: "draft",
        recoveredSelection: false,
      }),
    ).toEqual({
      projectStatus: "draft",
      interactionState: "select_snapshot",
    });
  });

  it("hashes canonical object keys while preserving meaningful array order", () => {
    expect(hashSiteOpsRequest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashSiteOpsRequest({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(hashSiteOpsRequest({ items: ["A", "B"] })).not.toBe(
      hashSiteOpsRequest({ items: ["B", "A"] }),
    );
  });

  it("replays the same operation before reserving quota and rejects key reuse", () => {
    const requestHash = hashSiteOpsRequest({ action: "create_wechat_package" });
    expect(
      isSiteOpsOperationReplay({ inputHash: requestHash }, requestHash),
    ).toBe(true);
    expect(() =>
      isSiteOpsOperationReplay(
        { inputHash: requestHash },
        hashSiteOpsRequest({ action: "create_xiaohongshu_package" }),
      ),
    ).toThrow("该请求标识已用于不同操作");
    expect(isSiteOpsOperationReplay(null, requestHash)).toBe(false);
  });

  it("normalizes an IDN to its lower-case ASCII identity", () => {
    const domain = normalizeSiteOpsDomain("例子.公司.");
    expect(domain.domain).toBe("xn--fsqu00a.xn--55qx5d");
    expect(domain.domainUnicode).toBe("例子.公司");
  });

  it("accepts ICP approval only for the exact current domain revision", () => {
    const profile = {
      icpStatus: "approved",
      icpNumber: "京ICP备12345678号",
      icpDomainRevision: 6,
      domainRevision: 6,
    };
    expect(isSiteOpsIcpApprovedForCurrentDomain(profile)).toBe(true);
    expect(
      isSiteOpsIcpApprovedForCurrentDomain({ ...profile, domainRevision: 7 }),
    ).toBe(false);
    expect(
      isSiteOpsIcpApprovedForCurrentDomain({
        ...profile,
        icpStatus: "not_required",
      }),
    ).toBe(false);
  });

  it("builds a sourced brief from dashboard-core customer-confirmed leaves", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "维他健康-knowledge-base.zip",
      documents: [
        {
          id: "1.1",
          path: "企业概览/公司简介.md",
          title: "企业概览",
          content: "公司名称：维他健康\n\n面向关注健康管理的企业客户。",
          kind: "leaf",
          evidenceStatus: "needs_verification",
          customerVisible: true,
        },
        {
          id: "inferred-1",
          path: "推断.md",
          title: "推断内容",
          content: "不存在的客户案例",
          kind: "leaf",
          evidenceStatus: "inferred",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(brief.companyName).toBe("维他健康");
    expect(brief.routes[0]?.sourceDocumentIds).toContain("1.1");
    expect(brief.verifiedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceDocumentIds: ["1.1"] }),
      ]),
    );
    expect(JSON.stringify(brief)).not.toContain("不存在的客户案例");
  });

  it("prefers the explicit public brand over a generic overview title", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "维他健康-knowledge-base.zip",
      documents: [
        {
          id: "brand-overview",
          path: "企业与品牌概览.md",
          title: "企业与品牌概览",
          content:
            "维他健康是一家聚焦健康服务的企业，以「天印溯方」为对外品牌。",
          kind: "overview",
          evidenceStatus: "verified",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(brief.companyName).toBe("天印溯方");
    expect(brief.companyName).not.toBe("企业与品牌概览");
  });

  it("derives conditional content routes only from the frozen public inventory", () => {
    const documents = [
      ["overview-source", "企业概览.md", "企业概览", "公司名称：星河智造"],
      ["product-source", "产品/设备.md", "产品中心", "已确认的设备产品。"],
      ["service-source", "服务/运维.md", "服务方案", "已确认的运维服务。"],
      ["application-source", "应用/制造.md", "应用场景", "已确认的制造场景。"],
      ["case-source", "案例/客户.md", "客户案例", "已确认的客户案例。"],
      ["blog-source", "知识/指南.md", "知识博客", "已确认的知识指南。"],
      ["faq-source", "FAQ/问题.md", "常见问题", "已确认的常见问题。"],
      ["industry-news-source", "新闻/行业.md", "行业新闻", "外部行业新闻。"],
    ].map(([id, documentPath, title, content]) => ({
      id,
      path: documentPath,
      title,
      content,
      kind: id === "overview-source" ? "overview" : "leaf",
      evidenceStatus: "verified",
      customerVisible: true,
    }));
    documents.push({
      id: "inferred-company-news",
      path: "新闻/公司动态.md",
      title: "公司动态",
      content: "未经客户确认的动态。",
      kind: "leaf",
      evidenceStatus: "inferred",
      customerVisible: true,
    });

    const brief = siteBriefFromSnapshot({
      sourceFileName: "星河智造-knowledge-base.zip",
      documents,
      assets: [],
    } as never);
    const routeById = new Map(brief.routes.map((route) => [route.id, route]));
    for (const routeId of [
      "products",
      "services",
      "applications",
      "cases",
      "blog",
      "faq",
      "news",
    ]) {
      expect(routeById.has(routeId)).toBe(true);
    }
    expect(routeById.get("news")?.sourceDocumentIds).toEqual([]);
    expect(
      brief.contentInventory.entries.find(
        (entry) => entry.kind === "company_news",
      ),
    ).toBeUndefined();
    expect(JSON.stringify(brief)).not.toContain("inferred-company-news");
    expect(routeById.get("news")?.sourceDocumentIds).not.toContain(
      "industry-news-source",
    );
    expect(brief.contentInventory.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "product",
        "service",
        "application",
        "case_study",
        "blog",
        "faq",
      ]),
    );
  });

  it("allows the host-owned empty company-news route to start visual search", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content:
            "公司名称：天印溯方。天印溯方提供有来源记录的健康管理与检测服务。",
          kind: "overview",
          evidenceStatus: "needs_verification",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(brief.routes.find((route) => route.id === "news")).toMatchObject({
      slug: "/news",
      sourceDocumentIds: [],
    });
    expect(
      brief.contentInventory.entries.some(
        (entry) => entry.kind === "company_news",
      ),
    ).toBe(false);
    expect(visualSearchReadiness(brief)).toEqual({ ready: true, brief });
  });

  it("rejects an empty news route when frozen company-news inventory exists", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content: "公司名称：天印溯方。企业提供有来源记录的健康管理服务。",
          kind: "overview",
          evidenceStatus: "verified_authoritative",
          customerVisible: true,
        },
        {
          id: "company-news-source",
          path: "新闻/企业动态.md",
          title: "企业动态",
          content: "天印溯方发布了有来源和日期记录的企业动态。",
          kind: "leaf",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);
    const broken = {
      ...brief,
      routes: brief.routes.map((route) =>
        route.id === "news" ? { ...route, sourceDocumentIds: [] } : route,
      ),
    };

    expect(visualSearchReadiness(broken)).toEqual({
      ready: false,
      reason: "source_contract_mismatch",
      routeId: "news",
    });
  });

  it("rejects an ordinary source-less route", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content: "公司名称：天印溯方。企业提供有来源记录的健康管理服务。",
          kind: "overview",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);
    const broken = {
      ...brief,
      routes: brief.routes.map((route) =>
        route.id === "about" ? { ...route, sourceDocumentIds: [] } : route,
      ),
    };

    expect(visualSearchReadiness(broken)).toEqual({
      ready: false,
      reason: "source_contract_mismatch",
      routeId: "about",
    });
  });

  it("distinguishes true public-fact absence from a malformed SiteBrief", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content: "公司名称：天印溯方。企业提供有来源记录的健康管理服务。",
          kind: "overview",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(visualSearchReadiness({ ...brief, verifiedFacts: [] })).toEqual({
      ready: false,
      reason: "no_public_facts",
    });
    expect(
      visualSearchReadiness({ ...brief, unexpectedProviderField: true }),
    ).toEqual({ ready: false, reason: "invalid_brief" });
  });

  it.each(["localhost", "127.0.0.1", "bad domain.com", "-bad.example"])(
    "rejects a non-registrable or unsafe domain: %s",
    (domain) => {
      expect(() => normalizeSiteOpsDomain(domain)).toThrow(SiteOpsServiceError);
    },
  );

  it("keeps message and structured-action inputs strict", () => {
    const message = {
      conversationId: "siteops:7",
      clientRequestId: "request-0001",
      text: "请突出企业服务能力",
      localAssetIds: [],
      expectedProjectRevision: 1,
    };
    expect(siteOpsSendMessageInputSchema.parse(message)).toEqual(message);
    expect(() =>
      siteOpsSendMessageInputSchema.parse({ ...message, apiKey: "secret" }),
    ).toThrow();

    expect(() =>
      siteOpsActInputSchema.parse({
        conversationId: "siteops:7",
        action: "pay_from_free_text",
        clientRequestId: "request-0002",
        expectedRevision: 1,
        input: {},
      }),
    ).toThrow();
  });

  it("keeps the customer build action free of API mode details", () => {
    const sampleId = "10000000-0000-4000-8000-000000000001";
    expect(parseSiteOpsActionPayload("select_visual", { sampleId })).toEqual({
      sampleId,
    });
    expect(parseSiteOpsActionPayload("delegate_visual", {})).toEqual({});
    expect(() =>
      parseSiteOpsActionPayload("select_visual", {
        sampleId,
        agentProfile: "frontmind-base",
      }),
    ).toThrow();
    expect(() =>
      parseSiteOpsActionPayload("delegate_visual", {
        agentProfile: "frontmind-pro",
      }),
    ).toThrow();
  });

  it("accepts server-selected knowledge binding while keeping old clients strict", () => {
    const snapshotId = "10000000-0000-4000-8000-000000000001";
    expect(parseSiteOpsActionPayload("select_snapshot", {})).toEqual({});
    expect(
      parseSiteOpsActionPayload("select_snapshot", {
        knowledgeSnapshotId: snapshotId,
      }),
    ).toEqual({ knowledgeSnapshotId: snapshotId });
    expect(() =>
      parseSiteOpsActionPayload("select_snapshot", {
        knowledgeSnapshotId: snapshotId,
        snapshotVersion: 7,
      }),
    ).toThrow();
  });

  it("rejects the legacy manual approval action before it can bypass atomic completion", () => {
    expect(() =>
      parseSiteOpsActionPayload("approve_build", {
        buildId: "10000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("官网制作和检查完成后会自动批准");
  });

  it("accepts a concise rebuild request without technical coordinates", () => {
    expect(
      parseSiteOpsActionPayload("request_rebuild", {
        reason: "希望重新梳理首页叙事。",
      }),
    ).toEqual({ reason: "希望重新梳理首页叙事。" });
    expect(() =>
      parseSiteOpsActionPayload("request_rebuild", {
        reason: "重制",
        buildId: "10000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("keeps frozen build profiles and QA coordinates out of customer reads", () => {
    const projected = siteOpsBuildProjectionSchema.parse({
      id: "10000000-0000-4000-8000-000000000001",
      ordinal: 2,
      parentBuildId: null,
      status: "building",
      previewUrl: null,
      sourceUrl: null,
      needsHelp: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(projected).not.toHaveProperty("agentProfile");
    expect(projected).not.toHaveProperty("qaUrl");
    expect(() =>
      siteOpsBuildProjectionSchema.parse({
        ...projected,
        agentProfile: "frontmind-base",
        qaUrl: "/internal/qa",
      }),
    ).toThrow();
  });

  it("keeps a parent build profile while rotating to the current customer credential", () => {
    expect(
      resolveSiteOpsAgentProfile({
        requested: "frontmind-base",
        credentialDefault: "frontmind-pro",
      }),
    ).toBe("frontmind-base");
    expect(
      resolveSiteOpsAgentProfile({
        parentOperationInput: { agentProfile: "frontmind-base" },
        credentialDefault: "frontmind-pro",
      }),
    ).toBe("frontmind-base");
    expect(
      resolveSiteOpsAgentProfile({ credentialDefault: "frontmind-base" }),
    ).toBe("frontmind-base");
    expect(resolveSiteOpsAgentProfile({ credentialDefault: null })).toBe(
      "frontmind-pro",
    );
    expect(
      freezeSiteOpsCustomerAiCredential({
        credential: {
          id: "20000000-0000-4000-8000-000000000002",
          version: 8,
          agentProfile: "frontmind-pro",
        },
        parentOperationInput: {
          agentProfile: "frontmind-base",
          manusCredentialId: "retired-credential",
        },
      }),
    ).toEqual({
      credentialScope: "customer",
      manusCredentialId: "20000000-0000-4000-8000-000000000002",
      manusCredentialVersion: 8,
      agentProfile: "frontmind-base",
    });
  });

  it("accepts only a selected Aliyun domain and normalizes its IDN identity", () => {
    expect(
      parseSiteOpsActionPayload("domain_sync", {
        domain: "例子.公司",
      }),
    ).toEqual({
      domain: "xn--fsqu00a.xn--55qx5d",
      domainUnicode: "例子.公司",
    });
    expect(() =>
      parseSiteOpsActionPayload("domain_sync", {
        domain: "example.com",
        typedDomain: "example.com",
      }),
    ).toThrow();
    expect(() =>
      parseSiteOpsActionPayload("domain_sync", {
        domain: "example.com",
        accessKeySecret: "must-not-be-accepted",
      }),
    ).toThrow();
  });

  it("keeps the Aliyun OAuth connection boundary free of account secrets", () => {
    expect(() =>
      siteOpsAliyunConnectionInputSchema.parse({
        conversationId: "siteops:7",
        accessKeySecret: "must-not-be-accepted",
      }),
    ).toThrow();
    expect(
      siteOpsAliyunConnectionInputSchema.parse({ conversationId: "siteops:7" }),
    ).toEqual({ conversationId: "siteops:7" });
  });

  it("pins a selected board to its original 21st credential after rotation or deletion", async () => {
    const visualOperationId = "10000000-0000-4000-8000-000000000001";
    const pinnedCredentialId = "20000000-0000-4000-8000-000000000002";
    const snapshotId = "30000000-0000-4000-8000-000000000003";
    const results = [
      [
        {
          input: {
            knowledgeSnapshotId: snapshotId,
            credentialId: pinnedCredentialId,
            credentialVersion: 7,
            workflowVersion: SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
          },
        },
      ],
      [{ id: pinnedCredentialId, version: 7, status: "deleted" }],
    ];
    let cursor = 0;
    const tx = {
      select: vi.fn(() => {
        const rows = results[cursor++] ?? [];
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: async () => rows,
        };
        return chain;
      }),
    };

    await expect(
      resolvePinnedTwentyFirstCredentialForBatch(tx, {
        engineerNote: `siteops-21st-operation:${visualOperationId}`,
        projectId: "40000000-0000-4000-8000-000000000004",
        userId: 42,
        knowledgeSnapshotId: snapshotId,
      }),
    ).resolves.toMatchObject({ id: pinnedCredentialId, version: 7 });
  });

  it.each(["reserved", "deploying", "verifying"] as const)(
    "rejects a second ESA admission while the same target is %s",
    async (status) => {
      const forUpdate = vi.fn().mockResolvedValue([
        {
          id: "10000000-0000-4000-8000-000000000001",
          buildId: "20000000-0000-4000-8000-000000000002",
          intent: "deploy",
          status,
        },
      ]);
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({ for: forUpdate })),
            })),
          })),
        })),
      };

      await expect(
        assertSiteOpsDeploymentTargetAvailable(tx, {
          projectId: "30000000-0000-4000-8000-000000000003",
          target: "global_excluding_cn",
        }),
      ).rejects.toMatchObject({
        code: "STATE_CONFLICT",
        statusCode: 409,
      });
      expect(forUpdate).toHaveBeenCalledWith("update");
    },
  );

  it("admits an ESA target when no deployment is in flight", async () => {
    const forUpdate = vi.fn().mockResolvedValue([]);
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      })),
    };

    await expect(
      assertSiteOpsDeploymentTargetAvailable(tx, {
        projectId: "30000000-0000-4000-8000-000000000003",
        target: "mainland_cn",
      }),
    ).resolves.toBeUndefined();
  });

  it("ships one contract migration that removes commerce and rebuilds the OAuth connection", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "drizzle/0065_siteops_alidns_oauth.sql"),
      "utf8",
    );
    expect(sql).toContain("DROP TABLE `site_domain_operations`");
    expect(sql).toContain("DROP TABLE `site_provider_connections`");
    expect(sql).toContain("'domain_sync','dns_apply','dns_rollback'");
    expect(sql).toContain("`oauth_credential_id` varchar(36) NOT NULL");
    expect(sql).toContain("`encrypted_refresh_token` text NOT NULL");
    expect(sql).toContain("`status` enum('active','invalid','revoked')");
    expect(sql).toContain("`current_task_started_at` timestamp NOT NULL");
    expect(sql).toContain("`minimum_knowledge_snapshot_version` int unsigned");
    expect(sql).not.toContain("`active_financial_key`");
  });
});
