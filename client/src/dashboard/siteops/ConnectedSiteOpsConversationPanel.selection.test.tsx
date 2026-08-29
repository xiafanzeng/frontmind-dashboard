import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SiteOpsObservationV1 } from "@shared/siteops-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openObservation: null as SiteOpsObservationV1 | null,
  actFast: vi.fn(),
  actReset: vi.fn(),
  observeRefetch: vi.fn(),
  observeOptions: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      siteOps: {
        open: {
          useMutation: (options: {
            onSuccess?: (value: SiteOpsObservationV1) => void;
          }) => ({
            mutate: () => {
              if (mocks.openObservation) {
                options.onSuccess?.(mocks.openObservation);
              }
            },
            mutateAsync: async () => mocks.openObservation,
            isPending: false,
            error: null,
          }),
        },
        observe: {
          useQuery: (_input: unknown, options: Record<string, unknown>) => {
            mocks.observeOptions = options;
            return {
              data: null,
              error: null,
              isFetching: false,
              refetch: mocks.observeRefetch,
            };
          },
        },
        actFast: {
          useMutation: () => ({
            mutateAsync: mocks.actFast,
            reset: mocks.actReset,
            error: null,
          }),
        },
        aliyunConnection: {
          beginOAuth: {
            useMutation: () => ({
              mutateAsync: vi.fn(),
              error: null,
            }),
          },
          listDomains: {
            useQuery: () => ({
              data: { domains: [] },
              isLoading: false,
              error: null,
              refetch: vi.fn(),
            }),
          },
          disconnect: {
            useMutation: () => ({
              mutateAsync: vi.fn(),
              error: null,
            }),
          },
        },
      },
    },
  },
}));

import ConnectedSiteOpsConversationPanel from "./ConnectedSiteOpsConversationPanel";

function staticCatalogObservation(): SiteOpsObservationV1 {
  const pages = Array.from({ length: 4 }, (_, pageIndex) => {
    const page = pageIndex + 1;
    return {
      batchId: `00000000-0000-4000-8000-00000000000${page}`,
      page,
      candidates: Array.from({ length: 8 }, (_, candidateIndex) => {
        const label = String.fromCharCode(65 + candidateIndex);
        return {
          id: `static-candidate-${page}-${label}`,
          label,
          title: `固定目录第 ${page} 页 ${label}`,
          previewUrl: `/api/site-ops/style-previews/static-${page}-${label}`,
          note: null,
          visualFamily: null,
          selected: false,
        };
      }),
    };
  });
  return {
    schemaVersion: 1,
    executionKind: "site_ops",
    serviceReadiness: {
      visuals: { status: "configured" },
      website: { status: "configured" },
      publishing: { status: "configured" },
      domain: { status: "not_configured" },
    },
    aliyunConnection: {
      configured: false,
      status: "not_connected",
      verifiedAt: null,
      canDisconnect: true,
    },
    domainState: null,
    project: {
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "siteops:selection-test",
      revision: 3,
      status: "awaiting_visual_selection",
      currentKnowledgeSnapshotId: "22222222-2222-4222-8222-222222222222",
      primaryLanguage: "zh-CN",
      canonicalHostname: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
    },
    brief: null,
    knowledgeSnapshots: [],
    messages: [
      {
        id: "visual-board-message",
        role: "assistant",
        content: "请选择一个建站模板。",
        sequence: 1,
        metadata: {
          siteOps: {
            kind: "visual_board",
            subjectId: pages[0]!.batchId,
            revision: 3,
            status: "active",
            payload: {},
          },
        },
        sentAt: "2026-08-29T00:00:00.000Z",
      },
    ],
    visualCandidates: pages[0]!.candidates,
    visualCandidatePages: pages as SiteOpsObservationV1["visualCandidatePages"],
    visualGeneration: {
      status: "idle",
      targetPage: null,
      generatedPages: 4,
      availablePages: 4,
      reservedPages: 0,
      maxPages: 4,
      workflowVersion: "2.8.0",
      catalogVersion: "twenty-first-static-32-v1",
      pageSize: 8,
      pageCount: 4,
      canGenerateMore: false,
      canSelectExisting: true,
    },
    executionSteps: [],
    builds: [],
    deployments: [],
    socialPackages: [],
    rebuildRequest: {
      allowed: false,
      ticketId: null,
      status: null,
      resetApplied: false,
      resetPending: false,
      resetSourceBuildId: null,
    },
    interactionState: "awaiting_visual_selection",
    latestSequence: 1,
  };
}

function acceptedAck(clientRequestId: string) {
  return {
    schemaVersion: 1 as const,
    accepted: true as const,
    clientRequestId,
    operationId: "33333333-3333-4333-8333-333333333333",
    projectRevision: 4,
    latestSequence: 3,
    interactionState: "building" as const,
  };
}

