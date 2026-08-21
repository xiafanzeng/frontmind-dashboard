import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { SITEOPS_WORKFLOW } from "../../shared/siteops";
import {
  generateSocialPackage,
  materializeAstroSite,
  materializeProductionSiteFromSource,
  type MaterializeAstroSiteInput,
  type SocialPackageInput,
} from "./build-runtime";

const H = (value: string) => createHash("sha256").update(value).digest("hex");

function buildInput(
  mode: "preview" | "production" = "preview",
): MaterializeAstroSiteInput {
  const snapshotId = "10000000-0000-4000-8000-000000000001";
  const archiveHash = H("knowledge-archive");
  return {
    build: {
      id: "20000000-0000-4000-8000-000000000002",
      projectId: "30000000-0000-4000-8000-000000000003",
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      knowledgeArchiveHash: archiveHash,
      workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
      workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
      workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
      workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
      starterVersion: SITEOPS_WORKFLOW.starterVersion,
      selectionHash: H("selection"),
    },
    snapshot: {
      id: snapshotId,
      userId: 7,
      archiveHash,
      sourceBuildId: "40000000-0000-4000-8000-000000000004",
      sourceBuildRevision: 3,
      documents: [
        {
          id: "overview",
          path: "overview.md",
          title: "企业概览",
          content: "星河智造为制造企业提供经过确认的设备运维与数据服务。",
          kind: "overview",
          customerVisible: true,
        },
        {
          id: "service",
          path: "services/maintenance.md",
          title: "设备运维服务",
          content: "服务覆盖设备巡检、状态分析和维护建议。",
          kind: "leaf",
          customerVisible: true,
        },
      ],
    },
    brief: {
      companyName: "星河智造",
      primaryLanguage: "zh-CN",
      contacts: [
        {
          kind: "email",
          value: "hello@xinghe.example",
          sourceDocumentIds: ["overview"],
        },
      ],
      offerings: ["设备运维", "状态分析"],
      audience: ["制造企业"],
      conversionGoal: "联系业务团队",
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["overview", "service"],
        },
        {
          id: "services",
          slug: "/services",
          title: "服务",
          sourceDocumentIds: ["service"],
        },
      ],
      verifiedFacts: [
        {
          statement: "提供设备运维与状态分析服务",
          sourceDocumentIds: ["overview", "service"],
        },
      ],
      publicAssetIds: [],
      unknowns: [],
    },
    visual: {
      queryHash: H("queries"),
      selectedCandidateId: "candidate-B",
      promptSha256: H("ephemeral-prompt"),
      previewSha256: H("same-origin-preview"),
      taxonomy: {
        role: "foundation",
        palette: ["#10212B", "#EF6C45", "#F5F2EA", "#DDE7E8"],
        typography: ["neutral sans"],
        layout: ["asymmetric grid"],
        motion: ["reduced motion"],
        accessibility: ["high contrast"],
      },
    },
    generatedContent: {
      seo: {
        siteTitle: "星河智造",
        description:
          "面向制造企业的设备运维与状态分析服务。\u2028</script><img onerror=alert(1)>",
        organizationType: "ProfessionalService",
      },
      routes: [
        {
          routeId: "home",
          eyebrow: "可靠的制造服务",
          heading: "让设备状态更清晰",
          summary: "基于确认的企业资料，展示设备运维与状态分析能力。",
          sections: [
            {
              heading: "设备运维",
              paragraphs: ["服务覆盖设备巡检、状态分析和维护建议。"],
              sourceDocumentIds: ["service"],
            },
            {
              heading: "面向制造企业",
              paragraphs: ["团队为制造企业提供经过确认的设备数据服务。"],
              sourceDocumentIds: ["overview"],
            },
          ],
        },
        {
          routeId: "services",
          heading: "设备服务",
          summary: "查看设备巡检、状态分析和维护建议。",
          sections: [
            {
              heading: "服务范围",
              paragraphs: ["服务覆盖设备巡检、状态分析和维护建议。"],
              sourceDocumentIds: ["service"],
            },
          ],
        },
      ],
    },
    mode,
    canonicalOrigin:
      mode === "production" ? "https://www.xinghe.example" : null,
  };
}

