import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRefetch: vi.fn(),
  detailRefetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/admin/workspace", vi.fn()],
}));

vi.mock("@/lib/frontmind-api", () => ({
  uploadFile: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    admin: {
      deliveryTickets: {
        list: {
          useInfiniteQuery: () => ({
            data: {
              pages: [
                {
                  tickets: [],
                  quotas: {},
                  nextCursor: null,
                },
              ],
            },
            refetch: mocks.listRefetch,
            fetchNextPage: vi.fn(),
            hasNextPage: false,
            isFetchingNextPage: false,
            isLoading: false,
            isError: false,
            error: null,
          }),
        },
        detail: {
          useQuery: () => ({
            data: null,
            refetch: mocks.detailRefetch,
            isLoading: false,
            isError: false,
            error: null,
          }),
        },
        adjustQuota: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        update: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        addMessage: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        recordDelivery: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
      },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

import AdminDeliveryTicketWorkspace from "./AdminDeliveryTicketWorkspace";

describe("AdminDeliveryTicketWorkspace website current-content template UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:website-current-template"),
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("downloads, preflights, confirms the diff and publishes the exact same file", async () => {
    const fileHash = "c".repeat(64);
    const preflightToken = "signed-website-content-preflight-token";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            format: "frontmind.website-content-template.v1",
            workspaceUserId: 42,
            records: [],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition":
                'attachment; filename="frontmind-website-content-current-42.json"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "website-content-template-preview",
            preview: {
              fileHash,
              workspaceUserId: 42,
              totals: {
                records: 1,
                changed: 1,
                completing: 1,
                summariesUpdated: 1,
                unchanged: 0,
              },
              changes: [
                {
                  ticketId: "970b87d8-d4f4-45db-8f11-44c45f52ade9",
                  revision: 3,
                  category: "company_facts",
                  categoryLabel: "企业资料与品牌事实",
                  topic: "更新企业品牌事实",
                  currentComplete: false,
                  incomingComplete: true,
                  currentPublicSummary: "",
                  incomingPublicSummary: "已完成企业品牌事实页面更新。",
                  change: "complete",
                },
              ],
              preflightToken,
              preflightExpiresAt: "2099-07-28T00:00:00.000Z",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "website-content-template",
            result: { success: true, changed: 1 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminDeliveryTicketWorkspace
        userId={42}
        enterpriseName="测试企业"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "下载当前内容模板" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/website-content-template/42",
      { credentials: "include" },
    ]);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();

    const card = screen.getByText("官网内容当前模板").closest("section");
    expect(card).not.toBeNull();
    const file = new File(
      [
        JSON.stringify({
          format: "frontmind.website-content-template.v1",
          workspaceUserId: 42,
        }),
      ],
      "官网内容当前模板.json",
      { type: "application/json" },
    );
    fireEvent.change(
      card!.querySelector<HTMLInputElement>('input[type="file"]')!,
      { target: { files: [file] } },
    );

    expect(await screen.findByText("发布前差异确认")).toBeInTheDocument();
    expect(screen.getByText("已完成企业品牌事实页面更新。")).toBeInTheDocument();
    expect(mocks.listRefetch).not.toHaveBeenCalled();

    const previewOptions = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(previewOptions.method).toBe("PUT");
    expect(previewOptions.body).toBe(file);
    expect(previewOptions.headers).toEqual(
      expect.objectContaining({
        "X-Import-Preview": "true",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const publishOptions = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(publishOptions.method).toBe("PUT");
    expect(publishOptions.body).toBe(file);
    expect(publishOptions.headers).toEqual(
      expect.objectContaining({
        "X-Import-File-Hash": fileHash,
        "X-Import-Preflight-Token": preflightToken,
      }),
    );
    expect(
      (publishOptions.headers as Record<string, string>)["X-Import-Preview"],
    ).toBeUndefined();
    await waitFor(() => expect(mocks.listRefetch).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "官网内容已发布",
      expect.objectContaining({
        description: "1 条工单在同一事务中完成更新。",
      }),
    );
  });
});