describe("ConnectedSiteOpsConversationPanel select_visual", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openObservation = staticCatalogObservation();
    mocks.observeRefetch.mockResolvedValue({
      data: mocks.openObservation,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses ten rapid clicks into one exact request and locks choices on every page", async () => {
    vi.useFakeTimers();
    let resolveAck: ((value: ReturnType<typeof acceptedAck>) => void) | null =
      null;
    mocks.actFast.mockImplementation(
      (input: { clientRequestId: string }) =>
        new Promise((resolve) => {
          resolveAck = resolve;
        }),
    );
    render(<ConnectedSiteOpsConversationPanel />);

    const pageOneF = screen.getByRole("button", { name: "选择 F" });
    act(() => {
      for (let index = 0; index < 10; index += 1) {
        pageOneF.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });

    expect(mocks.actFast).toHaveBeenCalledOnce();
    expect(mocks.actFast).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        action: "select_visual",
        input: { sampleId: "static-candidate-1-F" },
      }),
    );
    expect(screen.getByRole("button", { name: "正在选择 F" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "第 4 页" }));
    const pageFourChoices = screen.getAllByRole("button", {
      name: /^选择 [A-H]$/u,
    });
    expect(pageFourChoices).toHaveLength(8);
    expect(
      pageFourChoices.every((button) => button.hasAttribute("disabled")),
    ).toBe(true);

    const request = mocks.actFast.mock.calls[0]![0] as {
      clientRequestId: string;
    };
    await act(async () => {
      resolveAck?.(acceptedAck(request.clientRequestId));
      await Promise.resolve();
    });
  });

  it("shows the exact board-adjacent failure and retries with the same request id", async () => {
    mocks.actFast.mockRejectedValue(new Error("network failed"));
    render(<ConnectedSiteOpsConversationPanel />);

    fireEvent.click(screen.getByRole("button", { name: "第 4 页" }));
    fireEvent.click(screen.getByRole("button", { name: "选择 F" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "建站任务未能创建，所选模板尚未生效。无需重新载入模板，请重试选择 F。",
    );
    const failedCandidateButton = screen.getByRole("button", {
      name: "选择 F",
    });
    expect(failedCandidateButton).toBeDisabled();
    fireEvent.click(failedCandidateButton);
    expect(mocks.actFast).toHaveBeenCalledOnce();
    const firstRequest = mocks.actFast.mock.calls[0]![0] as {
      clientRequestId: string;
      input: { sampleId: string };
    };
    expect(firstRequest.input.sampleId).toBe("static-candidate-4-F");

    fireEvent.click(screen.getByRole("button", { name: "重试选择 F" }));
    await waitFor(() => expect(mocks.actFast).toHaveBeenCalledTimes(2));
    const retryRequest = mocks.actFast.mock.calls[1]![0] as {
      clientRequestId: string;
      input: { sampleId: string };
    };
    expect(retryRequest.clientRequestId).toBe(firstRequest.clientRequestId);
    expect(retryRequest.input).toEqual(firstRequest.input);
  });

  it("observes serially at 1s, 2s and 5s before handing off to polling", async () => {
    vi.useFakeTimers();
    mocks.actFast.mockImplementation(
      async (input: { clientRequestId: string }) =>
        acceptedAck(input.clientRequestId),
    );
    render(<ConnectedSiteOpsConversationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "选择 F" }));
      await Promise.resolve();
    });
    expect(mocks.observeRefetch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(mocks.observeRefetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.observeRefetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.observeRefetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(mocks.observeRefetch).toHaveBeenCalledTimes(3);
    expect(mocks.observeOptions?.refetchInterval).toBe(5_000);
    expect(screen.getByText("已提交，状态同步延迟")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在选择 F" })).toBeDisabled();

    const request = mocks.actFast.mock.calls[0]![0] as {
      clientRequestId: string;
    };
    const ack = acceptedAck(request.clientRequestId);
    const oldObservation = mocks.openObservation!;
    const matchingObservation: SiteOpsObservationV1 = {
      ...oldObservation,
      project: {
        ...oldObservation.project,
        revision: ack.projectRevision,
        status: "building",
        updatedAt: "2026-08-29T00:00:01.000Z",
      },
      messages: [
        ...oldObservation.messages,
        {
          id: "build-progress-message",
          role: "assistant",
          content: "正在创建官网。",
          sequence: ack.latestSequence,
          metadata: {
            siteOps: {
              kind: "build_progress",
              subjectId: ack.operationId,
              revision: ack.projectRevision,
              status: "active",
              payload: { stage: "preparing" },
            },
          },
          sentAt: "2026-08-29T00:00:01.000Z",
        },
      ],
      interactionState: "building",
      latestSequence: ack.latestSequence,
    };
    mocks.observeRefetch.mockResolvedValue({ data: matchingObservation });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "刷新AI友好官网管理" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("已提交，状态同步延迟")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "已选择的视觉方案" }),
    ).toBeInTheDocument();
  });
});
