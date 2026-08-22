import { createHash } from "node:crypto";
import { z } from "zod";
import type { BuildContractV1, SiteBrief } from "./siteops";
import { buildContractV1Schema } from "./siteops";

export const SITEOPS_VISUAL_FUNNEL_TARGETS = {
  search: 18,
  retrieve: 12,
  present: 9,
} as const;

export type TwentyFirstQueryRole = "foundation" | "section" | "motion";

export type TwentyFirstQuery = {
  role: TwentyFirstQueryRole;
  query: string;
};

export type TwentyFirstSearchEnvelope = {
  role: TwentyFirstQueryRole;
  payload: unknown;
};

export const visualSearchOperationInputV1Schema = z
  .object({
    knowledgeSnapshotId: z.string().uuid(),
    credentialId: z.string().uuid(),
    credentialVersion: z.number().int().positive(),
    workflowVersion: z.string().trim().min(1).max(32),
  })
  .strict();

export type VisualSearchOperationInputV1 = z.infer<
  typeof visualSearchOperationInputV1Schema
>;

export type TwentyFirstProviderItemId = string | number;

export function providerItemKey(value: TwentyFirstProviderItemId) {
  return typeof value === "number" ? `n:${value}` : `s:${value}`;
}

export type NormalizedTwentyFirstSearchItem = {
  candidateId: string;
  providerItemId: TwentyFirstProviderItemId;
  providerItemKey: string;
  queryRole: TwentyFirstQueryRole;
  searchRank: number;
  title: string;
  description: string | null;
  author: string | null;
  sourceUrl: string | null;
  previewUrl: string | null;
  metadataSha256: string;
};

export type TwentyFirstDetailEnvelope = {
  operation: "get_component";
  requestedProviderItemId: TwentyFirstProviderItemId;
  payload: unknown;
};

export const VISUAL_EVIDENCE_KIND = "catalog_metadata_preview_v1" as const;
export const VISUAL_TAXONOMY_DERIVATION_VERSION =
  "catalog-metadata-preview-v1" as const;

export type VisualEvidenceV1 = {
  evidenceKind: typeof VISUAL_EVIDENCE_KIND;
  providerItemKey: string;
  metadataSha256: string;
  providerResponseSha256: string;
  previewSha256: string;
  taxonomyDerivationVersion: typeof VISUAL_TAXONOMY_DERIVATION_VERSION;
  evidenceSha256: string;
};

export type SafeVisualDirective =
  | "structure:asymmetric-grid"
  | "structure:modular-grid"
  | "structure:hero-led-hierarchy"
  | "structure:split-layout"
  | "structure:editorial-rhythm"
  | "structure:preview-led-original-translation"
  | "typography:display-led-hierarchy"
  | "typography:condensed-technical"
  | "typography:serif-editorial"
  | "typography:neutral-sans"
  | "surface:border-defined"
  | "surface:soft-shadow-depth"
  | "surface:glass-like-layering"
  | "surface:rounded-containers"
  | "color:dark-canvas"
  | "color:light-canvas"
  | "color:muted-palette"
  | "color:high-contrast"
  | "color:single-accent"
  | "imagery:photography-led"
  | "imagery:product-ui-led"
  | "imagery:illustration-led"
  | "imagery:wide-crop"
  | "imagery:masked-media"
  | "motion:controlled-reveal"
  | "motion:short-transition"
  | "motion:scroll-triggered"
  | "motion:hover-depth"
  | "motion:reduced-motion-required"
  | "tone:technical-precise"
  | "tone:warm-human"
  | "tone:premium-restrained"
  | "tone:bold-graphic"
  | "responsive:mobile-reflow";

export type TwentyFirstVisualScore = {
  brandFit: number;
  industryFit: number;
  informationDensity: number;
  composition: number;
  color: number;
  motion: number;
  accessibility: number;
};

export type NormalizedTwentyFirstCandidate =
  NormalizedTwentyFirstSearchItem & {
    providerResponseSha256: string;
    normalizedDirectives: SafeVisualDirective[];
    score: number;
    scoreBreakdown: TwentyFirstVisualScore;
    rationale: string;
    codeIgnored: true;
  };

