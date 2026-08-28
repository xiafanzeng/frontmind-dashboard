import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  arbitrateFirstDurableGeneralChatProviderAttachmentEvidence,
  classifyGeneralChatAttachmentStreamError,
  clearGeneralChatProviderAttachmentEvidenceCacheForTests,
  generalChatProviderAttachmentDescriptor,
  generalChatProviderEvidenceHasUniqueMatch,
  isGeneralChatProviderAttachmentAddressPublic,
  parseGeneralChatProviderAttachmentEvidence,
  resolveManusV2GeneralChatUserEventEvidence,
  type GeneralChatLocalAttachmentManifestItem,
  type GeneralChatProviderAttachmentEvidence,
  type GeneralChatProviderAttachmentReader,
} from "./manus-v2-user-attachment-evidence";

afterEach(() => {
  clearGeneralChatProviderAttachmentEvidenceCacheForTests();
  vi.restoreAllMocks();
});

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function event(input: {
  text?: string;
  attachments?: unknown[];
  contentAttachments?: unknown[];
}) {
  return {
    id: "event-1",
    type: "user_message",
    timestamp: 1,
    user_message: {
      content: [
        { type: "text", text: input.text ?? "analyze" },
        ...(input.contentAttachments ?? []),
      ],
      ...(input.attachments ? { attachments: input.attachments } : {}),
    },
  };
}

function localFile(
  fileId: string,
  bytes: Buffer,
  overrides: Partial<GeneralChatLocalAttachmentManifestItem> = {},
): GeneralChatLocalAttachmentManifestItem {
  return {
    fileId,
    sha256: digest(bytes),
    sizeBytes: bytes.byteLength,
    filename: "local.png",
    mimeType: "image/png",
    ...overrides,
  };
}

function readerFor(
  entries: Record<string, Buffer>,
): GeneralChatProviderAttachmentReader {
  return vi.fn(async ({ url }) => {
    const bytes = entries[new URL(url).pathname];
    if (!bytes) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return {
      body: (async function* () {
        yield bytes.subarray(0, Math.ceil(bytes.length / 2));
        yield bytes.subarray(Math.ceil(bytes.length / 2));
      })(),
      contentLength: bytes.byteLength,
      contentType: "application/octet-stream",
    };
  });
}

const signedUrl =
  "https://files.manuscdn.com/input/a.png?variant=original&Policy=old&Signature=one&Key-Pair-Id=k1";

