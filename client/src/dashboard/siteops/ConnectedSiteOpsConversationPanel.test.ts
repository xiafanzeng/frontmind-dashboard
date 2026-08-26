import { describe, expect, it } from "vitest";

import {
  newestSiteOpsObservation,
  shouldPollSiteOpsObservation,
  siteOpsClientRequestId,
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
});
