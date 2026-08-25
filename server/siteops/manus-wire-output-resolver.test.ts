import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  resolveSiteOpsWireOutput as resolveWireOutput,
  SITEOPS_WIRE_OUTPUT_FILES,
  SiteOpsWireOutputResolutionError,
} from "./manus-wire-output-resolver";

const token = "siteops-design:10000000-0000-4000-8000-000000000001";

function resolveSiteOpsWireOutput(
  input: Omit<
    Parameters<typeof resolveWireOutput>[0],
    "phase" | "expectedFilename"
  >,
) {
  return resolveWireOutput({
    ...input,
    phase: "design",
    expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.design,
  });
}

function marker(operationToken = token, timestamp = 1) {
  return {
    id: `marker-${timestamp}`,
    type: "user_message",
    timestamp,
    user_message: {
      content: `instruction\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
    },
  };
}

function rejected(timestamp = 2) {
  return {
    id: `rejected-${timestamp}`,
    type: "structured_output_result",
    timestamp,
    structured_output_result: {
      success: false,
      value: 0,
      error: "structured extraction failed",
    },
  };
}

function rejectedWithoutValue(timestamp = 2) {
  return {
    id: `rejected-no-value-${timestamp}`,
    type: "structured_output_result",
    timestamp,
    structured_output_result: {
      success: false,
      error: "structured extraction failed",
    },
  };
}

function assistant(
  input: { content?: unknown; attachments?: unknown[] },
  timestamp = 3,
) {
  return {
    id: `assistant-${timestamp}`,
    type: "assistant_message",
    timestamp,
    assistant_message: input,
  };
}

function accepted(value: unknown, timestamp = 3) {
  return {
    id: `structured-${timestamp}`,
    type: "structured_output_result",
    timestamp,
    structured_output_result: { success: true, value },
  };
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
  });
}

describe("SiteOps wire output resolver", () => {
  it("accepts the exact V3 design filename when the React workflow requests it", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 3,
      siteTitle: "可信 React 静态官网",
    };
    await expect(
      resolveWireOutput({
        events: [marker(), accepted(value)] as never,
        operationToken: token,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.designV3,
        taskCompleted: true,
      }),
    ).resolves.toMatchObject({ value, source: "structured" });
  });

  it("uses the strict attachment fallback after rejection without a value", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    await expect(
      resolveSiteOpsWireOutput({
        events: [
          marker(),
          rejectedWithoutValue(),
          assistant({
            attachments: [
              {
                filename: SITEOPS_WIRE_OUTPUT_FILES.design,
                content_type: "application/json",
                url: "https://files.example.test/result.json",
              },
            ],
          }),
        ] as never,
        operationToken: token,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).resolves.toMatchObject({ value, source: "attachment" });
  });

  it("waits for phase completion before accepting an explicit structured success", async () => {
    const fetchPinned = vi.fn();
    const value = {
      operationToken: token,
      schemaVersion: 1,
      siteTitle: "可信",
    };
    const result = await resolveSiteOpsWireOutput({
      events: [marker(), accepted(value)] as never,
      operationToken: token,
      taskCompleted: false,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toBeNull();
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("prefers an explicit structured success after the task stops", async () => {
    const fetchPinned = vi.fn();
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const result = await resolveSiteOpsWireOutput({
      events: [marker(), accepted(value)] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toMatchObject({ value, source: "structured" });
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("does not treat a zero extraction value as success or inspect fallback while running", async () => {
    const fetchPinned = vi.fn();
    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json?token=secret",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: false,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toBeNull();
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("accepts a stopped URL-only JSON attachment without file_id and never returns its signed URL", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 1,
      siteTitle: "可信",
    };
    const signedUrl =
      "https://files.example.test/result.json?signature=do-not-persist";
    const fetchPinned = vi.fn(async (input: { url: string }) => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
      observedUrl: input.url,
    }));
    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              url: signedUrl,
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toMatchObject({ value, source: "attachment" });
    expect(fetchPinned.mock.calls[0]![0].url).toBe(signedUrl);
    expect(fetchPinned.mock.calls[0]![0]).toMatchObject({
      maxRedirects: 3,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
      },
    });
    expect(JSON.stringify(result)).not.toContain("do-not-persist");
  });

  it("accepts the narrow provider filename normalization and repair suffix seen in production", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));

    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: "frontmind_site_design_wire_v2_repair_1.json",
              content_type: "application/json",
              url: "https://files.example.test/result.json?signature=secret",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toMatchObject({ value, source: "attachment" });
  });

  it("normalizes only the requested PageContentWire V3 attachment stem", async () => {
    const contentToken = "siteops-content:10000000-0000-4000-8000-000000000001";
    const value = { operationToken: contentToken, schemaVersion: 3 };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/content-v3.json"),
    }));

    await expect(
      resolveWireOutput({
        events: [
          marker(contentToken),
          rejected(),
          assistant({
            attachments: [
              {
                filename: "frontmind_page_content_wire_v3_repair_2.json",
                content_type: "application/json",
                url: "https://files.example.test/content-v3.json",
              },
            ],
          }),
        ] as never,
        operationToken: contentToken,
        phase: "content",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentV3,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).resolves.toMatchObject({ value, source: "attachment" });
  });

  it("accepts valid assistant JSON without requiring provider rejection but keeps the exact token window", async () => {
    const fetchPinned = vi.fn();
    const body = JSON.stringify({ operationToken: token, schemaVersion: 1 });
    const resultWithoutRejection = await resolveSiteOpsWireOutput({
      events: [marker(), assistant({ content: body })] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });
    const resultFromOldWindow = await resolveSiteOpsWireOutput({
      events: [
        marker(token, 1),
        rejected(2),
        assistant({ content: body }, 3),
        marker("siteops-content:other", 4),
      ] as never,
      operationToken: "siteops-content:other",
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(resultWithoutRejection).toMatchObject({
      source: "assistant_json",
      value: JSON.parse(body),
    });
    expect(resultFromOldWindow).toBeNull();
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("does not let a structured-result token cut the user-message causal window", async () => {
    const value = { operationToken: token, schemaVersion: 2 };
    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        accepted(
          {
            operationToken: "siteops-content:other",
            schemaVersion: 2,
          },
          3,
        ),
        assistant({ content: JSON.stringify(value) }, 4),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });

    expect(result).toMatchObject({ value, source: "assistant_json" });
  });

  it("ignores URL attachments without a phase-owned filename", async () => {
    const fetchPinned = vi.fn();
    for (const attachment of [
      { url: "https://files.example.test/result.json" },
      {
        filename: "arbitrary-result.json",
        content_type: "application/json",
        url: "https://files.example.test/result.json",
      },
    ]) {
      await expect(
        resolveSiteOpsWireOutput({
          events: [
            marker(),
            rejectedWithoutValue(),
            assistant({ attachments: [attachment] }),
          ] as never,
          operationToken: token,
          taskCompleted: true,
          fetchPinned: fetchPinned as never,
        }),
      ).resolves.toBeNull();
    }
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("accepts only whole JSON or one pure json fence from assistant text", async () => {
    const value = { operationToken: token, schemaVersion: 1 };
    const whole = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({ content: JSON.stringify(value) }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const fenced = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({ content: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const directObject = await resolveSiteOpsWireOutput({
      events: [marker(), assistant({ content: value })] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const prose = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({
          content: `结果如下：\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });

    expect(whole?.source).toBe("assistant_json");
    expect(fenced?.source).toBe("assistant_json");
    expect(directObject?.source).toBe("assistant_json");
    expect(prose).toBeNull();
  });

  it("validates rejected structured values and merges identical production fallback sources", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    const resolution = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        {
          id: "production-rejected-value",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: {
            success: false,
            value,
            error: { code: "schema_extraction_failed" },
          },
        },
        assistant({
          content: value,
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
      validateCandidate: (candidate) => {
        if (candidate.schemaVersion !== 2) throw new Error("invalid");
      },
    });

    expect(resolution).toMatchObject({
      value,
      source: "structured",
      sources: ["structured", "assistant_json", "attachment"],
    });
    expect(resolution?.byteCount).toBeGreaterThan(0);
  });

  it("drops schema-invalid sources before conflict comparison", async () => {
    const invalid = { operationToken: token, schemaVersion: 1, siteTitle: "A" };
    const valid = { operationToken: token, schemaVersion: 2, siteTitle: "B" };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(valid),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    const resolution = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        accepted(invalid),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
      validateCandidate: (candidate) => {
        if (candidate.schemaVersion !== 2)
          throw new Error("WIRE_SCHEMA_INVALID");
      },
    });

    expect(resolution).toMatchObject({ value: valid, source: "attachment" });
  });

  it("does not let an accepted structured result bypass a conflicting attachment", async () => {
    const first = { operationToken: token, schemaVersion: 1, siteTitle: "A" };
    const second = { operationToken: token, schemaVersion: 1, siteTitle: "B" };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(second),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));

    await expect(
      resolveSiteOpsWireOutput({
        events: [
          marker(),
          accepted(first),
          assistant({
            attachments: [
              {
                filename: SITEOPS_WIRE_OUTPUT_FILES.design,
                content_type: "application/json",
                url: "https://files.example.test/result.json",
              },
            ],
          }),
        ] as never,
        operationToken: token,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).rejects.toMatchObject({ code: "SITEOPS_WIRE_OUTPUT_CONFLICT" });
  });

  it("enforces response MIME, root object, UTF-8 and a declared raw hash", async () => {
    const value = { operationToken: token, schemaVersion: 1 };
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const baseEvents = (sha256: string) =>
      [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json",
              sha256,
            },
          ],
        }),
      ] as never;
    const goodFetch = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    await expect(
      resolveSiteOpsWireOutput({
        events: baseEvents(expectedSha256),
        operationToken: token,
        taskCompleted: true,
        fetchPinned: goodFetch as never,
      }),
    ).resolves.toMatchObject({ value });

    for (const response of [
      new Response(JSON.stringify(value), {
        headers: { "content-type": "text/plain" },
      }),
      jsonResponse([value]),
      new Response(Uint8Array.of(0xff, 0xfe), {
        headers: { "content-type": "application/json" },
      }),
    ]) {
      const fetchPinned = vi.fn(async () => ({
        response,
        finalUrl: new URL("https://files.example.test/result.json"),
      }));
      await expect(
        resolveSiteOpsWireOutput({
          events: baseEvents(expectedSha256),
          operationToken: token,
          taskCompleted: true,
          fetchPinned: fetchPinned as never,
        }),
      ).rejects.toBeInstanceOf(SiteOpsWireOutputResolutionError);
    }
  });

  it("enforces phase-specific decoded JSON size limits", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      content: "x".repeat(300 * 1024),
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    const events = [
      marker(),
      rejected(),
      assistant({
        attachments: [
          {
            filename: SITEOPS_WIRE_OUTPUT_FILES.design,
            content_type: "application/json",
            url: "https://files.example.test/result.json",
          },
        ],
      }),
    ] as never;
    await expect(
      resolveSiteOpsWireOutput({
        events,
        operationToken: token,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).rejects.toMatchObject({ code: "SITEOPS_WIRE_OUTPUT_INVALID" });

    const contentToken = "siteops-content:10000000-0000-4000-8000-000000000001";
    const contentValue = { ...value, operationToken: contentToken };
    const contentFetch = vi.fn(async () => ({
      response: jsonResponse(contentValue),
      finalUrl: new URL("https://files.example.test/content.json"),
    }));
    await expect(
      resolveWireOutput({
        events: [
          marker(contentToken),
          rejected(),
          assistant({
            attachments: [
              {
                filename: SITEOPS_WIRE_OUTPUT_FILES.content,
                content_type: "application/json",
                url: "https://files.example.test/content.json",
              },
            ],
          }),
        ] as never,
        operationToken: contentToken,
        phase: "content",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.content,
        taskCompleted: true,
        fetchPinned: contentFetch as never,
      }),
    ).resolves.toMatchObject({ value: contentValue, source: "attachment" });
  });

  it("rejects private and non-HTTPS attachment coordinates before network access", async () => {
    for (const url of [
      "http://files.example.test/result.json",
      "https://127.0.0.1/result.json",
    ]) {
      await expect(
        resolveSiteOpsWireOutput({
          events: [
            marker(),
            rejected(),
            assistant({
              attachments: [
                {
                  filename: SITEOPS_WIRE_OUTPUT_FILES.design,
                  content_type: "application/json",
                  url,
                },
              ],
            }),
          ] as never,
          operationToken: token,
          taskCompleted: true,
        }),
      ).rejects.toMatchObject({ code: "SITEOPS_WIRE_OUTPUT_INVALID" });
    }
  });
});
