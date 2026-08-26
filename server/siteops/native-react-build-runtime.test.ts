import { createHash } from "node:crypto";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { SiteBrief } from "../../shared/siteops";
import {
  validateNativeReactSourceArchive,
  type ValidatedNativeReactSource,
} from "./native-react-source";
import {
  materializeNativeReactSource,
  NativeReactBuildError,
  rebuildNativeReactProductionFromSource,
} from "./native-react-build-runtime";

const BUILD = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  knowledgeSnapshotId: "33333333-3333-4333-8333-333333333333",
  workflowVersion: "2.5.0",
  selectionHash: "a".repeat(64),
} as const;

const BRIEF = {
  companyName: "示例企业",
  primaryLanguage: "zh-CN",
  contacts: [],
  offerings: ["企业服务"],
  audience: ["企业客户"],
  conversionGoal: "联系咨询",
  contentInventory: {
    schemaVersion: 1,
    source: "frozen_knowledge_snapshot",
    entries: [],
  },
  routes: [
    {
      id: "home",
      slug: "/",
      title: "首页",
      sourceDocumentIds: ["source-1"],
    },
    {
      id: "applications",
      slug: "/applications/",
      title: "应用场景",
      sourceDocumentIds: ["source-1"],
    },
  ],
  verifiedFacts: [
    { statement: "这是已核验的企业介绍。", sourceDocumentIds: ["source-1"] },
  ],
  publicAssetIds: [],
  unknowns: [],
} satisfies SiteBrief;