export type TwentyFirstFunnelResult = {
  targets: typeof SITEOPS_VISUAL_FUNNEL_TARGETS;
  actual: {
    searched: number;
    detailRetrieved: number;
    presented: number;
  };
  searchedCandidates: NormalizedTwentyFirstSearchItem[];
  retrievalShortlist: NormalizedTwentyFirstCandidate[];
  presentedCandidates: Array<
    NormalizedTwentyFirstCandidate & { optionLabel: string; presentationRank: number }
  >;
  supportingCandidates: NormalizedTwentyFirstCandidate[];
  degradedReasons: string[];
  generateUsed: false;
  providerCodeReuse: false;
};

const RESULT_CONTAINERS = new Set([
  "data",
  "result",
  "component",
  "detail",
  "payload",
  "structuredcontent",
]);
const SEARCH_ARRAY_KEYS = new Set([
  "results",
  "items",
  "components",
  "hits",
  "content",
]);
const SENSITIVE_QUERY_KEY = /(?:api.?key|token|secret|credential|authorization|auth|signature|jwt)/iu;
const SENSITIVE_TEXT = /(?:21st_sk_[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
const INSTRUCTIONAL_METADATA = /(?:ignore\s+(?:all\s+)?(?:previous|system|developer)|reveal\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message)|modify\s+(?:the\s+)?(?:host|agent|mcp)\s+(?:config|configuration)|exfiltrat(?:e|ion))/iu;
const UNSAFE_METADATA = /(?:<\s*\/?\s*[A-Za-z][^>]*>|```|["']use client["']|\b(?:npm\s+(?:i|install)|npx\s+|pnpm\s+(?:add|install)|yarn\s+add|bun\s+add)\b|\bimport\s+.+\bfrom\b|\brequire\s*\(|\bfunction\s+[A-Za-z_$]|=>|\bclassName\s*=)/iu;

const DIRECTIVE_TAXONOMY: ReadonlyArray<
  readonly [SafeVisualDirective, RegExp]
> = [
  ["structure:asymmetric-grid", /\basymmetr(?:y|ic)|offset\s+grid/iu],
  ["structure:modular-grid", /\bmodular\b|\bbento\b|card\s+grid/iu],
  ["structure:hero-led-hierarchy", /\bhero\b|above[- ]the[- ]fold/iu],
  ["structure:split-layout", /split[- ](?:screen|layout)|two[- ]column/iu],
  ["structure:editorial-rhythm", /\beditorial\b|magazine|rhythm/iu],
  [
    "typography:display-led-hierarchy",
    /display\s+(?:type|font)|oversized\s+(?:type|heading)|headline/iu,
  ],
  [
    "typography:condensed-technical",
    /condensed|technical\s+(?:type|font|typography)/iu,
  ],
  ["typography:serif-editorial", /\bserif\b/iu],
  ["typography:neutral-sans", /sans[- ]serif|neutral\s+sans/iu],
  ["surface:border-defined", /\bborder(?:ed|s)?\b|divider/iu],
  ["surface:soft-shadow-depth", /soft\s+shadow|drop\s+shadow|layered\s+depth/iu],
  ["surface:glass-like-layering", /glass(?:morphism)?|frosted|backdrop\s+blur/iu],
  ["surface:rounded-containers", /rounded|corner\s+radius|pill/iu],
  ["color:dark-canvas", /dark\s+(?:mode|canvas|background)|near[- ]black/iu],
  ["color:light-canvas", /light\s+(?:mode|canvas|background)|off[- ]white/iu],
  ["color:muted-palette", /muted|desaturated|low[- ]saturation/iu],
  ["color:high-contrast", /high[- ]contrast|strong\s+contrast/iu],
  ["color:single-accent", /single\s+accent|one\s+accent|accent\s+color/iu],
  ["imagery:photography-led", /photograph|photo[- ]led|camera/iu],
  [
    "imagery:product-ui-led",
    /product\s+(?:ui|screen)|interface\s+(?:image|preview)|dashboard/iu,
  ],
  ["imagery:illustration-led", /illustration|illustrative/iu],
  ["imagery:wide-crop", /wide\s+crop|cinematic\s+crop|panoramic/iu],
  ["imagery:masked-media", /image\s+mask|masked\s+(?:image|media)|clip[- ]path/iu],
  ["motion:controlled-reveal", /masked?\s+reveal|controlled\s+reveal|fade[- ]?in|reveal/iu],
  ["motion:short-transition", /short\s+transition|micro[- ]?interaction|transition/iu],
  ["motion:scroll-triggered", /scroll[- ]trigger|on\s+scroll|parallax/iu],
  ["motion:hover-depth", /hover\s+(?:depth|lift|state)|on\s+hover/iu],
  ["tone:technical-precise", /technical|precise|engineering|industrial/iu],
  ["tone:warm-human", /warm|human|approachable|friendly/iu],
  ["tone:premium-restrained", /premium|luxury|restrained|refined/iu],
  ["tone:bold-graphic", /bold|graphic|brutalist/iu],
  ["responsive:mobile-reflow", /responsive|mobile|small[- ]screen|stack/iu],
];

function canonicalKey(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compact(value: unknown, maxLength = 2_000) {
  return typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength)
    : "";
}

function safeMetadata(value: string | null, fallback: string | null = null) {
  if (
    !value ||
    SENSITIVE_TEXT.test(value) ||
    INSTRUCTIONAL_METADATA.test(value) ||
    UNSAFE_METADATA.test(value)
  ) {
    return fallback;
  }
  return value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 300) || fallback;
}

function firstString(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const wanted = new Set(keys.map(canonicalKey));
  for (const [key, child] of Object.entries(value)) {
    if (wanted.has(canonicalKey(key))) {
      const found = compact(child);
      if (found) return found;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      RESULT_CONTAINERS.has(canonicalKey(key)) ||
      canonicalKey(key) === "metadata"
    ) {
      const found = firstString(child, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalizeProviderItemIdValue(
  value: unknown,
): TwentyFirstProviderItemId | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    /^21st_sk_/iu.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function firstProviderItemId(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): TwentyFirstProviderItemId | null {
  if (depth > 5 || !isRecord(value)) return null;
  const wanted = new Set(keys.map(canonicalKey));
  for (const [key, child] of Object.entries(value)) {
    if (!wanted.has(canonicalKey(key))) continue;
    const found = normalizeProviderItemIdValue(child);
    if (found !== null) return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      RESULT_CONTAINERS.has(canonicalKey(key)) ||
      canonicalKey(key) === "metadata"
    ) {
      const found = firstProviderItemId(child, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function collectSearchRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    if (value.every(isRecord)) return value;
    return value.flatMap((item) => collectSearchRecords(item, depth + 1));
  }
  if (!isRecord(value)) return [];
  for (const [key, child] of Object.entries(value)) {
    if (SEARCH_ARRAY_KEYS.has(canonicalKey(key)) && Array.isArray(child)) {
      const records = collectSearchRecords(child, depth + 1);
      if (records.length > 0) return records;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (RESULT_CONTAINERS.has(canonicalKey(key))) {
      const records = collectSearchRecords(child, depth + 1);
      if (records.length > 0) return records;
    }
  }
  return [];
}

function sanitizeHttpsUrl(
  value: string | null,
  options: { providerSource?: boolean } = {},
) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (
      options.providerSource &&
      url.hostname !== "21st.dev" &&
      !url.hostname.endsWith(".21st.dev")
    ) {
      return null;
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function candidateIdForProviderItem(value: TwentyFirstProviderItemId) {
  const key = providerItemKey(value);
  const label = key.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 150);
  return `21st-${label}-${sha256(key).slice(0, 12)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  const visit = (candidate: unknown, location: string): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError(`Non-finite number at ${location}`);
      }
      return JSON.stringify(Object.is(candidate, -0) ? 0 : candidate);
    }
    if (Array.isArray(candidate)) {
      return `[${candidate
        .map((item, index) => visit(item, `${location}[${index}]`))
        .join(",")}]`;
    }
    if (!isRecord(candidate)) {
      throw new TypeError(`Unsupported canonical JSON value at ${location}`);
    }
    const entries = Object.entries(candidate).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${visit(child, `${location}.${key}`)}`,
      )
      .join(",")}}`;
  };
  return visit(value, "$");
}