describe("Manus v2 general-chat user attachment evidence", () => {
  it("strips only signing coordinates and preserves sorted semantic query", () => {
    expect(
      generalChatProviderAttachmentDescriptor(
        "https://FILES.manuscdn.com:443/input/a.png?z=2&Signature=x&a=3&Policy=p&a=1#ignored",
      ),
    ).toBe("https://files.manuscdn.com/input/a.png?a=1&a=3&z=2");
    expect(
      generalChatProviderAttachmentDescriptor(
        "https://files.manuscdn.com/input/a.png?variant=thumb&x-amz-signature=x",
      ),
    ).not.toBe(
      generalChatProviderAttachmentDescriptor(
        "https://files.manuscdn.com/input/a.png?variant=original&x-amz-signature=x",
      ),
    );
  });

  it.each([
    "http://files.manuscdn.com/input/a.png",
    "https://files.manuscdn.com:444/input/a.png",
    "https://manuscdn.com.example.test/input/a.png",
    "https://user:secret@files.manuscdn.com/input/a.png",
  ])("rejects an unsafe descriptor before any download: %s", async (url) => {
    const readUrl = vi.fn();
    const bytes = Buffer.from("image");
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [{ type: "file", url }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl,
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      code: "ATTACHMENT_DESCRIPTOR_UNSAFE",
    });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["10.0.0.1", false],
    ["::1", false],
    ["::ffff:127.0.0.1", false],
    ["fc00::1", false],
    ["fe80::1", false],
    ["2001:db8::1", false],
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
  ])("classifies DNS address %s as public=%s", (address, expected) => {
    expect(isGeneralChatProviderAttachmentAddressPublic(address)).toBe(
      expected,
    );
  });

  it("uses exact file ids as the authoritative fast path and never downloads redundant URLs", async () => {
    const readUrl = vi.fn();
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          attachments: [
            { file_id: "file-b", url: signedUrl },
            { file_id: "file-a", url: signedUrl },
          ],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-a", "file-b"],
        readUrl,
      }),
    ).resolves.toMatchObject({ kind: "match", evidence: null });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it("does not let an exact file id hide an extra URL-only attachment", async () => {
    const readUrl = vi.fn();
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          attachments: [{ file_id: "file-1" }],
          contentAttachments: [
            {
              type: "file",
              url: "https://files.manuscdn.com/input/extra.png",
            },
          ],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        readUrl,
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      code: "ATTACHMENT_DESCRIPTOR_MISSING",
    });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it("does not let an exact file id hide an extra descriptor-less attachment", async () => {
    const readUrl = vi.fn();
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          attachments: [{ file_id: "file-1" }],
          contentAttachments: [{ type: "file", filename: "unidentified.png" }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        readUrl,
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      code: "ATTACHMENT_DESCRIPTOR_MISSING",
    });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it("hashes the prompt only after removing a valid trailing general-chat contract", async () => {
    const text =
      'analyze\n\n# FrontMind operation contract\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"chat-create:12345678","contract":"dashboard.general-chat","revision":2}';
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({ text }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: [],
      }),
    ).resolves.toMatchObject({ kind: "match" });
  });

  it("rejects a prompt mismatch before downloading attachment content", async () => {
    const readUrl = vi.fn();
    const bytes = Buffer.from("image");
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          text: "different",
          contentAttachments: [{ type: "file", url: signedUrl }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl,
      }),
    ).resolves.toMatchObject({ kind: "mismatch", code: "PROMPT_MISMATCH" });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it("matches a URL-only user event by count, size and SHA-256 while treating names and MIME as auxiliary", async () => {
    const bytes = Buffer.from("provider image bytes");
    const readUrl = readerFor({ "/input/a.png": bytes });
    const result = await resolveManusV2GeneralChatUserEventEvidence({
      event: event({
        contentAttachments: [
          {
            type: "image",
            url: signedUrl,
            filename: "renamed.bin",
            mime_type: "application/octet-stream",
          },
        ],
      }),
      promptSha256: digest("analyze"),
      expectedAttachmentFileIds: ["file-1"],
      localAttachmentManifest: [localFile("file-1", bytes)],
      readUrl,
    });
    expect(result).toMatchObject({
      kind: "match",
      evidence: {
        schemaVersion: 1,
        contentManifest: [
          {
            sha256: digest(bytes),
            sizeBytes: bytes.length,
            filename: "renamed.bin",
          },
        ],
      },
    });
  });

  it("counts one URL-only attachment mirrored in attachments and content only once", async () => {
    const bytes = Buffer.from("mirrored image bytes");
    const readUrl = readerFor({ "/input/a.png": bytes });
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          attachments: [
            {
              type: "image",
              url: signedUrl,
              filename: "image.png",
              mime_type: "image/png",
            },
          ],
          contentAttachments: [
            {
              type: "image",
              url: signedUrl,
              filename: "image.png",
              mime_type: "image/png",
            },
          ],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl,
      }),
    ).resolves.toMatchObject({ kind: "match" });
    expect(readUrl).toHaveBeenCalledOnce();
  });

  it("does not merge different URL-only resources across attachments and content", async () => {
    const bytes = Buffer.from("image");
    const readUrl = vi.fn();
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          attachments: [
            {
              type: "image",
              url: signedUrl,
              filename: "image.png",
              mime_type: "image/png",
            },
          ],
          contentAttachments: [
            {
              type: "image",
              url: "https://files.manuscdn.com/input/b.png?Signature=two&variant=original",
              filename: "image.png",
              mime_type: "image/png",
            },
          ],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl,
      }),
    ).resolves.toMatchObject({
      kind: "mismatch",
      code: "ATTACHMENT_COUNT_MISMATCH",
    });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it("accepts the nested image_url descriptor emitted by v2 content parts", async () => {
    const bytes = Buffer.from("nested image bytes");
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [
            {
              type: "image_url",
              image_url: { url: signedUrl, mime_type: "image/png" },
            },
          ],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl: readerFor({ "/input/a.png": bytes }),
      }),
    ).resolves.toMatchObject({ kind: "match" });
  });

  it("returns a proven mismatch when URL bytes differ", async () => {
    const local = Buffer.from("local image");
    const provider = Buffer.from("different image");
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [{ type: "file", url: signedUrl }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", local)],
        readUrl: readerFor({ "/input/a.png": provider }),
      }),
    ).resolves.toMatchObject({
      kind: "mismatch",
      code: "ATTACHMENT_CONTENT_MISMATCH",
    });
  });

  it("treats a same-prompt event with no file id or URL as unresolved", async () => {
    const bytes = Buffer.from("image");
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [{ type: "file", filename: "image.png" }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      code: "ATTACHMENT_DESCRIPTOR_MISSING",
    });
  });

  it("keeps using first durable evidence when Provider temporarily omits its URL", async () => {
    const bytes = Buffer.from("image");
    const first = await resolveManusV2GeneralChatUserEventEvidence({
      event: event({
        contentAttachments: [{ type: "file", url: signedUrl }],
      }),
      promptSha256: digest("analyze"),
      expectedAttachmentFileIds: ["file-1"],
      localAttachmentManifest: [localFile("file-1", bytes)],
      readUrl: readerFor({ "/input/a.png": bytes }),
    });
    expect(first.kind).toBe("match");
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [{ type: "file", filename: "image.png" }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        cachedEvidence: first.evidence,
        readUrl: vi.fn(),
      }),
    ).resolves.toMatchObject({ kind: "match" });
  });

  it("checks descriptor count before performing a download", async () => {
    const bytes = Buffer.from("image");
    const readUrl = vi.fn();
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [
            { type: "file", url: signedUrl },
            {
              type: "file",
              url: "https://files.manuscdn.com/input/b.png?Signature=two",
            },
          ],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl,
      }),
    ).resolves.toMatchObject({
      kind: "mismatch",
      code: "ATTACHMENT_COUNT_MISMATCH",
    });
    expect(readUrl).not.toHaveBeenCalled();
  });

  it("enforces the per-file limit from Content-Length before streaming", async () => {
    const bytes = Buffer.from("image");
    const readUrl = vi.fn(async () => ({
      body: (async function* () {
        yield bytes;
      })(),
      contentLength: 100 * 1024 * 1024 + 1,
    }));
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [{ type: "file", url: signedUrl }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl,
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      code: "ATTACHMENT_DOWNLOAD_LIMIT",
    });
  });

  it("turns native premature-close stream errors into unresolved evidence", async () => {
    const bytes = Buffer.from("image");
    const readUrl = vi.fn(async () => ({
      body: (async function* () {
        yield bytes.subarray(0, 1);
        throw Object.assign(new Error("closed"), {
          code: "ERR_STREAM_PREMATURE_CLOSE",
        });
      })(),
    }));
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [{ type: "file", url: signedUrl }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl,
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      code: "ATTACHMENT_DOWNLOAD_FAILED",
    });
    expect(
      classifyGeneralChatAttachmentStreamError(
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      ),
    ).toBe("transient");
  });

  it("enforces one total 120-second evidence deadline", async () => {
    const bytes = Buffer.from("image");
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(120_001);
    await expect(
      resolveManusV2GeneralChatUserEventEvidence({
        event: event({
          contentAttachments: [{ type: "file", url: signedUrl }],
        }),
        promptSha256: digest("analyze"),
        expectedAttachmentFileIds: ["file-1"],
        localAttachmentManifest: [localFile("file-1", bytes)],
        readUrl: readerFor({ "/input/a.png": bytes }),
        now,
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      code: "ATTACHMENT_DOWNLOAD_TIMEOUT",
    });
  });

  it("reuses successful evidence for a refreshed signing query for ten minutes", async () => {
    const bytes = Buffer.from("image");
    const readUrl = readerFor({ "/input/a.png": bytes });
    const base = {
      promptSha256: digest("analyze"),
      expectedAttachmentFileIds: ["file-1"],
      localAttachmentManifest: [localFile("file-1", bytes)],
      readUrl,
    };
    await resolveManusV2GeneralChatUserEventEvidence({
      ...base,
      event: event({
        contentAttachments: [{ type: "file", url: signedUrl }],
      }),
    });
    await resolveManusV2GeneralChatUserEventEvidence({
      ...base,
      event: event({
        contentAttachments: [
          {
            type: "file",
            url: "https://files.manuscdn.com/input/a.png?Signature=fresh&Policy=new&variant=original",
          },
        ],
      }),
    });
    expect(readUrl).toHaveBeenCalledTimes(1);
  });

  it("does not reuse evidence when a semantic URL coordinate changes", async () => {
    const bytes = Buffer.from("image");
    const readUrl = readerFor({ "/input/a.png": bytes });
    const base = {
      promptSha256: digest("analyze"),
      expectedAttachmentFileIds: ["file-1"],
      localAttachmentManifest: [localFile("file-1", bytes)],
      readUrl,
    };
    for (const variant of ["original", "thumbnail"]) {
      await resolveManusV2GeneralChatUserEventEvidence({
        ...base,
        event: event({
          contentAttachments: [
            {
              type: "file",
              url: `https://files.manuscdn.com/input/a.png?variant=${variant}&Signature=x`,
            },
          ],
        }),
      });
    }
    expect(readUrl).toHaveBeenCalledTimes(2);
  });
});

