import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { visualSelectionBundleV5Schema } from "../../shared/siteops";
import type { NormalizedTwentyFirstCandidate } from "../../shared/siteops-workflow";
import { validateNativeReactSourceArchive } from "./native-react-source";
import { materializeNativeReactSource } from "./native-react-build-runtime";
import {
  createNativeSourceArchive,
  createVisualSelectionBundleV5Artifact,
  normalizeTwentyFirstNativeSource,
  readNativeSourceArchive,
  readVisualSelectionBundleArtifact,
  renderNativeReactSourcePreview,
  selectedNativeSourceArchive,
} from "./native-visual-source";

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function searchCandidate(id = 1) {
  return {
    providerItemId: id,
    providerItemKey: `n:${id}`,
  } as NormalizedTwentyFirstCandidate;
}

function payload(id: number, suffix = "") {
  return {
    data: {
      id,
      version: `v${id}`,
      componentCode: [
        'import React from "react";',
        `export default function NativeHero${suffix}(){return <main className="min-h-screen bg-white text-slate-950"><h1>Native ${id}</h1></main>}`,
      ].join("\n"),
      demoCode: [
        'import React from "react";',
        `import NativeHero from "./component";`,
        `export default function Demo${suffix}(){return <NativeHero />}`,
      ].join("\n"),
      globalsCss: "body{font-family:system-ui,sans-serif}",
      dependencies: ["react@19.2.1", "react-dom@19.2.1"],
    },
  };
}

