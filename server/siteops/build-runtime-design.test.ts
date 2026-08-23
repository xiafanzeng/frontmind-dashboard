import { describe, expect, it, vi } from "vitest";

vi.mock("@axe-core/playwright", () => ({ default: class MockAxeBuilder {} }));
vi.mock("chrome-launcher", () => ({ launch: vi.fn() }));
vi.mock("lighthouse", () => ({ default: vi.fn() }));
vi.mock("playwright", () => ({ chromium: {} }));

import { referenceBlueprintForVisualCandidate } from "../../shared/siteops-design";
import { siteDesignMaterializationProjection } from "./build-runtime";

function design(overrides: Record<string, unknown> = {}) {
  const referenceBlueprint = referenceBlueprintForVisualCandidate({
    candidateId: "candidate-F",
    providerItemKey: "n:8435",
    previewSha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Floating orbit",
  });
  return {
    schemaVersion: 2,
    referenceBlueprint,
    layoutArchetype: "asymmetric",
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
        surfaceStyle: "flat",
        typeScale: "editorial",
      }),
    );

    expect(asymmetric.bodyClass).toContain("layout--asymmetric");
    expect(asymmetric.heroClass).toBe("hero hero--floating_orbit");
    expect(asymmetric.heroFamily).toBe("floating_orbit");
    expect(asymmetric.bodyClass).toContain("decoration--orbital");
    expect(asymmetric.bodyClass).toContain("container--contained");
    expect(asymmetric.bodyClass).toContain(
      "media-strategy--procedural_brand_svg",
    );
    expect(asymmetric.componentManifest.routes[0]?.slots[0]).toEqual({
      slotId: "proof",
      variant: "proof",
    });
    expect(editorial.bodyClass).toContain("layout--editorial");
    expect(editorial.heroClass).toBe("hero hero--floating_orbit");
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