describe("SiteOps controlled Astro runtime", () => {
  let previewBuild: Awaited<ReturnType<typeof materializeAstroSite>>;
  let officialLogo: Buffer;

  beforeAll(async () => {
    officialLogo = await sharp({
      create: {
        width: 160,
        height: 80,
        channels: 4,
        background: { r: 16, g: 72, b: 105, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const input = buildInput();
    input.assetDecisions = [
      { id: "official-logo", sha256: H(officialLogo), decision: "publish" },
      { id: "private-evidence", sha256: H("private-evidence"), decision: "quarantine" },
    ];
    input.brandAsset = {
      schemaVersion: 1,
      assetId: "official-logo",
      sha256: H(officialLogo),
      mimeType: "image/png",
      publicPath: "public/brand-logo.png",
      sizeBytes: officialLogo.length,
      width: 160,
      height: 80,
      bytes: officialLogo,
    };
    previewBuild = await materializeAstroSite(input);
  }, 90_000);

  it("builds real no-JavaScript Astro HTML and a private noindex preview", async () => {
    const built = previewBuild;
    expect(built.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(built.distSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(built.contract.specHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(built.qaJson.toString("utf8"))).toMatchObject({
      passed: true,
      mode: "preview",
      browser: {
        axeViolationCount: 0,
        lighthouse: {
          performance: expect.any(Number),
          accessibility: expect.any(Number),
          bestPractices: expect.any(Number),
          seo: expect.any(Number),
          cls: expect.any(Number),
        },
      },
    });
    expect(built.visualQaSha256).toMatch(/^[a-f0-9]{64}$/u);
    const visualQa = await JSZip.loadAsync(built.visualQaZip, {
      checkCRC32: true,
    });
    expect(visualQa.file("visual-qa/report.json")).not.toBeNull();
    expect(visualQa.file("screenshots/home-390.png")).not.toBeNull();
    expect(visualQa.file("screenshots/home-768.png")).not.toBeNull();
    expect(visualQa.file("screenshots/home-1440.png")).not.toBeNull();

    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    const sourceNames = Object.keys(source.files);
    expect(sourceNames).toContain("astro.config.mjs");
    expect(sourceNames).toContain("frontmind-runtime-lock.json");
    expect(sourceNames).toContain("frontmind-runtime-input.json");
    expect(sourceNames).toContain("build-contract.json");
    expect(sourceNames).toContain("public/brand-logo.png");
    expect(sourceNames).not.toContain("node_modules/");
    expect(
      (await source.file("public/brand-logo.png")!.async("nodebuffer")).equals(
        officialLogo,
      ),
    ).toBe(true);
    expect(
      JSON.parse(await source.file("build-contract.json")!.async("string")),
    ).toMatchObject({
      assets: [
        {
          id: "official-logo",
          sha256: H(officialLogo),
          decision: "publish",
        },
        { id: "private-evidence", decision: "quarantine" },
      ],
    });
    expect(await source.file("package.json")!.async("string")).toContain(
      `\"astro\": \"7.2.4\"`,
    );

    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    const home = await dist.file("index.html")!.async("string");
    expect(home).toContain("让设备状态更清晰");
    expect(home).toContain('class="brand-logo"');
    expect(home).toContain('src="/brand-logo.png"');
    expect(
      (await dist.file("brand-logo.png")!.async("nodebuffer")).equals(
        officialLogo,
      ),
    ).toBe(true);
    expect(home).toContain('name="robots" content="noindex,nofollow"');
    expect(home).not.toContain('rel="canonical"');
    expect(home).not.toMatch(/<script\b/iu);
    expect(await dist.file("robots.txt")!.async("string")).toContain(
      "Disallow: /",
    );
    expect(dist.file("sitemap.xml")).toBeNull();
    expect(dist.file("llms.txt")).toBeNull();
  }, 90_000);

  it("emits exact production discovery metadata without false hreflang", async () => {
    const built = await materializeProductionSiteFromSource({
      sourceZip: previewBuild.sourceZip,
      expectedSourceSha256: previewBuild.sourceSha256,
      canonicalOrigin: "https://www.xinghe.example",
      target: "global_excluding_cn",
    });
    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    const home = await dist.file("index.html")!.async("string");
    const services = await dist.file("services/index.html")!.async("string");
    expect(home).toContain(
      'rel="canonical" href="https://www.xinghe.example/"',
    );
    expect(services).toContain(
      'rel="canonical" href="https://www.xinghe.example/services/"',
    );
    expect(home).toContain('type="application/ld+json"');
    expect(home).toContain(
      "\\u2028\\u003c/script>\\u003cimg onerror=alert(1)>",
    );
    expect(home).not.toContain("</script><img onerror=alert(1)>");
    expect(home).not.toContain("\u2028");
    expect(home).not.toContain("hreflang=");
    expect(await dist.file("sitemap.xml")!.async("string")).toContain(
      "https://www.xinghe.example/services/",
    );
    expect(await dist.file("llms.txt")!.async("string")).toContain("星河智造");
    expect(
      (await dist.file("brand-logo.png")!.async("nodebuffer")).equals(
        officialLogo,
      ),
    ).toBe(true);
  }, 90_000);

  it("rejects a source ZIP whose frozen official logo bytes were replaced", async () => {
    const source = await JSZip.loadAsync(previewBuild.sourceZip, {
      checkCRC32: true,
    });
    source.file("public/brand-logo.png", Buffer.from("not-the-logo", "utf8"));
    const tampered = await source.generateAsync({ type: "nodebuffer" });
    await expect(
      materializeProductionSiteFromSource({
        sourceZip: tampered,
        expectedSourceSha256: H(tampered),
        canonicalOrigin: "https://www.xinghe.example",
        target: "global_excluding_cn",
      }),
    ).rejects.toThrow("SITEOPS_BRAND_ASSET_HASH_MISMATCH");
  });

  it("rejects source-coordinate drift, unsafe slugs and ungrounded sections", async () => {
    await expect(
      materializeProductionSiteFromSource({
        sourceZip: previewBuild.sourceZip,
        expectedSourceSha256: H("wrong-source"),
        canonicalOrigin: "https://www.xinghe.example",
        target: "global_excluding_cn",
      }),
    ).rejects.toThrow("SITEOPS_PRODUCTION_SOURCE_HASH_MISMATCH");

    const drifted = buildInput();
    drifted.snapshot.archiveHash = H("different");
    await expect(materializeAstroSite(drifted)).rejects.toThrow(
      "SITEOPS_SNAPSHOT_COORDINATES_MISMATCH",
    );

    const traversal = buildInput();
    (traversal.brief as any).routes[1].slug = "/../secret";
    await expect(materializeAstroSite(traversal)).rejects.toThrow(
      "SITEOPS_ROUTE_SLUG_INVALID",
    );

    const ungrounded = buildInput();
    (
      ungrounded.generatedContent as any
    ).routes[1].sections[0].sourceDocumentIds = ["overview"];
    await expect(materializeAstroSite(ungrounded)).rejects.toThrow(
      "SITEOPS_GENERATED_SOURCE_MAPPING_INVALID",
    );
  });
});

function socialInput(channel: "wechat" | "xiaohongshu"): SocialPackageInput {
  const sections = Array.from(
    { length: channel === "xiaohongshu" ? 8 : 3 },
    (_, index) => ({
      heading: `知识要点 ${index + 1}`,
      paragraphs: [
        `这是从已确认企业资料整理的第 ${index + 1} 个要点，不包含未经证实的数据。`,
      ],
      sourceDocumentIds: [index % 2 === 0 ? "overview" : "service"],
    }),
  );
  return {
    channel,
    companyName: "星河智造",
    title: "如何建立可追溯的设备运维内容",
    deck: "把企业知识来源和每一条对外表达保持一致。",
    sourceDocuments: [
      { id: "overview", title: "企业概览", sha256: H("overview") },
      { id: "service", title: "设备运维服务", sha256: H("service") },
    ],
    sections,
    hashtags: ["设备运维", "企业知识库"],
  };
}

describe("SiteOps strict social packages", () => {
  it("creates the exact WeChat package with three 2.35:1 covers", async () => {
    const generated = await generateSocialPackage(socialInput("wechat"));
    const zip = await JSZip.loadAsync(generated.archive, { checkCRC32: true });
    expect(Object.keys(zip.files).sort()).toEqual(
      [
        "article.md",
        "covers/01.png",
        "covers/02.png",
        "covers/03.png",
        "manifest.json",
        "qa-report.json",
        "sources.json",
        "title.txt",
      ].sort(),
    );
    expect(generated.manifest.files).toHaveLength(7);
    for (const preview of generated.previews) {
      const metadata = await sharp(preview.buffer).metadata();
      expect(metadata).toMatchObject({
        width: 1410,
        height: 600,
        format: "png",
      });
      const manifestFile = generated.manifest.files.find(
        (file) => file.path === preview.filename,
      );
      expect(manifestFile).toMatchObject({
        mimeType: "image/png",
        bytes: preview.buffer.length,
        sha256: preview.sha256,
      });
    }
    expect(await zip.file("article.md")!.async("string")).toContain(
      "来源：overview",
    );
  }, 90_000);

  it("creates a branded 01–09 Xiaohongshu package and no publishing payload", async () => {
    const generated = await generateSocialPackage(socialInput("xiaohongshu"));
    const zip = await JSZip.loadAsync(generated.archive, { checkCRC32: true });
    const names = Object.keys(zip.files).sort();
    expect(names.filter((name) => name.startsWith("images/"))).toHaveLength(9);
    expect(names).toContain("images/01-cover.png");
    expect(names).toContain("images/09-section-08.png");
    expect(names).toContain("post-copy.md");
    expect(names).not.toContain("publish.json");
    expect(generated.qa).toMatchObject({
      passed: true,
      automatedPublishing: false,
      credentialsIncluded: false,
      imageCount: 9,
    });
    for (const preview of generated.previews) {
      const metadata = await sharp(preview.buffer).metadata();
      expect(metadata).toMatchObject({
        width: 1080,
        height: 1440,
        format: "png",
      });
    }
  }, 90_000);

  it("rejects unknown source mappings and a non-nine-page Xiaohongshu input", async () => {
    const unknown = socialInput("wechat");
    unknown.sections[0]!.sourceDocumentIds = ["missing"];
    await expect(generateSocialPackage(unknown)).rejects.toThrow(
      "SITEOPS_SOCIAL_SOURCE_MAPPING_INVALID",
    );

    const short = socialInput("xiaohongshu");
    short.sections.pop();
    await expect(generateSocialPackage(short)).rejects.toThrow(
      "SITEOPS_XIAOHONGSHU_EIGHT_SECTIONS_REQUIRED",
    );
  });
});
