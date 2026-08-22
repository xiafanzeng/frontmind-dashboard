import { describe, expect, it } from "vitest";

import { siteDesignMaterializationProjection } from "./build-runtime";

function design(overrides: Record<string, unknown> = {}) {
  return {
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
        slots: [{ slotId: "proof", variant: "proof" }],
      },
    ],
    seoPlan: {
      siteTitle: "FrontMind",
      description: "可信企业官网",
      organizationType: "Organization",
    },
    ...overrides,
  };
}

describe("trusted SiteOps component projection", () => {
  it("materializes distinct allowlisted layouts without accepting model code", () => {
    const asymmetric = siteDesignMaterializationProjection(design());
    const editorial = siteDesignMaterializationProjection(
      design({
        layoutArchetype: "editorial",
        heroVariant: "editorial_lede",
        surfaceStyle: "flat",
        typeScale: "editorial",
      }),
    );

    expect(asymmetric.bodyClass).toContain("layout--asymmetric");
    expect(asymmetric.heroClass).toBe("hero hero--split_media");
    expect(asymmetric.componentManifest.routes[0]?.slots[0]).toEqual({
      slotId: "proof",
      variant: "proof",
    });
    expect(editorial.bodyClass).toContain("layout--editorial");
    expect(editorial.heroClass).toBe("hero hero--editorial_lede");
    expect(editorial.componentManifest).not.toEqual(
      asymmetric.componentManifest,
    );
    expect(() =>
      siteDesignMaterializationProjection({
        ...design(),
        source: "<script>fetch('/secret')</script>",
      }),
    ).toThrow();
  });
});