export function canonicalSha256(value: unknown) {
  return sha256(canonicalJson(value));
}

export function createVisualEvidenceV1(input: Omit<VisualEvidenceV1, "evidenceSha256">) {
  const evidenceSha256 = canonicalSha256(input);
  return { ...input, evidenceSha256 } satisfies VisualEvidenceV1;
}

export function composeTwentyFirstQueries(brief: SiteBrief): TwentyFirstQuery[] {
  const safeWords = [
    brief.companyName,
    brief.conversionGoal,
    ...brief.offerings,
    ...brief.audience,
    ...brief.routes.map((route) => route.title),
  ]
    .flatMap((value) => value.match(/[A-Za-z][A-Za-z0-9+&._/-]{1,39}/gu) ?? [])
    .map((value) => value.toLocaleLowerCase("en-US"))
    .filter((value) => !SENSITIVE_TEXT.test(value));
  const context = Array.from(new Set(safeWords)).slice(0, 8).join(" ");
  return [
    {
      role: "foundation",
      query: `${context} responsive company website original brand system`.trim(),
    },
    {
      role: "section",
      query: `${context} hero features proof contact website sections`.trim(),
    },
    {
      role: "motion",
      query: `${context} accessible micro interaction reduced motion landing page`.trim(),
    },
  ];
}

