import { describe, expect, it } from "vitest";

import {
  newestSiteOpsObservation,
  shouldPollSiteOpsObservation,
  siteOpsClientRequestId,
  siteOpsPollIntervalMs,
} from "./ConnectedSiteOpsConversationPanel";

describe("connected SiteOps request identity", () => {
  it("uses the delivery-compatible UUID form without a namespace prefix", () => {
    const requestId = siteOpsClientRequestId();

    expect(requestId).toHaveLength(36);
    expect(requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(requestId).not.toContain("siteops-");
  });

  it("keeps polling while an approved reset is unpublishing the old site", () => {
    expect(
      shouldPollSiteOpsObservation({
        interactionState: "attention_required",
        rebuildRequest: { resetPending: true },
        visualGeneration: { status: "idle" },
        deployments: [],
        domainState: null,
        socialPackages: [],
      } as never),
    ).toBe(true);
  });

  it.each(["submitted", "scheduled", "in_progress"] as const)(
    "keeps polling while rebuild request status is %s",
    (status) => {
      expect(
        shouldPollSiteOpsObservation({
          interactionState: "attention_required",
          rebuildRequest: { status, resetPending: false },
          visualGeneration: { status: "idle" },
          deployments: [],
          domainState: null,
          socialPackages: [],
        } as never),
      ).toBe(true);
    },
  );

  it("polls the initial domain sync from the current customer-facing card", () => {
    const pending = {
      interactionState: "approved",
      project: { revision: 9 },
      rebuildRequest: { status: null, resetPending: false },
      visualGeneration: { status: "idle" },
      deployments: [],
      messages: [
        {
          metadata: {
            siteOps: {
              kind: "domain_status",
              status: "active",
              revision: 9,
              payload: { action: "domain_sync" },
            },
          },
        },
      ],
      domainState: null,
      socialPackages: [],
    } as never;

    expect(shouldPollSiteOpsObservation(pending)).toBe(true);
    expect(
      shouldPollSiteOpsObservation({
        ...pending,
        project: { revision: 10 },
      } as never),
    ).toBe(false);
  });

  it("accepts only forward rebuild transitions at an equal cursor", () => {
    const observation = (status: "submitted" | "scheduled" | "in_progress") =>
      ({
        project: { revision: 8 },
        latestSequence: 12,
        rebuildRequest: {
          status,
          resetPending: status !== "submitted",
          resetApplied: false,
        },
        visualGeneration: { status: "idle" },
      }) as never;
    const submitted = observation("submitted");
    const scheduled = observation("scheduled");
    const running = observation("in_progress");

    expect(newestSiteOpsObservation(submitted, scheduled)).toBe(scheduled);
    expect(newestSiteOpsObservation(scheduled, running)).toBe(running);
    expect(newestSiteOpsObservation(running, submitted)).toBe(running);
  });

  it("backs active polling off progressively and reconciles fallback at one minute", () => {
    const active = {
      interactionState: "building",
      rebuildRequest: { status: null, resetPending: false },
      visualGeneration: { status: "idle" },
      builds: [],
      deployments: [],
      messages: [],
      domainState: null,
      socialPackages: [],
    } as never;
    expect(siteOpsPollIntervalMs(active, 0)).toBe(5_000);
    expect(siteOpsPollIntervalMs(active, 60_000)).toBe(10_000);
    expect(siteOpsPollIntervalMs(active, 5 * 60_000)).toBe(20_000);
    expect(siteOpsPollIntervalMs(active, 30 * 60_000)).toBe(30_000);

    expect(
      siteOpsPollIntervalMs(
        {
          ...active,
          builds: [
            {
              buildDelivery: { renderMode: "trusted_fallback" },
              recoverable: true,
            },
          ],
        } as never,
        0,
      ),
    ).toBe(60_000);
    expect(
      siteOpsPollIntervalMs(
        {
          ...active,
          builds: [
            {
              buildDelivery: { renderMode: "trusted_fallback" },
              recoverable: false,
            },
          ],
        } as never,
        0,
      ),
    ).toBe(false);
  });

  it("accepts equal-cursor fallback progress and rejects its late predecessor", () => {
    const base = {
      project: {
        revision: 8,
        updatedAt: "2026-08-27T04:00:00.000Z",
      },
      latestSequence: 12,
      interactionState: "building",
      rebuildRequest: {
        status: null,
        resetPending: false,
        resetApplied: false,
      },
      visualGeneration: { status: "idle" },
      deployments: [],
    };
    const validating = {
      ...base,
      builds: [
        {
          id: "build-1",
          buildPhase: "source_validating",
          buildDelivery: null,
          updatedAt: "2026-08-27T04:00:05.000Z",
        },
      ],
    } as never;
    const fallback = {
      ...base,
      builds: [
        {
          id: "build-1",
          buildPhase: "provider_sync_delayed",
          buildDelivery: { renderMode: "trusted_fallback" },
          updatedAt: "2026-08-27T04:00:06.000Z",
        },
      ],
    } as never;

    expect(newestSiteOpsObservation(validating, fallback)).toBe(fallback);
    expect(newestSiteOpsObservation(fallback, validating)).toBe(fallback);
  });
});
