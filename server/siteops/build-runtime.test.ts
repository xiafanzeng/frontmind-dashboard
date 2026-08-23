import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

const browserQaMocks = vi.hoisted(() => {
  const screenshot = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const goto = vi.fn(async (url: string) => {
    const response = await fetch(url);
    await response.arrayBuffer();
    return { ok: () => response.ok };
  });
  const page = {
    goto,
    setViewportSize: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => screenshot),
  };
  const browserLaunch = vi.fn(async () => ({
    newContext: vi.fn(async () => ({
      newPage: vi.fn(async () => page),
    })),
    close: vi.fn(async () => undefined),
  }));
  const axeAnalyze = vi.fn(async () => ({ violations: [] }));
  const chromeLaunch = vi.fn(async () => ({
    port: 9222,
    kill: vi.fn(),
  }));
  const lighthouse = vi.fn(async (url: string) => {
    const response = await fetch(url);
    await response.arrayBuffer();
    return {
      lhr: {
        categories: {
          performance: { score: 0.95 },
          accessibility: { score: 1 },
          "best-practices": { score: 1 },
          seo: { score: 1 },
        },
        audits: {
          "cumulative-layout-shift": { numericValue: 0.01 },
        },
      },
    };
  });
  return {
    axeAnalyze,
    browserLaunch,
    chromeLaunch,
    goto,
    lighthouse,
  };
});

vi.mock("playwright", () => ({
  chromium: {
    executablePath: () => "/frontmind-test/chromium",
    launch: browserQaMocks.browserLaunch,
  },
}));

vi.mock("@axe-core/playwright", () => ({
  default: class MockAxeBuilder {
    withTags() {
      return this;
    }

    analyze() {
      return browserQaMocks.axeAnalyze();
    }
  },
}));

vi.mock("chrome-launcher", () => ({
  launch: browserQaMocks.chromeLaunch,
}));

vi.mock("lighthouse", () => ({
  default: browserQaMocks.lighthouse,
}));

import { SITEOPS_WORKFLOW } from "../../shared/siteops";
import {
  generateSocialPackage,
  materializeAstroSite,
  materializeProductionSiteFromSource,
  SiteOpsMaterializationError,
  type MaterializeAstroSiteInput,
  type SocialPackageInput,
} from "./build-runtime";

const H = (value: string) => createHash("sha256").update(value).digest("hex");