export function normalizeTwentyFirstSearchResults(
  envelopes: readonly TwentyFirstSearchEnvelope[],
): NormalizedTwentyFirstSearchItem[] {
  const seen = new Set<string>();
  const output: NormalizedTwentyFirstSearchItem[] = [];
  for (const envelope of envelopes) {
    for (const record of collectSearchRecords(envelope.payload)) {
      if (output.length >= SITEOPS_VISUAL_FUNNEL_TARGETS.search) return output;
      const providerItemId = firstProviderItemId(record, [
        "provider_item_id",
        "component_id",
        "item_id",
        "id",
        "slug",
      ]);
      const sourceUrl = sanitizeHttpsUrl(
        firstString(record, ["source_url", "sourceUrl", "url", "web_url"]),
        { providerSource: true },
      );
      if (providerItemId === null) continue;
      const duplicateKey = providerItemKey(providerItemId);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const title = safeMetadata(
        firstString(record, ["title", "name", "component_name", "demo_name"]),
        `21st catalog item ${output.length + 1}`,
      )!;
      const description = safeMetadata(
        firstString(record, ["description", "summary", "caption"]),
      );
      const author = safeMetadata(
        firstString(record, ["author", "creator", "owner"]),
      );
      const previewUrl = sanitizeHttpsUrl(
        firstString(record, [
          "preview_url",
          "previewUrl",
          "preview",
          "image_url",
          "imageUrl",
          "thumbnail_url",
          "thumbnailUrl",
        ]),
      );
      const metadataSha256 = canonicalSha256({
        providerItemKey: duplicateKey,
        title,
        description,
        author,
        sourceUrl,
        previewUrl,
      });
      output.push({
        candidateId: candidateIdForProviderItem(providerItemId),
        providerItemId,
        providerItemKey: duplicateKey,
        queryRole: envelope.role,
        searchRank: output.length + 1,
        title,
        description,
        author,
        sourceUrl,
        previewUrl,
        metadataSha256,
      });
    }
  }
  return output;
}

