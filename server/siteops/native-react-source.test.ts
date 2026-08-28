import { createHash } from "node:crypto";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
  FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
  NATIVE_SOURCE_PREFLIGHT_FILENAME,
  NATIVE_SOURCE_PREFLIGHT_SHA256,
  NATIVE_SOURCE_PREFLIGHT_VERSION,
  NativeReactSourceError,
  TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT,
  TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT,
  readNativeSourceAttachment,
  siteSourceReceiptV1Schema,
  validateNativeReactSourceArchive,
} from "./native-react-source";

const operationToken = "siteops-build:10000000-0000-4000-8000-000000000001";
const baseSourceSha256 = "a".repeat(64);

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function packageJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "frontmind-native-site",
    private: true,
    version: "1.0.0",
    scripts: { build: "vite build" },
    dependencies: {
      "@vitejs/plugin-react": "5.0.4",
      react: "19.2.1",
      "react-dom": "19.2.1",
      vite: "7.1.9",
    },
    ...overrides,
  });
}

async function sourceArchive(input?: {
  package?: Record<string, unknown>;
  source?: string | Buffer;
  mutate?: (zip: JSZip) => void;
  platform?: "DOS" | "UNIX";
}) {
  const zip = new JSZip();
  zip.file("native-site/package.json", packageJson(input?.package));
  zip.file(
    "native-site/index.html",
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  zip.file(
    "native-site/src/main.tsx",
    input?.source ??
      'import React from "react"; import { createRoot } from "react-dom/client"; import "./style.css"; createRoot(document.getElementById("root")!).render(<main>企业官网</main>);',
  );
  zip.file(
    "native-site/src/style.css",
    "body { color: #111; background: #fff; }",
  );
  input?.mutate?.(zip);
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: input?.platform ?? "UNIX",
  });
  return archive;
}

function receipt(archive: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    operationToken,
    baseSourceSha256,
    archiveSha256: sha256(archive),
    fileCount: 4,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject<Partial<NativeReactSourceError>>({
    code,
  });
}