describe("21st native visual source", () => {
  it("normalizes the advertised get_component payload into a deterministic source archive", async () => {
    const source = normalizeTwentyFirstNativeSource({
      candidate: searchCandidate(143),
      payload: payload(143),
    });
    expect(source).toMatchObject({
      providerItemKey: "n:143",
      providerVersion: "v143",
      entrypoint: "src/provider/component.tsx",
      demoEntrypoint: "src/provider/demo.tsx",
      htmlEntrypoint: "index.html",
      appEntrypoint: "src/main.tsx",
      dependencies: expect.arrayContaining([
        { name: "react", installedVersion: "19.2.1" },
        { name: "react-dom", installedVersion: "19.2.1" },
        { name: "tailwindcss", installedVersion: "4.1.14" },
        { name: "vite", installedVersion: "7.1.9" },
      ]),
    });
    const first = await createNativeSourceArchive(source);
    const second = await createNativeSourceArchive(source);
    expect(first.equals(second)).toBe(true);
    const restored = await readNativeSourceArchive(first);
    expect(restored.manifest.sourceTreeSha256).toBe(source.sourceTreeSha256);
    expect(restored.files.map((file) => file.path)).toEqual([
      "index.html",
      "package.json",
      "src/frontmind-tailwind.css",
      "src/main.tsx",
      "src/provider/component.tsx",
      "src/provider/demo.tsx",
      "src/provider/globals.css",
    ]);
  });

  it("rejects traversal, dynamic execution and unapproved dependencies", () => {
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(),
        payload: {
          id: 1,
          files: { "../escape.tsx": "export default function X(){}" },
        },
      }),
    ).toThrow("NATIVE_SOURCE_PATH_UNSAFE");
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(),
        payload: {
          ...payload(1).data,
          componentCode: "export default function X(){eval('x');return null}",
        },
      }),
    ).toThrow("NATIVE_SOURCE_EXECUTION_UNSAFE");
    expect(() =>
      normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(),
        payload: {
          ...payload(1).data,
          dependencies: ["untrusted-runtime@1.0.0"],
        },
      }),
    ).toThrow("NATIVE_SOURCE_DEPENDENCY_UNSAFE");
  });

  it("renders the normalized React source rather than a provider screenshot", async () => {
    const source = normalizeTwentyFirstNativeSource({
      candidate: searchCandidate(7),
      payload: payload(7),
    });
    const sourceArchive = await createNativeSourceArchive(source);
    const preview = await renderNativeReactSourcePreview({
      sourceArchive,
      signal: new AbortController().signal,
    });
    const metadata = await sharp(preview).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBeGreaterThanOrEqual(1000);
  }, 30_000);

  it("rejects a candidate whose React render throws", async () => {
    const source = normalizeTwentyFirstNativeSource({
      candidate: searchCandidate(8),
      payload: {
        data: {
          ...payload(8).data,
          componentCode:
            'export default function Broken(){throw new Error("boom");}',
          demoCode:
            'import Broken from "./component"; export default function Demo(){return <Broken />}',
        },
      },
    });
    const sourceArchive = await createNativeSourceArchive(source);
    await expect(
      renderNativeReactSourcePreview({
        sourceArchive,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("NATIVE_PREVIEW_RENDER_FAILED");
  }, 30_000);

  it("round-trips nine nested source archives and selects one by candidate ID", async () => {
    const sourceArchives = new Map<string, Buffer>();
    const candidates = [];
    for (let index = 0; index < 9; index += 1) {
      const label = String.fromCharCode(65 + index);
      const id = `candidate-${label}`;
      const source = normalizeTwentyFirstNativeSource({
        candidate: searchCandidate(index + 1),
        payload: payload(index + 1, label),
      });
      const archive = await createNativeSourceArchive(source);
      sourceArchives.set(id, archive);
      const referencePreviewSha256 = digest(`reference-${label}`);
      candidates.push({
        id,
        label,
        queryAxis: "foundation_split" as const,
        providerItemId: String(index + 1),
        providerItemKey: `n:${index + 1}`,
        providerVersion: `v${index + 1}`,
        title: `Native ${label}`,
        description: null,
        author: null,
        sourceUrl: `https://21st.dev/community/components/${index + 1}`,
        visualEvidence: {
          evidenceKind: "catalog_metadata_preview_v1" as const,
          providerItemKey: `n:${index + 1}`,
          metadataSha256: digest(`metadata-${label}`),
          providerResponseSha256: digest(`response-${label}`),
          previewSha256: referencePreviewSha256,
          taxonomyDerivationVersion: "catalog-metadata-preview-v1" as const,
          evidenceSha256: digest(`evidence-${label}`),
        },
        referencePreviewLocalAssetId: `00000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`,
        referencePreviewSha256,
        referencePerceptualHash: digest(`phash-${label}`).slice(0, 16),
        previewLocalAssetId: `10000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`,
        previewSha256: digest(`native-preview-${label}`),
        taxonomy: {
          role: "foundation" as const,
          palette: [],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        score: 90 - index,
        rationale: "真实原生源码候选",
        sourceTreeSha256: source.sourceTreeSha256,
        sourceArchiveSha256: digest(archive),
        sourceArchivePath: `candidates/${label}/source.zip`,
        entrypoint: source.entrypoint,
        demoEntrypoint: source.demoEntrypoint,
        sourceDirectory: "source" as const,
      });
    }
    const bundle = visualSelectionBundleV5Schema.parse({
      schemaVersion: 5,
      renderer: "twenty_first_native_react_v1",
      queryPlanHash: digest("query-plan"),
      searchTarget: 162,
      displayTarget: 9,
      candidates,
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    });
    const artifactBytes = await createVisualSelectionBundleV5Artifact({
      bundle,
      sourceArchives,
    });
    const restored = await readVisualSelectionBundleArtifact(artifactBytes);
    expect(restored.bundle.schemaVersion).toBe(5);
    expect(restored.archives).toHaveLength(9);
    const selected = await selectedNativeSourceArchive({
      artifactBytes,
      selectedCandidateId: "candidate-H",
    });
    expect(selected.candidate.label).toBe("H");
    expect(selected.manifest.providerItemKey).toBe("n:8");
    expect(selected.bundle.queryPlanHash).toBe(digest("query-plan"));

    const operationToken =
      "siteops-native-selected:30000000-0000-4000-8000-000000000001";
    const validated = await validateNativeReactSourceArchive({
      archive: selected.archiveBytes,
      receipt: {
        operationToken,
        baseSourceSha256: selected.archiveSha256,
        archiveSha256: selected.archiveSha256,
        fileCount: selected.files.length + 1,
      },
      expectedOperationToken: operationToken,
      expectedBaseSourceSha256: selected.archiveSha256,
    });
    expect(validated.entrypoint).toBe("src/main.tsx");
    expect(validated.files.get("index.html")?.toString("utf8")).toContain(
      'src="/src/main.tsx"',
    );
    const materialized = await materializeNativeReactSource({
      sourceZip: selected.archiveBytes,
      validatedSource: validated,
      build: {
        id: "30000000-0000-4000-8000-000000000002",
        projectId: "30000000-0000-4000-8000-000000000003",
        knowledgeSnapshotId: "30000000-0000-4000-8000-000000000004",
        workflowVersion: "2.5.0",
        selectionHash: digest("selected-native-archive"),
      },
      brief: {
        companyName: "原生候选测试企业",
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
        ],
        verifiedFacts: [
          {
            statement: "这是已核验的企业介绍。",
            sourceDocumentIds: ["source-1"],
          },
        ],
        publicAssetIds: [],
        unknowns: [],
      },
      mode: "preview",
      browserQa: false,
    });
    expect(materialized.sourceZip.equals(selected.archiveBytes)).toBe(true);
    expect(materialized.files.has("index.html")).toBe(true);

    const zip = await JSZip.loadAsync(artifactBytes);
    zip.file("unexpected.txt", "nope");
    const unexpected = await zip.generateAsync({ type: "nodebuffer" });
    await expect(readVisualSelectionBundleArtifact(unexpected)).rejects.toThrow(
      "V5_SELECTION_BUNDLE_UNEXPECTED_ENTRY",
    );
  }, 45_000);
});