export function extractSafeVisualDirectives(
  safeMetadataText: string,
): SafeVisualDirective[] {
  if (
    SENSITIVE_TEXT.test(safeMetadataText) ||
    INSTRUCTIONAL_METADATA.test(safeMetadataText) ||
    UNSAFE_METADATA.test(safeMetadataText)
  ) {
    throw new Error("UNSAFE_PROVIDER_METADATA");
  }
  const directives = DIRECTIVE_TAXONOMY.filter(([, pattern]) =>
    pattern.test(safeMetadataText),
  ).map(([directive]) => directive);
  if (directives.length === 0) {
    directives.push("structure:preview-led-original-translation");
  }
  const bounded: SafeVisualDirective[] = directives
    .filter((directive) => directive !== "motion:reduced-motion-required")
    .slice(0, 11);
  return [...bounded, "motion:reduced-motion-required"];
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function defaultScore(
  item: NormalizedTwentyFirstSearchItem,
  directives: readonly SafeVisualDirective[],
): TwentyFirstVisualScore {
  const rankSignal = Math.max(4, 15 - (item.searchRank - 1) * 0.45);
  const hasResponsive = directives.includes("responsive:mobile-reflow");
  const hasReducedMotion = directives.includes("motion:reduced-motion-required");
  return {
    brandFit: clampScore(rankSignal),
    industryFit: clampScore(rankSignal - 1),
    informationDensity: directives.some((item) => item.includes("modular"))
      ? 14
      : 11,
    composition: directives.some((item) => item.startsWith("structure:"))
      ? 14
      : 9,
    color: directives.some((item) => item.startsWith("color:")) ? 12 : 8,
    motion: hasReducedMotion ? 10 : 7,
    accessibility: hasResponsive ? 15 : 10,
  };
}

function scoreTotal(score: TwentyFirstVisualScore) {
  return clampScore(
    score.brandFit +
      score.industryFit +
      score.informationDensity +
      score.composition +
      score.color +
      score.motion +
      score.accessibility,
  );
}

export function normalizeTwentyFirstDetail(input: {
  searchItem: NormalizedTwentyFirstSearchItem;
  detail: TwentyFirstDetailEnvelope;
  score?: TwentyFirstVisualScore;
}): NormalizedTwentyFirstCandidate | null {
  if (input.detail.operation !== "get_component") return null;
  if (
    providerItemKey(input.detail.requestedProviderItemId) !==
    input.searchItem.providerItemKey
  ) {
    return null;
  }
  const responseItemId = firstProviderItemId(input.detail.payload, [
    "provider_item_id",
    "component_id",
    "item_id",
    "id",
    "slug",
  ]);
  if (
    responseItemId !== null &&
    providerItemKey(responseItemId) !== input.searchItem.providerItemKey
  ) {
    return null;
  }
  const title =
    safeMetadata(
      firstString(input.detail.payload, [
        "title",
        "name",
        "component_name",
        "demo_name",
      ]),
    ) ?? input.searchItem.title;
  const description =
    safeMetadata(
      firstString(input.detail.payload, ["description", "summary", "caption"]),
    ) ?? input.searchItem.description;
  const author =
    safeMetadata(
      firstString(input.detail.payload, ["author", "creator", "owner"]),
    ) ?? input.searchItem.author;
  const sourceUrl =
    sanitizeHttpsUrl(
      firstString(input.detail.payload, [
        "source_url",
        "sourceUrl",
        "url",
        "web_url",
      ]),
      { providerSource: true },
    ) ?? input.searchItem.sourceUrl;
  const previewUrl =
    sanitizeHttpsUrl(
      firstString(input.detail.payload, [
        "preview_url",
        "previewUrl",
        "preview",
        "image_url",
        "imageUrl",
        "thumbnail_url",
        "thumbnailUrl",
      ]),
    ) ?? input.searchItem.previewUrl;
  const metadataProjection = {
    providerItemKey: input.searchItem.providerItemKey,
    title,
    description,
    author,
    sourceUrl,
    previewUrl,
  };
  const normalizedDirectives = extractSafeVisualDirectives(
    [title, description, author].filter(Boolean).join(" "),
  );
  const normalizedItem: NormalizedTwentyFirstSearchItem = {
    ...input.searchItem,
    title,
    description,
    author,
    sourceUrl,
    previewUrl,
    metadataSha256: canonicalSha256(metadataProjection),
  };
  const scoreBreakdown =
    input.score ?? defaultScore(normalizedItem, normalizedDirectives);
  return {
    ...normalizedItem,
    providerResponseSha256: canonicalSha256(input.detail.payload),
    normalizedDirectives,
    scoreBreakdown,
    score: scoreTotal(scoreBreakdown),
    rationale: `${input.searchItem.queryRole} 参考；按真实目录排名和安全视觉特征评估。`,
    codeIgnored: true,
  };
}

export function buildTwentyFirstVisualFunnel(input: {
  searchEnvelopes: readonly TwentyFirstSearchEnvelope[];
  details: readonly TwentyFirstDetailEnvelope[];
  scores?: Readonly<Record<string, TwentyFirstVisualScore>>;
}): TwentyFirstFunnelResult {
  const searchedCandidates = normalizeTwentyFirstSearchResults(
    input.searchEnvelopes,
  );
  const detailsById = new Map(
    input.details.map((detail) => [
      providerItemKey(detail.requestedProviderItemId),
      detail,
    ]),
  );
  const retrievalShortlist: NormalizedTwentyFirstCandidate[] = [];
  for (const searchItem of searchedCandidates) {
    if (retrievalShortlist.length >= SITEOPS_VISUAL_FUNNEL_TARGETS.retrieve) {
      break;
    }
    const detail = detailsById.get(searchItem.providerItemKey);
    if (!detail) continue;
    const normalized = normalizeTwentyFirstDetail({
      searchItem,
      detail,
      score: input.scores?.[searchItem.providerItemKey],
    });
    if (normalized) retrievalShortlist.push(normalized);
  }
  const presentedCandidates = retrievalShortlist
    .filter(
      (candidate) =>
        candidate.queryRole === "foundation" && Boolean(candidate.previewUrl),
    )
    .sort((left, right) => right.score - left.score || left.searchRank - right.searchRank)
    .slice(0, SITEOPS_VISUAL_FUNNEL_TARGETS.present)
    .map((candidate, index) => ({
      ...candidate,
      optionLabel: String.fromCharCode(65 + index),
      presentationRank: index + 1,
    }));
  const supportingCandidates = retrievalShortlist
    .filter((candidate) => candidate.queryRole !== "foundation")
    .sort((left, right) => right.score - left.score || left.searchRank - right.searchRank)
    .slice(0, 2);
  const degradedReasons: string[] = [];
  if (searchedCandidates.length < SITEOPS_VISUAL_FUNNEL_TARGETS.search) {
    degradedReasons.push(
      `SEARCH_RESULTS_INSUFFICIENT:${searchedCandidates.length}/${SITEOPS_VISUAL_FUNNEL_TARGETS.search}`,
    );
  }
  if (retrievalShortlist.length < SITEOPS_VISUAL_FUNNEL_TARGETS.retrieve) {
    degradedReasons.push(
      `RETRIEVAL_RESULTS_INSUFFICIENT:${retrievalShortlist.length}/${SITEOPS_VISUAL_FUNNEL_TARGETS.retrieve}`,
    );
  }
  if (presentedCandidates.length < SITEOPS_VISUAL_FUNNEL_TARGETS.present) {
    degradedReasons.push(
      `PRESENTATION_RESULTS_INSUFFICIENT:${presentedCandidates.length}/${SITEOPS_VISUAL_FUNNEL_TARGETS.present}`,
    );
  }
  return {
    targets: SITEOPS_VISUAL_FUNNEL_TARGETS,
    actual: {
      searched: searchedCandidates.length,
      detailRetrieved: retrievalShortlist.length,
      presented: presentedCandidates.length,
    },
    searchedCandidates,
    retrievalShortlist,
    presentedCandidates,
    supportingCandidates,
    degradedReasons,
    generateUsed: false,
    providerCodeReuse: false,
  };
}

export function composeBuildContractV1(
  input: Omit<BuildContractV1, "specHash">,
): BuildContractV1 {
  const specHash = canonicalSha256(input);
  return buildContractV1Schema.parse({ ...input, specHash });
}