describe("durable attachment evidence arbitration", () => {
  function evidence(
    descriptor = digest("descriptor-a"),
    content = digest("content-a"),
  ): GeneralChatProviderAttachmentEvidence {
    return {
      schemaVersion: 1,
      descriptorSha256: [descriptor],
      contentManifest: [
        {
          sha256: content,
          sizeBytes: 9,
          filename: null,
          mimeType: null,
        },
      ],
    };
  }

  it("accepts the first evidence and preserves the first durable content", () => {
    const first = evidence();
    const later = evidence(digest("descriptor-a"), digest("different"));
    expect(
      arbitrateFirstDurableGeneralChatProviderAttachmentEvidence({
        existing: first,
        incoming: later,
      }),
    ).toEqual({
      kind: "accepted",
      evidence: first,
      code: "EXISTING_EVIDENCE_ACCEPTED",
    });
  });

  it("fails closed on descriptor drift or invalid durable JSON", () => {
    expect(
      arbitrateFirstDurableGeneralChatProviderAttachmentEvidence({
        existing: evidence(),
        incoming: evidence(digest("descriptor-b")),
      }),
    ).toMatchObject({
      kind: "conflict",
      code: "ATTACHMENT_DESCRIPTOR_CONFLICT",
    });
    expect(
      arbitrateFirstDurableGeneralChatProviderAttachmentEvidence({
        existing: { schemaVersion: 1 },
        incoming: evidence(),
      }),
    ).toMatchObject({ kind: "conflict", code: "EXISTING_EVIDENCE_INVALID" });
  });

  it("parses only bounded, internally consistent evidence", () => {
    expect(parseGeneralChatProviderAttachmentEvidence(evidence())).toEqual(
      evidence(),
    );
    expect(
      parseGeneralChatProviderAttachmentEvidence({
        ...evidence(),
        descriptorSha256: [digest("same"), digest("same")],
      }),
    ).toBeNull();
  });

  it("allows a unique reconciliation only with one match and no unresolved candidate", () => {
    expect(
      generalChatProviderEvidenceHasUniqueMatch({
        matchCount: 1,
        unresolvedCount: 0,
      }),
    ).toBe(true);
    expect(
      generalChatProviderEvidenceHasUniqueMatch({
        matchCount: 1,
        unresolvedPlausibleCount: 1,
      }),
    ).toBe(false);
    expect(
      generalChatProviderEvidenceHasUniqueMatch({
        matchCount: 2,
        unresolvedCount: 0,
      }),
    ).toBe(false);
  });
});
