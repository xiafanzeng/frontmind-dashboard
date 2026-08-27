import {
  siteContentPatchV1Schema,
  type SiteContentPatchV1,
} from "../../shared/siteops-content-patch";
import {
  canonicalPreviewModelV1Schema,
  type CanonicalPreviewModelV1,
} from "./site-content-draft";

export type SiteContentPatchWarning = {
  code:
    | "unknown_route"
    | "unknown_slot"
    | "source_binding_invalid"
    | "asset_binding_invalid"
    | "target_route_invalid"
    | "slot_kind_not_materialized";
  routeId: string;
  slotId?: string;
};

function normalizedPatchText(value: string, maxLength: number) {
  return Array.from(
    value
      .normalize("NFKC")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
      .replace(/<[^>]{1,256}>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, maxLength)
    .join("");
}

function exactCoordinate(actual: string, expected: string, code: string) {
  if (actual.length !== expected.length || actual !== expected) {
    throw new Error(code);
  }
}

/**
 * Apply a provider patch only to route/slot coordinates already owned by the
 * host baseline. Invalid children are ignored individually and leave the
 * trusted baseline value in place; task/hash mismatches reject the whole
 * patch because they cross an immutable build boundary.
 */
export function applySiteContentPatchV1(input: {
  patch: SiteContentPatchV1 | unknown;
  expectedOperationToken: string;
  expectedBaseSourceSha256: string;
  baseline: CanonicalPreviewModelV1;
  allowedSourceIdsByRoute: Readonly<Record<string, readonly string[]>>;
  allowedAssetIds?: readonly string[];
}) {
  const patch = siteContentPatchV1Schema.parse(input.patch);
  exactCoordinate(
    patch.operationToken,
    input.expectedOperationToken,
    "SITE_CONTENT_PATCH_TOKEN_MISMATCH",
  );
  exactCoordinate(
    patch.baseSourceSha256,
    input.expectedBaseSourceSha256,
    "SITE_CONTENT_PATCH_BASE_HASH_MISMATCH",
  );
  const baseline = canonicalPreviewModelV1Schema.parse(input.baseline);
  const routes = baseline.routes.map((route) => ({
    ...route,
    sections: route.sections.map((section) => ({ ...section })),
  }));
  const routeById = new Map(routes.map((route) => [route.routeId, route]));
  const knownRouteIds = new Set(routeById.keys());
  const allowedAssets = new Set(input.allowedAssetIds ?? []);
  const warnings: SiteContentPatchWarning[] = [];

  for (const page of patch.pages) {
    const route = routeById.get(page.routeId);
    if (!route) {
      warnings.push({ code: "unknown_route", routeId: page.routeId });
      continue;
    }
    const slotById = new Map(
      route.sections.map((section) => [section.slotId, section]),
    );
    const allowedSources = new Set(
      input.allowedSourceIdsByRoute[page.routeId] ?? [],
    );
    for (const slotPatch of page.slots) {
      const slot = slotById.get(slotPatch.slotId);
      if (!slot) {
        warnings.push({
          code: "unknown_slot",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      if (
        slotPatch.sourceIds.length < 1 ||
        slotPatch.sourceIds.some((sourceId) => !allowedSources.has(sourceId))
      ) {
        warnings.push({
          code: "source_binding_invalid",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      if (slotPatch.kind === "text" || slotPatch.kind === "richText") {
        const value = normalizedPatchText(slotPatch.value, 2_000);
        if (!value) {
          warnings.push({
            code: "source_binding_invalid",
            routeId: page.routeId,
            slotId: slotPatch.slotId,
          });
          continue;
        }
        slot.paragraphs = [value];
        slot.items = [];
        slot.blockType = "prose";
        slot.sourceDocumentIds = [...new Set(slotPatch.sourceIds)];
        delete slot.grounding;
        continue;
      }
      if (slotPatch.kind === "list") {
        const items = slotPatch.value
          .map((value) => normalizedPatchText(value, 500))
          .filter(Boolean)
          .slice(0, 24);
        if (items.length < 1) continue;
        slot.paragraphs = [];
        slot.items = items;
        slot.blockType = "feature_list";
        slot.sourceDocumentIds = [...new Set(slotPatch.sourceIds)];
        delete slot.grounding;
        continue;
      }
      if (slotPatch.kind === "image") {
        warnings.push({
          code: allowedAssets.has(slotPatch.value.assetId)
            ? "slot_kind_not_materialized"
            : "asset_binding_invalid",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
        continue;
      }
      if (slotPatch.kind === "link") {
        warnings.push({
          code: knownRouteIds.has(slotPatch.value.targetRouteId)
            ? "slot_kind_not_materialized"
            : "target_route_invalid",
          routeId: page.routeId,
          slotId: slotPatch.slotId,
        });
      }
    }
  }

  return {
    canonical: canonicalPreviewModelV1Schema.parse({ ...baseline, routes }),
    warnings,
  };
}