function luminance(hex: string) {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function ratio(left: string, right: string) {
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

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
      providerItemKey: "n:143",
      visualEvidenceSha256: H("visual-evidence"),
      previewSha256: H("same-origin-preview"),
      supportEvidenceSha256s: [],
      taxonomy: {
        role: "foundation",
        palette: ["#10212B", "#EF6C45", "#F5F2EA", "#DDE7E8"],
        typography: ["neutral sans"],
        layout: ["asymmetric grid"],
        motion: ["reduced motion"],
        accessibility: ["high contrast"],
      },
    },
    designSpec: {
      schemaVersion: 1,
      layoutArchetype: "asymmetric",
      heroVariant: "split_media",
      density: "balanced",
      surfaceStyle: "bordered",
      typeScale: "display",
      imageTreatment: "contained",
      motionLevel: "subtle",
      colorRoles: {
        backgroundPaletteIndex: 2,
        textPaletteIndex: 0,
        accentPaletteIndex: 1,
      },
      routeCompositions: [
        {
          routeId: "home",
          slots: [
            { slotId: "service-proof", variant: "proof" },
            { slotId: "audience", variant: "split" },
          ],
        },
        {
          routeId: "services",
          slots: [{ slotId: "service-list", variant: "cards" }],
        },
      ],
      seoPlan: {
        siteTitle: "星河智造",
        description:
          "面向制造企业的设备运维与状态分析服务。\u2028</script><img onerror=alert(1)>",
        organizationType: "ProfessionalService",
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
              slotId: "service-proof",
              heading: "设备运维",
              paragraphs: ["服务覆盖设备巡检、状态分析和维护建议。"],
              sourceDocumentIds: ["service"],
            },
            {
              slotId: "audience",
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
              slotId: "service-list",
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
      {
        id: "private-evidence",
        sha256: H("private-evidence"),
        decision: "quarantine",
      },
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
    expect(browserQaMocks.browserLaunch).toHaveBeenCalledTimes(1);
    expect(browserQaMocks.axeAnalyze).toHaveBeenCalled();
    expect(browserQaMocks.lighthouse).toHaveBeenCalledTimes(1);
    expect(browserQaMocks.goto).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//u),
      expect.objectContaining({ waitUntil: "networkidle" }),
    );
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
    expect(sourceNames).toContain("frontmind-component-manifest.json");
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
      schemaVersion: 2,
      visual: {
        providerItemKey: "n:143",
        visualEvidenceSha256: H("visual-evidence"),
        componentLibraryVersion: "1.0.0",
      },
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
    expect(home).toContain('class="hero hero--split_media"');
    expect(home).toContain(
      'class="section section--proof" data-slot="service-proof"',
    );
    expect(home).toContain(
      'class="section section--split" data-slot="audience"',
    );
    expect(home).toContain(
      'class="layout--asymmetric surface--bordered type--display image--contained motion--subtle"',
    );
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

  it("allows a duplicate official-logo SHA only when the alias is omitted", async () => {
    const input = buildInput();
    const logoSha256 = H(officialLogo);
    input.assetDecisions = [
      { id: "official-logo", sha256: logoSha256, decision: "publish" },
      { id: "official-logo-alias", sha256: logoSha256, decision: "omit" },
    ];
    input.brandAsset = {
      schemaVersion: 1,
      assetId: "official-logo",
      sha256: logoSha256,
      mimeType: "image/png",
      publicPath: "public/brand-logo.png",
      sizeBytes: officialLogo.length,
      width: 160,
      height: 80,
      bytes: officialLogo,
    };

    const built = await materializeAstroSite(input);
    expect(built.contract.assets).toEqual([
      { id: "official-logo", sha256: logoSha256, decision: "publish" },
      { id: "official-logo-alias", sha256: logoSha256, decision: "omit" },
    ]);
  }, 90_000);

  it("rejects publish and quarantine decisions for the same physical bytes at asset projection", async () => {
    const input = buildInput();
    const logoSha256 = H(officialLogo);
    input.assetDecisions = [
      { id: "official-logo", sha256: logoSha256, decision: "publish" },
      {
        id: "official-logo-conflict",
        sha256: logoSha256,
        decision: "quarantine",
      },
    ];
    input.brandAsset = {
      schemaVersion: 1,
      assetId: "official-logo",
      sha256: logoSha256,
      mimeType: "image/png",
      publicPath: "public/brand-logo.png",
      sizeBytes: officialLogo.length,
      width: 160,
      height: 80,
      bytes: officialLogo,
    };

    await expect(materializeAstroSite(input)).rejects.toMatchObject({
      name: "SiteOpsMaterializationError",
      phase: "asset_projection",
      code: "SITEOPS_ASSET_DECISION_HASH_CONFLICT",
      retryClass: "host_deterministic",
      safeDetails: {
        assetDecisionCount: 2,
        publishedCount: 1,
        omittedDuplicateCount: 0,
        quarantineCount: 1,
      },
    });
  });

  it("keeps all provider/customer text in JSON data and renders syntax sentinels as inert text", async () => {
    const sentinels = [
      "{A}",
      "{{x}}",
      "${process.env.SECRET}",
      "孤立 { 和 }",
      "`反引号` ---",
      "<script>alert(1)</script>",
      "</section><img src=x onerror=alert(1)>",
      '\"><script>alert(2)</script>',
    ];
    const payload = sentinels.join(" | ");
    const sourceId = `source-${payload}`;
    const input = buildInput();
    input.snapshot.documents[1]!.id = sourceId;
    (input.brief as any).contacts = [
      {
        kind: "address",
        value: payload,
        sourceDocumentIds: ["overview"],
      },
    ];
    (input.brief as any).routes[0].sourceDocumentIds = ["overview", sourceId];
    (input.brief as any).routes[1].sourceDocumentIds = [sourceId];
    (input.brief as any).verifiedFacts[0].sourceDocumentIds = [
      "overview",
      sourceId,
    ];
    (input.generatedContent as any).routes[0].heading = payload;
    (input.generatedContent as any).routes[0].summary = payload;
    (input.generatedContent as any).routes[0].sections[0].heading = payload;
    (input.generatedContent as any).routes[0].sections[0].paragraphs = [
      payload,
    ];
    (input.generatedContent as any).routes[0].sections[0].sourceDocumentIds = [
      sourceId,
    ];
    (input.generatedContent as any).routes[1].sections[0].sourceDocumentIds = [
      sourceId,
    ];

    const built = await materializeAstroSite(input);
    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    const astroFiles = await Promise.all(
      Object.values(source.files)
        .filter((entry) => !entry.dir && entry.name.endsWith(".astro"))
        .map((entry) => entry.async("string")),
    );
    for (const sentinel of sentinels) {
      expect(astroFiles.join("\n")).not.toContain(sentinel);
    }
    const dataFiles = await Promise.all(
      Object.values(source.files)
        .filter(
          (entry) =>
            !entry.dir &&
            entry.name.startsWith("src/data/") &&
            entry.name.endsWith(".json"),
        )
        .map((entry) => entry.async("string")),
    );
    for (const sentinel of sentinels) {
      expect(dataFiles.join("\n")).toContain(sentinel);
    }
    const dist = await JSZip.loadAsync(built.distZip, { checkCRC32: true });
    const home = await dist.file("index.html")!.async("string");
    const body = home.slice(home.indexOf("<body"));
    expect(body).toContain("{A}");
    expect(body).toContain("{{x}}");
    expect(body).toContain("${process.env.SECRET}");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).not.toContain("<script>alert(2)</script>");
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
  }, 90_000);

  it("materializes semantic colors that satisfy every text/background contrast contract", async () => {
    const input = buildInput();
    (input.visual as any).taxonomy.palette = [
      "#080808",
      "#FFFFFF",
      "#292929",
      "#161616",
    ];
    (input.designSpec as any).colorRoles = {
      backgroundPaletteIndex: 0,
      textPaletteIndex: 1,
      accentPaletteIndex: 2,
    };
    (input.designSpec as any).routeCompositions[0].slots[0].variant = "cta";
    const built = await materializeAstroSite(input);
    const source = await JSZip.loadAsync(built.sourceZip, { checkCRC32: true });
    const css = await source.file("public/styles.css")!.async("string");
    const variables = Object.fromEntries(
      [...css.matchAll(/--(ink|accent|canvas|muted):(#[A-Fa-f0-9]{6})/gu)].map(
        (match) => [match[1], match[2]],
      ),
    ) as Record<"ink" | "accent" | "canvas" | "muted", string>;
    expect(ratio(variables.ink, variables.canvas)).toBeGreaterThanOrEqual(7);
    expect(ratio(variables.accent, variables.canvas)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(ratio(variables.ink, variables.muted)).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain(".source-note{color:var(--ink)");
    expect(css).toContain(
      ".section--cta .source-note{color:var(--canvas)}",
    );
    expect(css).not.toMatch(/\.source-note\{[^}]*opacity/gu);
  }, 90_000);

  it("fails closed when the browser QA runtime is unavailable", async () => {
    browserQaMocks.browserLaunch.mockRejectedValueOnce(
      new Error("TEST_BROWSER_QA_UNAVAILABLE"),
    );
    try {
      await materializeAstroSite(buildInput());
      throw new Error("TEST_EXPECTED_MATERIALIZATION_REJECTION");
    } catch (error) {
      expect(error).toBeInstanceOf(SiteOpsMaterializationError);
      expect(error).toMatchObject({
        phase: "browser_qa",
        code: "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
        retryClass: "host_transient",
        safeDetails: {},
      });
    }
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

  it("stops production materialization when the deployment signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      materializeProductionSiteFromSource({
        sourceZip: previewBuild.sourceZip,
        expectedSourceSha256: previewBuild.sourceSha256,
        canonicalOrigin: "https://www.xinghe.example",
        target: "global_excluding_cn",
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({
      phase: "input_validation",
      code: "SITEOPS_MATERIALIZATION_ABORTED",
      retryClass: "host_transient",
    });
  });

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