const BASE_SOURCE_SHA256 = "b".repeat(64);
const OPERATION_TOKEN = "native-runtime-test-operation-token";
const FIXED_DATE = new Date("2000-01-01T00:00:00.000Z");
const browserIt =
  process.env.FRONTMIND_RUN_SITEOPS_BROWSER_INTEGRATION === "1" ? it : it.skip;

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function validatedSource(overrides?: {
  main?: string;
  css?: string;
  additional?: Record<string, string>;
  dependencies?: Record<string, string>;
}): Promise<ValidatedNativeReactSource> {
  const files = new Map<string, Buffer>([
    [
      "package.json",
      Buffer.from(
        JSON.stringify({
          type: "module",
          scripts: { build: "vite build --config vite.config.ts" },
          dependencies: {
            react: "19.2.1",
            "react-dom": "19.2.1",
            tailwindcss: "4.1.14",
            ...overrides?.dependencies,
          },
        }),
      ),
    ],
    [
      "index.html",
      Buffer.from(
        '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      ),
    ],
    [
      "src/main.tsx",
      Buffer.from(
        overrides?.main ??
          `import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
function App() { return <main className="hero"><h1>精美企业官网</h1><p>这是已核验的企业介绍。</p></main>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      ),
    ],
    [
      "src/style.css",
      Buffer.from(
        overrides?.css ??
          "body{margin:0;font-family:system-ui;background:#fff;color:#111}.hero{min-height:100vh;display:grid;place-content:center}",
      ),
    ],
    [
      "vite.config.ts",
      Buffer.from(
        'throw new Error("PROVIDER_VITE_CONFIG_MUST_NEVER_EXECUTE");',
      ),
    ],
  ]);
  for (const [filename, content] of Object.entries(
    overrides?.additional ?? {},
  )) {
    files.set(filename, Buffer.from(content));
  }
  const archive = new JSZip();
  for (const [filename, bytes] of files) {
    archive.file(filename, bytes, {
      date: FIXED_DATE,
      createFolders: false,
      unixPermissions: 0o100644,
    });
  }
  const sourceZip = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return await validateNativeReactSourceArchive({
    archive: sourceZip,
    receipt: {
      operationToken: OPERATION_TOKEN,
      baseSourceSha256: BASE_SOURCE_SHA256,
      archiveSha256: sha256(sourceZip),
      fileCount: files.size,
    },
    expectedOperationToken: OPERATION_TOKEN,
    expectedBaseSourceSha256: BASE_SOURCE_SHA256,
  });
}

describe("native React build runtime", () => {
  it("builds the exact validated source and materializes every frozen route", async () => {
    const source = await validatedSource();
    const result = await materializeNativeReactSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD,
      brief: BRIEF,
      mode: "preview",
      browserQa: false,
    });

    expect(result.sourceZip.equals(source.sourceZip)).toBe(true);
    expect(result.sourceSha256).toBe(source.sourceSha256);
    expect(result.buildDelivery).toEqual({
      renderMode: "twenty_first_native",
      qaStatus: "passed_with_warnings",
      warningCodes: ["NATIVE_BROWSER_QA_SKIPPED"],
    });
    expect(result.files.has("index.html")).toBe(true);
    expect(result.files.has("applications/index.html")).toBe(true);
    expect(result.files.has("404.html")).toBe(true);
    expect(result.files.get("index.html")?.toString("utf8")).toContain(
      'name="robots" content="noindex,nofollow"',
    );
    expect(
      [...result.files.keys()].some((name) =>
        /^assets\/app-.+\.js$/u.test(name),
      ),
    ).toBe(true);
    expect(result.provenanceJson.toString("utf8")).toContain(
      '"providerViteConfigExecuted":false',
    );
    expect(result.provenanceJson.toString("utf8")).toContain(
      '"providerPackageScriptsExecuted":false',
    );
  }, 30_000);

  it("compiles a common Tailwind v4 source through the trusted host plugin", async () => {
    const source = await validatedSource({
      main: `import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
createRoot(document.getElementById("root")!).render(<main className="flex min-h-screen items-center justify-center"><h1>原生 Tailwind 页面</h1></main>);`,
      css: '@import "tailwindcss";',
    });
    let result;
    try {
      result = await materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      });
    } catch (error) {
      // Kept assertion-safe: diagnostics contain only code/path/coordinates.
      throw new Error(
        `TAILWIND_BUILD_FAILED:${JSON.stringify((error as NativeReactBuildError).diagnostics)}`,
      );
    }
    const css = [...result.files.entries()]
      .filter(([name]) => name.endsWith(".css"))
      .map(([, bytes]) => bytes.toString("utf8"))
      .join("\n");
    expect(css).toMatch(/display:flex/u);
    expect(css).toMatch(/min-height:100vh/u);
  }, 30_000);

  it("links installed packages whose exports hide package.json", async () => {
    const source = await validatedSource({
      dependencies: {
        "@radix-ui/react-slot": "1.2.3",
        clsx: "2.1.1",
      },
      main: `import React from "react";
import { createRoot } from "react-dom/client";
import { Slot } from "@radix-ui/react-slot";
import clsx from "clsx";
function App() { return <Slot><main className={clsx("hero", true && "ready")}>原生组件官网</main></Slot>; }
createRoot(document.getElementById("root")!).render(<App />);`,
    });
    const result = await materializeNativeReactSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD,
      brief: BRIEF,
      mode: "preview",
      browserQa: false,
    });
    expect(result.files.get("index.html")?.toString("utf8")).toContain(
      "noindex,nofollow",
    );
    expect(result.provenanceJson.toString("utf8")).toContain(
      '"linkedHostDependencies":["@radix-ui/react-slot","clsx","react","react-dom","tailwindcss"]',
    );
  }, 30_000);

  it("rejects a remote media request before it can reach the compiler", async () => {
    await expect(
      validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<img src="https://tracking.invalid/pixel.png" alt="" />);`,
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_SOURCE_NETWORK_FORBIDDEN",
    });
  }, 30_000);

  it("hard-fails an indirect external request hidden in data before compilation", async () => {
    await expect(
      validatedSource({
        additional: {
          "src/content.json": JSON.stringify({
            hero: "https://tracking.invalid/pixel.png",
          }),
        },
        main: `import React from "react";
import { createRoot } from "react-dom/client";
import content from "./content.json";
function App() { return <main><h1>企业官网</h1><img src={content.hero} alt="" /></main>; }
createRoot(document.getElementById("root")!).render(<App />);`,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_SOURCE_NETWORK_FORBIDDEN" });
  }, 30_000);

  it("returns only a safe file coordinate for a compiler failure", async () => {
    const source = await validatedSource({
      main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<main><h1>缺少闭合标签</main>);`,
    });
    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_COMPILE_FAILED",
      diagnostics: [
        expect.objectContaining({
          file: "src/main.tsx",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ],
    });
  }, 30_000);

  it("rejects a missing local asset after compilation", async () => {
    const source = await validatedSource({
      main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<img src="/missing-company-logo.png" alt="企业标志" />);`,
    });
    await expect(
      materializeNativeReactSource({
        sourceZip: source.sourceZip,
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_LOCAL_ASSET_MISSING",
    });
  }, 30_000);

  browserIt(
    "rejects a compiled native site whose React root remains empty",
    async () => {
      const source = await validatedSource({
        main: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(null);`,
      });
      await expect(
        materializeNativeReactSource({
          sourceZip: source.sourceZip,
          validatedSource: source,
          build: BUILD,
          brief: BRIEF,
          mode: "preview",
          lighthouseQa: false,
        }),
      ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
        code: "NATIVE_BUILD_RENDER_FAILED",
      });
    },
    30_000,
  );

  it("rebuilds production from the same source archive with canonical routes", async () => {
    const source = await validatedSource();
    const result = await rebuildNativeReactProductionFromSource({
      sourceZip: source.sourceZip,
      validatedSource: source,
      build: BUILD,
      brief: BRIEF,
      canonicalOrigin: "https://www.example.test",
      target: "global_excluding_cn",
      browserQa: false,
    });
    expect(result.sourceZip.equals(source.sourceZip)).toBe(true);
    expect(result.contract.mode).toBe("production");
    expect(result.contract.canonicalOrigin).toBe("https://www.example.test");
    expect(result.contract.target).toBe("global_excluding_cn");
    expect(
      result.files.get("applications/index.html")?.toString("utf8"),
    ).toContain(
      'rel="canonical" href="https://www.example.test/applications/"',
    );
    expect(result.files.get("sitemap.xml")?.toString("utf8")).toContain(
      "https://www.example.test/applications/",
    );
    expect(result.files.get("index.html")?.toString("utf8")).toContain(
      'http-equiv="Content-Security-Policy"',
    );
  }, 30_000);

  it("refuses a source archive that differs from the validated bytes", async () => {
    const source = await validatedSource();
    await expect(
      materializeNativeReactSource({
        sourceZip: Buffer.concat([source.sourceZip, Buffer.from("changed")]),
        validatedSource: source,
        build: BUILD,
        brief: BRIEF,
        mode: "preview",
        browserQa: false,
      }),
    ).rejects.toMatchObject<Partial<NativeReactBuildError>>({
      code: "NATIVE_BUILD_SOURCE_MISMATCH",
    });
  });
});