describe("native React source archive boundary", () => {
  it("freezes the complete-source no-redesign prompt contract", () => {
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      "不是视觉设计师",
    );
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain("不得主动修改");
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      NATIVE_SOURCE_PREFLIGHT_FILENAME,
    );
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain("立即结束");
    for (const coordinate of [
      "CSS",
      "className",
      "动画",
      "响应式断点",
      "组件层级",
      "import",
      "依赖",
    ]) {
      expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(coordinate);
    }
    expect(TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT).toContain(
      FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
    );
  });

  it("guides 2.7 template adaptation through prompt-only quality constraints", () => {
    for (const instruction of [
      "这是适配用户选中的模板，不是从零重新设计",
      "页面目的 × 用户问题 × 企业事实 × CTA",
      "产品与服务 / 产品 / 服务",
      "同一完整段落不得在多个页面或卡片中重复",
      "不得把模板改造成通用卡片站",
      "production build",
      "不要输出思考过程",
    ]) {
      expect(TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT).toContain(
        instruction,
      );
    }
    expect(TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT).toContain(
      FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
    );
    expect(TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT).not.toContain(
      "视觉相似度阈值",
    );
  });

  it("keeps legacy receipts readable and validates complete preflight coordinates", () => {
    const archiveSha256 = "b".repeat(64);
    const legacy = {
      operationToken,
      baseSourceSha256,
      archiveSha256,
      fileCount: 4,
    };
    expect(siteSourceReceiptV1Schema.parse(legacy)).toEqual(legacy);
    expect(
      siteSourceReceiptV1Schema.parse({
        ...legacy,
        preflightVersion: NATIVE_SOURCE_PREFLIGHT_VERSION,
        preflightStatus: "passed",
        preflightSha256: NATIVE_SOURCE_PREFLIGHT_SHA256,
      }),
    ).toMatchObject({ preflightStatus: "passed" });
    expect(
      siteSourceReceiptV1Schema.safeParse({
        ...legacy,
        preflightVersion: NATIVE_SOURCE_PREFLIGHT_VERSION,
      }).success,
    ).toBe(false);
  });

  it("accepts a bounded complete React archive and normalizes one wrapper directory", async () => {
    const archive = await sourceArchive();
    const result = await validateNativeReactSourceArchive({
      archive,
      receipt: receipt(archive),
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: baseSourceSha256,
    });

    expect(result.archiveSha256).toBe(sha256(archive));
    expect(result.fileCount).toBe(4);
    expect(result.htmlEntrypoint).toBe("index.html");
    expect(result.entrypoint).toBe("src/main.tsx");
    expect([...result.files.keys()]).toEqual([
      "index.html",
      "package.json",
      "src/main.tsx",
      "src/style.css",
    ]);
  });

  it("reports precise ZIP, package syntax, package shape, and file-type reasons", async () => {
    const invalidZip = Buffer.from("not-a-zip", "utf8");
    await expectCode(
      validateNativeReactSourceArchive({
        archive: invalidZip,
        receipt: receipt(invalidZip, { fileCount: 1 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_ZIP_INVALID",
    );

    const invalidPackageJson = await sourceArchive({
      mutate: (zip) => zip.file("native-site/package.json", "{invalid"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: invalidPackageJson,
        receipt: receipt(invalidPackageJson),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_PACKAGE_JSON_INVALID",
    );

    const invalidPackageShape = await sourceArchive({
      mutate: (zip) => zip.file("native-site/package.json", "[]"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: invalidPackageShape,
        receipt: receipt(invalidPackageShape),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_PACKAGE_SHAPE_INVALID",
    );

    const forbiddenType = await sourceArchive({
      mutate: (zip) => zip.file("native-site/bin/tool.exe", "binary"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: forbiddenType,
        receipt: receipt(forbiddenType, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_FILE_TYPE_FORBIDDEN",
    );
  });

  it("rejects dependency ranges so preview and production use one exact runtime", async () => {
    const archive = await sourceArchive({
      package: {
        dependencies: {
          react: "^19.2.1",
          "react-dom": "19.2.1",
        },
      },
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH",
    );
  });

  it("rejects operation, base-source and output archive coordinate mismatches", async () => {
    const archive = await sourceArchive();
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { operationToken: "siteops-build:other" }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_TOKEN_MISMATCH",
    );
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { baseSourceSha256: "b".repeat(64) }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_BASE_HASH_MISMATCH",
    );
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { archiveSha256: "c".repeat(64) }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_ARCHIVE_HASH_MISMATCH",
    );
  });

  it("rejects traversal paths even when JSZip exposes a sanitized entry name", async () => {
    const archive = await sourceArchive({
      mutate: (zip) => zip.file("../escape.tsx", "export default 1"),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_PATH_INVALID",
    );
  });

  it("rejects Unix symbolic links", async () => {
    const archive = await sourceArchive({
      mutate: (zip) =>
        zip.file("native-site/src/link.tsx", "main.tsx", {
          unixPermissions: 0o120777,
        }),
      platform: "UNIX",
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_SYMLINK_FORBIDDEN",
    );
  });

  it("rejects decompressed files beyond the bounded single-file budget", async () => {
    const archive = await sourceArchive({ source: "export default 'large';" });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
        limits: { maxSingleFileBytes: 12 },
      }),
      "NATIVE_SOURCE_LIMIT_EXCEEDED",
    );
  });

  it("rejects invalid UTF-8 in a source text file", async () => {
    const archive = await sourceArchive({
      source: Buffer.from([0xff, 0xfe, 0xfd]),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_TEXT_INVALID",
    );
  });

  it("rejects secrets and the operation token in source text", async () => {
    const archive = await sourceArchive({
      source:
        'const clientSecret = "client-secret-value-123456789"; export default clientSecret;',
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_SECRET_FORBIDDEN",
    );
  });

  it("rejects the raw operation-token bytes even inside a binary asset", async () => {
    const archive = await sourceArchive({
      mutate: (zip) =>
        zip.file(
          "native-site/public/opaque.png",
          Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
            Buffer.from(operationToken, "utf8"),
            Buffer.from([0x00, 0xff]),
          ]),
        ),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_SECRET_FORBIDDEN",
    );
  });

  it("allows only exact Tailwind and archive-local relative CSS imports", async () => {
    const archive = await sourceArchive({
      mutate: (zip) => {
        zip.file(
          "native-site/src/style.css",
          '@import "tailwindcss";\n@import "./theme.css";\nbody{color:#111}',
        );
        zip.file("native-site/src/theme.css", ".hero{display:grid}");
      },
    });
    await expect(
      validateNativeReactSourceArchive({
        archive,
        receipt: receipt(archive, { fileCount: 5 }),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
    ).resolves.toMatchObject({ entrypoint: "src/main.tsx" });

    for (const forbiddenImport of [
      '@import "file:/tmp/host.css";',
      '@import "/absolute.css";',
      '@import "../escape.css";',
      '@import "https://example.test/remote.css";',
    ]) {
      const invalid = await sourceArchive({
        mutate: (zip) => zip.file("native-site/src/style.css", forbiddenImport),
      });
      await expectCode(
        validateNativeReactSourceArchive({
          archive: invalid,
          receipt: receipt(invalid),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        "NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN",
      );
    }
  });

  it("rejects Tailwind directives that load executable plugins or config", async () => {
    for (const directive of [
      '@plugin "./plugin.js";',
      '@config "./tailwind.config.js";',
    ]) {
      const archive = await sourceArchive({
        mutate: (zip) => zip.file("native-site/src/style.css", directive),
      });
      await expectCode(
        validateNativeReactSourceArchive({
          archive,
          receipt: receipt(archive),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        "NATIVE_SOURCE_STYLE_EXECUTION_FORBIDDEN",
      );
    }
  });

  it("rejects dynamic execution and dynamic imports", async () => {
    for (const source of [
      'eval("alert(1)")',
      'const lazy = import("./other")',
      'const compile = new Function("return 1")',
    ]) {
      const archive = await sourceArchive({ source });
      await expectCode(
        validateNativeReactSourceArchive({
          archive,
          receipt: receipt(archive),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        "NATIVE_SOURCE_DYNAMIC_EXECUTION_FORBIDDEN",
      );
    }
  });

  it("rejects browser network requests, remote frames and unsafe HTML injection", async () => {
    const cases = [
      {
        source: 'fetch("https://example.test/data")',
        code: "NATIVE_SOURCE_NETWORK_FORBIDDEN",
      },
      {
        source: "const x = { dangerouslySetInnerHTML: { __html: value } };",
        code: "NATIVE_SOURCE_HTML_INJECTION_FORBIDDEN",
      },
    ];
    for (const item of cases) {
      const archive = await sourceArchive({ source: item.source });
      await expectCode(
        validateNativeReactSourceArchive({
          archive,
          receipt: receipt(archive),
          expectedOperationToken: operationToken,
          expectedBaseSourceSha256: baseSourceSha256,
        }),
        item.code,
      );
    }

    const framedArchive = await sourceArchive({
      mutate: (zip) =>
        zip.file(
          "native-site/index.html",
          '<!doctype html><iframe src="https://evil.example"></iframe><script type="module" src="/src/main.tsx"></script>',
        ),
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: framedArchive,
        receipt: receipt(framedArchive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_NETWORK_FORBIDDEN",
    );
  });

  it("rejects lifecycle scripts and dependencies outside the compile allowlist", async () => {
    const lifecycleArchive = await sourceArchive({
      package: {
        scripts: { build: "vite build", postinstall: "node setup.js" },
      },
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: lifecycleArchive,
        receipt: receipt(lifecycleArchive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN",
    );

    const dependencyArchive = await sourceArchive({
      package: { dependencies: { react: "19.2.1", "unknown-kit": "1.0.0" } },
    });
    await expectCode(
      validateNativeReactSourceArchive({
        archive: dependencyArchive,
        receipt: receipt(dependencyArchive),
        expectedOperationToken: operationToken,
        expectedBaseSourceSha256: baseSourceSha256,
      }),
      "NATIVE_SOURCE_DEPENDENCY_FORBIDDEN",
    );
  });
});

describe("native source binary attachment boundary", () => {
  it("accepts only the exact ZIP filename and MIME from a bounded data URL", async () => {
    const body = Buffer.from("PK bounded source", "utf8");
    await expect(
      readNativeSourceAttachment({
        attachment: {
          filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,${body.toString("base64")}`,
        },
      }),
    ).resolves.toEqual(body);

    for (const contentType of [
      "Application/ZIP; charset=binary",
      "application/x-zip-compressed",
      "application/octet-stream",
    ]) {
      await expect(
        readNativeSourceAttachment({
          attachment: {
            filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
            contentType,
            url: `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,${body.toString("base64")}`,
          },
        }),
      ).resolves.toEqual(body);
    }

    await expectCode(
      readNativeSourceAttachment({
        attachment: {
          filename: "other.zip",
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,${body.toString("base64")}`,
        },
      }),
      "NATIVE_SOURCE_ATTACHMENT_INVALID",
    );
  });

  it("uses an injected pinned HTTPS fetch and enforces the response MIME", async () => {
    const body = Buffer.from("PK fetched source", "utf8");
    const fetchPinned = vi.fn(async () => ({
      response: new Response(body, {
        status: 200,
        headers: {
          "content-type": FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          "content-length": String(body.length),
        },
      }),
      finalUrl: { origin: "https://files.example.test", path: "/source" },
    }));
    await expect(
      readNativeSourceAttachment({
        attachment: {
          filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: "https://files.example.test/source.zip?opaque=1",
        },
        fetchPinned,
      }),
    ).resolves.toEqual(body);
    expect(fetchPinned).toHaveBeenCalledTimes(1);

    for (const responseContentType of [
      "Application/ZIP; charset=binary",
      "application/x-zip-compressed",
      "application/octet-stream",
    ]) {
      await expect(
        readNativeSourceAttachment({
          attachment: {
            filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
            contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
            url: "https://files.example.test/source.zip?opaque=2",
          },
          fetchPinned: vi.fn(async () => ({
            response: new Response(body, {
              status: 200,
              headers: { "content-type": responseContentType },
            }),
            finalUrl: { origin: "https://files.example.test", path: "/source" },
          })) as never,
        }),
      ).resolves.toEqual(body);
    }

    await expectCode(
      readNativeSourceAttachment({
        attachment: {
          filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
          contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          url: "https://files.example.test/source.zip?opaque=3",
        },
        fetchPinned: vi.fn(async () => ({
          response: new Response(body, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
          finalUrl: { origin: "https://files.example.test", path: "/source" },
        })) as never,
      }),
      "NATIVE_SOURCE_ATTACHMENT_INVALID",
    );
  });

  it("classifies transient attachment download failures for bounded recovery", async () => {
    const attachment = {
      filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
      contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
      url: "https://files.example.test/source.zip",
    };
    await expect(
      readNativeSourceAttachment({
        attachment,
        fetchPinned: vi.fn(async () => ({
          response: new Response(null, { status: 503 }),
          finalUrl: { origin: "https://files.example.test", path: "/source" },
        })) as never,
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE",
      retryable: true,
      status: 503,
    });
    await expect(
      readNativeSourceAttachment({
        attachment,
        fetchPinned: vi.fn(async () => {
          throw new Error("connection reset");
        }) as never,
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE",
      retryable: true,
      status: null,
    });
  });
});
