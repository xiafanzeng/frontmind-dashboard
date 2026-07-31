import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import KnowledgeBaseLivePreview from "./KnowledgeBaseLivePreview";

function jsonResponse(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("KnowledgeBaseLivePreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("submits the company and renders only sanitized customer markdown", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = String(input);
        if (url.endsWith("/configuration")) {
          return jsonResponse({ serverCredentialConfigured: true });
        }
        if (url.endsWith("/start") && init?.method === "POST") {
          return jsonResponse(
            {
              sessionId: "session-1",
              analysis: {
                runMode: "full",
                taskId: "task-1",
                status: "completed",
                terminal: true,
                outputCount: 1,
                assistantCharacterCount: 400,
                visibleCharacterCount: 52,
                visibleMarkdown:
                  '## 企业定位\n\nFrontMind 超前智能提供 AI 原生品牌增长服务。\n\n<!--SOCRATIC_KB_STATE\n{"revision":0}\nSOCRATIC_KB_STATE-->',
                rawAssistantText:
                  '## 企业定位\n{"kind":"frontmind.knowledge-base.manifest"}',
                protocolKinds: ["frontmind.knowledge-base.manifest"],
                legacySocraticStateCount: 1,
                protocolObjects: [
                  { kind: "frontmind.knowledge-base.manifest" },
                ],
                diagnostics: [
                  {
                    kind: "frontmind.knowledge-base.manifest",
                    count: 1,
                    valid: true,
                    authoritative: true,
                  },
                ],
                manifest: {
                  leafCount: 85,
                  branchCount: 8,
                  branchCounts: [{ title: "企业身份", leafCount: 9 }],
                  firstLeaf: { id: "1.1", title: "企业定位" },
                  lastLeaf: { id: "8.9", title: "人才发展与社会责任" },
                  leaves: [],
                },
                issues: [],
              },
            },
            201,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

    render(<KnowledgeBaseLivePreview />);
    fireEvent.click(await screen.findByRole("button", { name: "构建知识库" }));

    const customerSection = (
      await screen.findByRole("heading", { name: "客户可见渲染" })
    ).closest("section");
    expect(customerSection).not.toBeNull();
    expect(
      within(customerSection as HTMLElement).getByText(
        "FrontMind 超前智能提供 AI 原生品牌增长服务。",
      ),
    ).toBeInTheDocument();
    expect(customerSection).not.toHaveTextContent(
      "frontmind.knowledge-base.manifest",
    );
    expect(customerSection).not.toHaveTextContent("SOCRATIC_KB_STATE");
    expect(
      screen.getByText(/检测到 1 个旧 SOCRATIC 状态对象/),
    ).toBeInTheDocument();
    expect(screen.getByText("85")).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const startCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(startCall[1]?.body))).toMatchObject({
      mode: "full",
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
    });
  });

  it("starts the isolated real API protocol probe", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = String(input);
        if (url.endsWith("/configuration")) {
          return jsonResponse({ serverCredentialConfigured: true });
        }
        if (url.endsWith("/start") && init?.method === "POST") {
          return jsonResponse(
            {
              sessionId: "probe-session",
              analysis: {
                runMode: "protocol_probe",
                taskId: "probe-task",
                status: "completed",
                terminal: true,
                outputCount: 1,
                assistantCharacterCount: 600,
                visibleCharacterCount: 6,
                visibleMarkdown: "协议探针响应",
                rawAssistantText: "协议探针响应",
                protocolKinds: ["frontmind.knowledge-base.manifest"],
                legacySocraticStateCount: 0,
                protocolObjects: [],
                diagnostics: [],
                manifest: {
                  leafCount: 8,
                  branchCount: 8,
                  branchCounts: [{ title: "企业身份", leafCount: 1 }],
                  firstLeaf: { id: "1.1", title: "企业定位" },
                  lastLeaf: { id: "8.1", title: "合作与支持" },
                  leaves: [],
                },
                issues: [],
              },
            },
            201,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

    render(<KnowledgeBaseLivePreview />);
    fireEvent.click(
      await screen.findByRole("button", { name: "快速协议探针" }),
    );

    expect(
      await screen.findByText("真实协议探针：completed"),
    ).toBeInTheDocument();
    const startCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(startCall[1]?.body))).toMatchObject({
      mode: "protocol_probe",
      companyName: "FrontMind超前智能",
    });
  });

  it("replays a captured real response through the customer renderer", async () => {
    const realOutput =
      "## 1.1 企业定位\n\nFrontMind 超前智能\n\n<!--SOCRATIC_KB_STATE\n" +
      '{"knowledgeTree":{"branches":9,"leaves":52}}\n' +
      "SOCRATIC_KB_STATE-->";
    window.history.replaceState(
      null,
      "",
      `/preview/knowledge-base-live?taskId=real-task&outputCount=3&replay=${encodeURIComponent(realOutput)}`,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).endsWith("/configuration")) {
        return jsonResponse({ serverCredentialConfigured: true });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<KnowledgeBaseLivePreview />);

    expect(
      await screen.findByRole("heading", { name: "1.1 企业定位" }),
    ).toBeInTheDocument();
    const customerSection = screen
      .getByRole("heading", { name: "客户可见渲染" })
      .closest("section");
    expect(customerSection).not.toHaveTextContent("SOCRATIC_KB_STATE");
    expect(screen.getByText("real-task")).toBeInTheDocument();
    expect(
      screen.getByText(/检测到 1 个旧 SOCRATIC 状态对象/),
    ).toBeInTheDocument();
  });
});
