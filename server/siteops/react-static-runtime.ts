import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import type { SiteBrief } from "../../shared/siteops";
import type {
  ReferenceBlueprintV3,
  TrustedVisualPreviewBlueprintV3,
} from "../../shared/siteops-design";

export const REACT_STATIC_RENDERER = "react_static_v1" as const;
export const REACT_STATIC_COMPONENT_LIBRARY_VERSION = "2.1.0" as const;
export const REACT_STATIC_MATERIALIZER_VERSION = "2.1.0" as const;
export const REACT_STATIC_REACT_VERSION = "19.2.1" as const;
const VISUAL_PREVIEW_RENDER_BUDGET_MS = 75_000;
const VISUAL_PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS = 20_000;

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject<T>(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export const REACT_STATIC_HERO_FAMILIES = [
  "floating_orbit",
  "split_media",
  "editorial",
  "bento",
  "feature_grid",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "full_bleed_statement",
] as const satisfies readonly ReferenceBlueprintV3["heroFamily"][];

/**
 * This is the complete, host-owned component library placed in every trusted
 * source bundle. Customer/provider values are loaded only from JSON files and
 * are never interpolated into this module.
 */
export const TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE = String.raw`import React from "react";

const h = React.createElement;

export const HERO_FAMILIES = Object.freeze([
  "floating_orbit",
  "feature_grid",
  "bento",
  "split_media",
  "editorial",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "proof_grid",
  "full_bleed_statement"
]);

const LEGACY_HERO_FAMILIES = Object.freeze({
  centered_statement: "centered_dual_cta",
  editorial_lede: "editorial",
  proof_grid: "proof_grid",
  split_media: "split_media"
});

function safeHeroFamily(value) {
  const mapped = LEGACY_HERO_FAMILIES[value] || value;
  return HERO_FAMILIES.includes(mapped) ? mapped : "split_media";
}

function Eyebrow(props) {
  return h("p", { className: "eyebrow" }, props.children);
}

function HeroCopy({ page }) {
  return h(
    "div",
    { className: "hero-copy" },
    h(Eyebrow, null, page.hero.eyebrow),
    h("h1", null, page.hero.heading),
    h("p", { className: "lede" }, page.hero.summary)
  );
}

function OrbitMotif({ kind, label }) {
  const art = {
    dna: [
      h("path", { key: "a", d: "M52 28 C148 57 92 178 190 210" }),
      h("path", { key: "b", d: "M91 20 C16 86 204 145 150 220" }),
      h("path", { key: "c", d: "M62 54 L103 38 M55 91 L127 71 M77 128 L151 106 M108 163 L177 143 M139 197 L181 184" }),
      h("circle", { key: "d", cx: "52", cy: "28", r: "8" }),
      h("circle", { key: "e", cx: "150", cy: "220", r: "8" })
    ],
    molecule: [
      h("path", { key: "a", d: "M38 118 L87 58 L154 78 L197 140 L141 194 L70 176 Z" }),
      ...[[38,118,13],[87,58,11],[154,78,16],[197,140,12],[141,194,15],[70,176,10]].map((point, index) => h("circle", { key: "m" + index, cx: point[0], cy: point[1], r: point[2] }))
    ],
    cell: [
      h("path", { key: "a", d: "M54 44 C111 3 196 41 211 108 C228 181 157 230 91 210 C22 189 11 96 54 44 Z" }),
      h("circle", { key: "b", cx: "128", cy: "120", r: "39" }),
      h("path", { key: "c", d: "M62 139 C91 165 126 179 167 169 M93 55 C126 39 168 50 187 78" }),
      h("circle", { key: "d", cx: "180", cy: "151", r: "9" }),
      h("circle", { key: "e", cx: "69", cy: "91", r: "7" })
    ],
    timeline: [
      h("path", { key: "a", d: "M20 171 C66 210 116 196 144 151 C168 112 175 69 221 35" }),
      ...[[20,171],[72,195],[121,177],[154,132],[177,78],[221,35]].map((point, index) => h("circle", { key: "t" + index, cx: point[0], cy: point[1], r: "8" }))
    ]
  };
  return h(
    "div",
    { className: "orbit-motif orbit-motif--" + kind, "data-motif": kind },
    h("svg", { viewBox: "0 0 240 240", role: "img", "aria-label": label + " · " + kind }, h("circle", { className: "orbit-motif__halo", cx: "120", cy: "120", r: "112" }), h("g", { className: "orbit-motif__drawing" }, ...art[kind]))
  );
}

function FloatingOrbitHero({ page }) {
  return h(
    "section",
    { className: "hero hero--floating_orbit", "data-hero-family": "floating_orbit" },
    h(
      "div",
      { className: "shell hero-orbit-stage" },
      h("div", { className: "hero-orbit__copy" }, h(HeroCopy, { page }), h("div", { className: "hero-actions" }, h("a", { className: "button button--primary", href: "#content" }, "探索能力"), h("a", { className: "button button--secondary", href: "#contact" }, "联系我们"))),
      h(OrbitMotif, { kind: "dna", label: page.hero.heading }),
      h(OrbitMotif, { kind: "molecule", label: page.hero.heading }),
      h(OrbitMotif, { kind: "cell", label: page.hero.heading }),
      h(OrbitMotif, { kind: "timeline", label: page.hero.heading })
    )
  );
}

function FeatureGridHero({ page }) {
  const items = page.sections.slice(0, 3);
  return h(
    "section",
    { className: "hero hero--feature_grid", "data-hero-family": "feature_grid" },
    h(
      "div",
      { className: "shell" },
      h(HeroCopy, { page }),
      h(
        "ul",
        { className: "hero-feature-grid", "aria-label": "重点能力" },
        ...items.map((item, index) =>
          h("li", { key: item.slotId }, h("span", null, String(index + 1).padStart(2, "0")), h("strong", null, item.heading))
        )
      )
    )
  );
}

function BentoHero({ page }) {
  return h(
    "section",
    { className: "hero hero--bento", "data-hero-family": "bento" },
    h(
      "div",
      { className: "shell hero-bento" },
      h("div", { className: "hero-bento__copy" }, h(HeroCopy, { page })),
      h("aside", { className: "hero-bento__signal", "aria-label": "品牌信号" }, h("span", null, "01"), h("strong", null, page.sections[0]?.heading || page.hero.eyebrow)),
      h("aside", { className: "hero-bento__summary" }, page.hero.summary),
      h("div", { className: "hero-bento__mark", "aria-hidden": "true" }, "✦")
    )
  );
}

function SplitMediaHero({ page }) {
  return h(
    "section",
    { className: "hero hero--split_media", "data-hero-family": "split_media" },
    h(
      "div",
      { className: "shell hero-split" },
      h(HeroCopy, { page }),
      h(
        "div",
        { className: "hero-split__media", role: "img", "aria-label": "品牌能力抽象图" },
        h("span", { className: "hero-split__disc hero-split__disc--one" }),
        h("span", { className: "hero-split__disc hero-split__disc--two" }),
        h("strong", null, page.sections[0]?.heading || page.hero.eyebrow)
      )
    )
  );
}

function EditorialHero({ page }) {
  return h(
    "section",
    { className: "hero hero--editorial", "data-hero-family": "editorial" },
    h(
      "div",
      { className: "shell hero-editorial" },
      h("div", { className: "hero-editorial__folio", "aria-hidden": "true" }, "VOL. 01"),
      h(HeroCopy, { page }),
      h("p", { className: "hero-editorial__note" }, page.sections[0]?.heading || page.hero.eyebrow)
    )
  );
}

function CenteredDualCtaHero({ page }) {
  return h(
    "section",
    { className: "hero hero--centered_dual_cta", "data-hero-family": "centered_dual_cta" },
    h(
      "div",
      { className: "shell hero-centered" },
      h(HeroCopy, { page }),
      h(
        "div",
        { className: "hero-actions" },
        h("a", { className: "button button--primary", href: "#content" }, "了解更多"),
        h("a", { className: "button button--secondary", href: "#contact" }, "联系我们")
      )
    )
  );
}

function ImmersiveVisualHero({ page }) {
  return h(
    "section",
    { className: "hero hero--immersive_visual", "data-hero-family": "immersive_visual" },
    h("div", { className: "hero-immersive__field", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
    h("div", { className: "shell hero-immersive__copy" }, h(HeroCopy, { page }))
  );
}

function ProductStageHero({ page }) {
  return h(
    "section",
    { className: "hero hero--product_stage", "data-hero-family": "product_stage" },
    h(
      "div",
      { className: "shell" },
      h(HeroCopy, { page }),
      h(
        "div",
        { className: "product-stage", role: "img", "aria-label": "产品界面抽象舞台" },
        h("div", { className: "product-stage__bar" }, h("span"), h("span"), h("span")),
        h("div", { className: "product-stage__body" }, h("aside"), h("div", null, h("strong", null, page.sections[0]?.heading || page.hero.eyebrow), h("span"), h("span")))
      )
    )
  );
}

function ProofGridHero({ page }) {
  return h(
    "section",
    { className: "hero hero--proof_grid", "data-hero-family": "proof_grid" },
    h(
      "div",
      { className: "shell hero-proof" },
      h(HeroCopy, { page }),
      h(
        "dl",
        { className: "hero-proof__grid" },
        ...page.sections.slice(0, 3).flatMap((item, index) => [
          h("dt", { key: item.slotId + "-term" }, String(index + 1).padStart(2, "0")),
          h("dd", { key: item.slotId + "-description" }, item.heading)
        ])
      )
    )
  );
}

function FullBleedStatementHero({ page }) {
  return h(
    "section",
    { className: "hero hero--full_bleed_statement", "data-hero-family": "full_bleed_statement" },
    h("div", { className: "hero-statement__rail", "aria-hidden": "true" }, page.hero.eyebrow),
    h("div", { className: "shell hero-statement" }, h(Eyebrow, null, page.hero.eyebrow), h("h1", null, page.hero.heading), h("p", { className: "lede" }, page.hero.summary))
  );
}

const HERO_COMPONENTS = Object.freeze({
  floating_orbit: FloatingOrbitHero,
  feature_grid: FeatureGridHero,
  bento: BentoHero,
  split_media: SplitMediaHero,
  editorial: EditorialHero,
  centered_dual_cta: CenteredDualCtaHero,
  immersive_visual: ImmersiveVisualHero,
  product_stage: ProductStageHero,
  proof_grid: ProofGridHero,
  full_bleed_statement: FullBleedStatementHero
});

function SourceNote() { return null; }

function Paragraphs({ values, className }) {
  return h("div", { className: className || "section-prose" }, ...values.map((value, index) => h("p", { key: index }, value)));
}

function StatementSection({ section }) {
  return h("section", { className: "section section--statement", "data-slot": section.slotId }, h("span", { className: "section-index" }, "观点"), h("h2", null, section.heading), h("blockquote", null, section.paragraphs[0]), section.paragraphs.length > 1 ? h(Paragraphs, { values: section.paragraphs.slice(1) }) : null, h(SourceNote, { ids: section.sourceDocumentIds }));
}

function SplitSection({ section }) {
  return h("section", { className: "section section--split", "data-slot": section.slotId }, h("header", { className: "section-split__header" }, h("span", { className: "section-index" }, "聚焦"), h("h2", null, section.heading)), h(Paragraphs, { className: "section-split__body", values: section.paragraphs }), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function CardsSection({ section }) {
  return h("section", { className: "section section--cards", "data-slot": section.slotId }, h("header", null, h("span", { className: "section-index" }, "能力"), h("h2", null, section.heading)), h("div", { className: "mini-card-grid" }, ...section.paragraphs.map((paragraph, index) => h("article", { className: "mini-card", key: index }, h("span", null, String(index + 1).padStart(2, "0")), h("p", null, paragraph)))), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function TimelineSection({ section }) {
  return h("section", { className: "section section--timeline", "data-slot": section.slotId }, h("header", null, h("span", { className: "section-index" }, "路径"), h("h2", null, section.heading)), h("ol", { className: "timeline-list" }, ...section.paragraphs.map((paragraph, index) => h("li", { key: index }, h("span", null, String(index + 1).padStart(2, "0")), h("p", null, paragraph)))), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function FaqSection({ section }) {
  return h("section", { className: "section section--faq", "data-slot": section.slotId }, h("span", { className: "section-index" }, "问答"), h("dl", null, h("div", null, h("dt", null, h("span", { "aria-hidden": "true" }, "Q"), section.heading), h("dd", null, ...section.paragraphs.map((paragraph, index) => h("p", { key: index }, paragraph))))), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function ProofSection({ section }) {
  return h("section", { className: "section section--proof", "data-slot": section.slotId }, h("figure", null, h("figcaption", null, h("span", { className: "section-index" }, "证据"), h("h2", null, section.heading)), h("blockquote", null, section.paragraphs[0]), section.paragraphs.length > 1 ? h(Paragraphs, { values: section.paragraphs.slice(1) }) : null), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function CtaSection({ section }) {
  return h("section", { className: "section section--cta", "data-slot": section.slotId }, h("div", null, h("span", { className: "section-index" }, "下一步"), h("h2", null, section.heading), h(Paragraphs, { values: section.paragraphs })), h("a", { className: "button button--inverse", href: "#contact" }, "开始沟通"), h(SourceNote, { ids: section.sourceDocumentIds }));
}

const SECTION_COMPONENTS = Object.freeze({
  statement: StatementSection,
  split: SplitSection,
  cards: CardsSection,
  timeline: TimelineSection,
  faq: FaqSection,
  proof: ProofSection,
  cta: CtaSection
});

function SiteHeader({ site }) {
  return h("header", { className: "site-header" }, h("nav", { className: "shell nav", "aria-label": "主导航" }, h("a", { className: "brand", href: "/" }, site.brandLogo ? h("img", { className: "brand-logo", src: site.brandLogo, width: site.brandLogoWidth, height: site.brandLogoHeight, alt: site.companyName + " Logo" }) : null, h("span", null, site.companyName)), h("div", { className: "nav-links" }, ...site.navigation.map((item) => h("a", { href: item.href, key: item.href }, item.title)))));
}

function SiteFooter({ site }) {
  return h("footer", { className: "site-footer" }, h("div", { className: "shell footer-row" }, h("strong", null, site.companyName)));
}

function SitePage({ page }) {
  const family = safeHeroFamily(page.heroFamily);
  const Hero = HERO_COMPONENTS[family];
  return h(React.Fragment, null, h(Hero, { page }), h("div", { className: "shell facts", id: "content" }, ...page.sections.map((section) => { const Component = SECTION_COMPONENTS[section.variant] || CardsSection; return h(Component, { key: section.slotId, section }); })), page.contacts.length > 0 ? h("section", { className: "contact", id: "contact" }, h("div", { className: "shell" }, h("p", { className: "eyebrow" }, "Contact"), h("h2", null, "联系我们"), h("ul", { className: "contact-list" }, ...page.contacts.map((contact, index) => h("li", { key: index }, contact.href ? h("a", { href: contact.href }, contact.label) : contact.label))))) : h("span", { id: "contact", hidden: true }));
}

function jsonLdMarkup(value) {
  if (!value) return null;
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

export function SiteDocument({ site, page }) {
  const jsonLd = jsonLdMarkup(page.jsonLd);
  return h(
    "html",
    { lang: site.language },
    h(
      "head",
      null,
      h("meta", { charSet: "UTF-8" }),
      h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
      h("meta", { name: "description", content: page.description }),
      h("meta", { name: "robots", content: site.robots }),
      h("meta", { property: "og:type", content: "website" }),
      h("meta", { property: "og:title", content: page.title }),
      h("meta", { property: "og:description", content: page.description }),
      page.canonical ? h("link", { rel: "canonical", href: page.canonical }) : null,
      page.canonical ? h("meta", { property: "og:url", content: page.canonical }) : null,
      site.socialImage ? h("meta", { property: "og:image", content: site.socialImage }) : null,
      site.socialImage ? h("meta", { name: "twitter:card", content: "summary_large_image" }) : null,
      site.socialImage ? h("meta", { name: "twitter:image", content: site.socialImage }) : null,
      jsonLd ? h("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: jsonLd } }) : null,
      h("link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }),
      h("link", { rel: "stylesheet", href: "/styles.css" }),
      h("title", null, page.title)
    ),
    h("body", { className: site.bodyClass }, h(SiteHeader, { site }), h("main", null, h(SitePage, { page })), h(SiteFooter, { site }))
  );
}

export function NotFoundDocument({ site, page }) {
  return h(
    "html",
    { lang: site.language },
    h("head", null, h("meta", { charSet: "UTF-8" }), h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }), h("meta", { name: "description", content: page.description }), h("meta", { name: "robots", content: site.robots }), h("link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }), h("link", { rel: "stylesheet", href: "/styles.css" }), h("title", null, page.title)),
    h("body", { className: site.bodyClass }, h(SiteHeader, { site }), h("main", null, h("section", { className: "hero hero--not-found" }, h("div", { className: "shell" }, h(Eyebrow, null, "404"), h("h1", null, "页面未找到"), h("p", { className: "lede" }, h("a", { href: "/" }, "返回首页"))))), h(SiteFooter, { site }))
  );
}
`;

/** Host-owned build entrypoint copied verbatim into source.zip. */
export const TRUSTED_REACT_RENDERER_SOURCE = String.raw`import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotFoundDocument, SiteDocument } from "./component-library.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const sourceRoot = path.join(projectRoot, "src");

function trustedPath(root, relative) {
  if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0") || relative.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("SITEOPS_REACT_PROJECT_PATH_INVALID");
  }
  const absolute = path.join(root, ...relative.split("/"));
  const resolved = path.relative(root, absolute);
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error("SITEOPS_REACT_PROJECT_PATH_ESCAPE");
  return absolute;
}

async function json(relative) {
  const raw = await readFile(trustedPath(sourceRoot, relative), "utf8");
  return JSON.parse(raw);
}

async function emit(outputPath, element) {
  const target = trustedPath(distRoot, outputPath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const html = "<!doctype html>" + renderToStaticMarkup(element) + "\n";
  await writeFile(target, html, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

const manifest = await json("route-manifest.json");
const site = await json("data/site.json");
if (manifest.schemaVersion !== 1 || manifest.renderer !== "react_static_v1" || !Array.isArray(manifest.routes)) {
  throw new Error("SITEOPS_REACT_PROJECT_MANIFEST_INVALID");
}

await rm(distRoot, { recursive: true, force: true });
await cp(path.join(projectRoot, "public"), distRoot, { recursive: true, force: false, errorOnExist: true });
for (const route of manifest.routes) {
  const page = await json(route.dataPath);
  await emit(route.outputPath, React.createElement(SiteDocument, { site, page }));
}
const notFound = await json(manifest.notFound.dataPath);
await emit(manifest.notFound.outputPath, React.createElement(NotFoundDocument, { site, page: notFound }));
process.stdout.write(JSON.stringify({ renderer: "react_static_v1", routes: manifest.routes.length, htmlFiles: manifest.routes.length + 1 }) + "\n");
`;

type TrustedVisualPreviewBlueprint = TrustedVisualPreviewBlueprintV3;

const PREVIEW_CSS = String.raw`
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--canvas);color:var(--ink)}body.type-system--editorial_serif{font-family:Georgia,"Times New Roman",serif}body.type-system--technical_sans{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}body.type-system--humanist_sans{font-family:"Trebuchet MS",ui-sans-serif,system-ui,sans-serif}.frame{position:relative;width:1200px;height:900px;overflow:hidden;background:var(--canvas)}.radius--none{--radius:0px}.radius--soft{--radius:8px}.radius--rounded{--radius:22px}.radius--pill{--radius:999px}.frame:before{pointer-events:none;position:absolute;inset:0;z-index:0}.decoration--grid:before{content:"";background-image:linear-gradient(color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px);background-size:46px 46px}.decoration--editorial_lines:before{content:"";left:68px;right:68px;border-inline:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}.decoration--glow:before{content:"";background:radial-gradient(circle at 78% 18%,color-mix(in srgb,var(--accent) 32%,transparent),transparent 34%)}.decoration--orbital:before{content:"";width:520px;height:520px;left:auto;right:-180px;top:120px;border:1px solid color-mix(in srgb,var(--accent) 32%,transparent);border-radius:50%}.nav{height:82px;display:flex;align-items:center;justify-content:space-between;padding:0 68px;border-bottom:1px solid color-mix(in srgb,var(--ink) 16%,transparent);position:relative;z-index:5}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:-.03em}.brand-mark{width:32px;height:32px;border-radius:10px;background:var(--accent);display:grid;place-items:center;color:var(--canvas)}.links{display:flex;gap:26px;font-size:14px}.hero{position:relative;height:818px;padding:74px 68px}.density--compact .hero{padding-top:48px;padding-bottom:48px}.density--spacious .hero{padding-top:92px;padding-bottom:92px}.eyebrow{font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}h1{font-size:76px;line-height:.94;letter-spacing:-.065em;margin:18px 0 24px;max-width:850px}p{font-size:20px;line-height:1.55;max-width:660px;margin:0}.actions{display:flex;gap:12px;margin-top:34px}.button{padding:14px 22px;border-radius:999px;border:1px solid currentColor;font-weight:750}.button.primary{background:var(--ink);color:var(--canvas)}.floating_orbit .copy,.centered_dual_cta .copy{text-align:center;margin:auto}.floating_orbit h1,.floating_orbit p,.centered_dual_cta h1,.centered_dual_cta p{margin-left:auto;margin-right:auto}.floating_orbit .actions,.centered_dual_cta .actions{justify-content:center}.orbit{position:absolute;border:1px solid color-mix(in srgb,var(--ink) 28%,transparent);border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--canvas) 82%,var(--accent));font-size:30px}.o1{width:160px;height:160px;left:55px;top:135px}.o2{width:120px;height:120px;right:95px;top:90px}.o3{width:190px;height:190px;right:55px;bottom:70px}.o4{width:108px;height:108px;left:145px;bottom:110px}.split_media{display:grid;grid-template-columns:1.08fr .92fr;gap:58px;align-items:center}.split-visual{height:610px;border-radius:var(--radius);background:linear-gradient(145deg,var(--ink),var(--accent));position:relative;overflow:hidden}.split-visual:before,.split-visual:after{content:"";position:absolute;border:1px solid color-mix(in srgb,var(--canvas) 65%,transparent);border-radius:50%;aspect-ratio:1}.split-visual:before{width:520px;right:-190px;top:-130px}.split-visual:after{width:250px;left:45px;bottom:50px;background:color-mix(in srgb,var(--accent) 70%,transparent)}.editorial{padding-top:42px}.editorial .folio{font:700 12px ui-monospace,monospace;letter-spacing:.22em;border-bottom:1px solid currentColor;padding-bottom:16px}.editorial h1{font-family:Georgia,serif;font-size:102px;max-width:1040px}.editorial .deck{margin-left:auto;max-width:380px;border-left:4px solid var(--accent);padding-left:22px}.bento{display:grid;grid-template-columns:1.35fr .65fr .65fr;grid-template-rows:1fr 1fr;gap:18px;padding-top:44px}.tile{border-radius:var(--radius);background:var(--muted);padding:30px}.bento .copy{grid-row:span 2;border:1px solid color-mix(in srgb,var(--ink) 18%,transparent);background:var(--canvas)}.bento .signal{display:flex;flex-direction:column;justify-content:space-between}.bento .mark{display:grid;place-items:center;background:var(--accent);color:var(--canvas);font-size:86px}.feature_grid h1{max-width:980px}.feature-row{display:grid;grid-template-columns:repeat(3,1fr);margin-top:62px;border-block:1px solid color-mix(in srgb,var(--ink) 24%,transparent)}.feature{min-height:190px;padding:28px;border-right:1px solid color-mix(in srgb,var(--ink) 24%,transparent)}.feature:last-child{border:0}.feature small{color:var(--accent);font-weight:800}.feature strong{display:block;font-size:24px;margin-top:52px}.centered_dual_cta{display:grid;place-items:center}.centered_dual_cta h1{font-size:92px;max-width:980px}.immersive_visual{background:var(--ink);color:var(--canvas);display:flex;align-items:flex-end}.immersive_visual .eyebrow{color:var(--accent)}.immersive_visual .field{position:absolute;inset:0;background:radial-gradient(circle at 18% 18%,var(--accent),transparent 30%),radial-gradient(circle at 82% 42%,color-mix(in srgb,var(--canvas) 24%,transparent),transparent 28%)}.immersive_visual .sphere{position:absolute;border:1px solid color-mix(in srgb,var(--canvas) 50%,transparent);border-radius:50%;aspect-ratio:1}.immersive_visual .s1{width:430px;right:40px;top:40px}.immersive_visual .s2{width:210px;right:300px;top:230px}.immersive_visual .copy{position:relative;padding-bottom:60px}.product_stage{padding-top:42px;text-align:center}.product_stage h1,.product_stage p{margin-left:auto;margin-right:auto}.stage{height:410px;margin-top:45px;border:1px solid color-mix(in srgb,var(--ink) 24%,transparent);border-radius:var(--radius);overflow:hidden;background:color-mix(in srgb,var(--canvas) 84%,white);box-shadow:0 34px 90px color-mix(in srgb,var(--ink) 18%,transparent);text-align:left}.stage-bar{height:46px;border-bottom:1px solid color-mix(in srgb,var(--ink) 18%,transparent);display:flex;align-items:center;gap:7px;padding:0 18px}.stage-bar i{width:10px;height:10px;border-radius:50%;background:var(--accent)}.stage-body{display:grid;grid-template-columns:180px 1fr;height:364px}.stage-body aside{background:var(--ink)}.stage-content{padding:54px}.stage-content strong{font-size:42px}.line{height:13px;background:var(--muted);border-radius:20px;margin-top:25px}.line.short{width:62%}.full_bleed_statement{background:var(--accent);color:var(--canvas);display:flex;align-items:center}.full_bleed_statement h1{font-size:126px;max-width:1080px}.full_bleed_statement .eyebrow{color:var(--canvas)}.full_bleed_statement .rail{position:absolute;right:28px;top:40px;writing-mode:vertical-rl;letter-spacing:.22em;text-transform:uppercase;font-size:11px}
`;

function previewCopy(brief: SiteBrief) {
  const offerings = brief.offerings.filter(Boolean).slice(0, 3);
  return {
    eyebrow: offerings[0] || "品牌官网",
    heading: brief.companyName,
    summary:
      brief.conversionGoal ||
      offerings.join(" · ") ||
      "用清晰、可信的表达连接企业能力与目标客户。",
    offerings:
      offerings.length > 0 ? offerings : ["企业能力", "产品服务", "客户价值"],
  };
}

function PreviewHero(input: {
  brief: SiteBrief;
  blueprint: TrustedVisualPreviewBlueprint;
}) {
  const h = React.createElement;
  const copy = previewCopy(input.brief);
  const family = input.blueprint.heroFamily;
  const copyNode = h(
    "div",
    { className: "copy" },
    h("div", { className: "eyebrow" }, copy.eyebrow),
    h("h1", null, copy.heading),
    h("p", null, copy.summary),
    h(
      "div",
      { className: "actions" },
      h("span", { className: "button primary" }, "了解更多"),
      h("span", { className: "button" }, "联系我们"),
    ),
  );
  if (family === "floating_orbit") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      ...["DNA", "✦", "◎", "↗"].map((value, index) =>
        h("span", { className: `orbit o${index + 1}`, key: value }, value),
      ),
    );
  }
  if (family === "split_media") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h("div", { className: "split-visual", "aria-hidden": "true" }),
    );
  }
  if (family === "editorial") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h("div", { className: "folio" }, "FRONTMIND / EDITION 01"),
      copyNode,
      h("p", { className: "deck" }, copy.offerings.join(" · ")),
    );
  }
  if (family === "bento") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h("div", { className: "tile copy" }, copyNode),
      h(
        "div",
        { className: "tile signal" },
        h("span", null, "01"),
        h("strong", null, copy.offerings[0]),
      ),
      h("div", { className: "tile" }, copy.summary),
      h("div", { className: "tile mark", "aria-hidden": "true" }, "✦"),
    );
  }
  if (family === "feature_grid") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        { className: "feature-row" },
        ...copy.offerings.map((offering, index) =>
          h(
            "div",
            { className: "feature", key: offering },
            h("small", null, `0${index + 1}`),
            h("strong", null, offering),
          ),
        ),
      ),
    );
  }
  if (family === "immersive_visual") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h(
        "div",
        { className: "field", "aria-hidden": "true" },
        h("i", { className: "sphere s1" }),
        h("i", { className: "sphere s2" }),
      ),
      copyNode,
    );
  }
  if (family === "product_stage") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        { className: "stage" },
        h("div", { className: "stage-bar" }, h("i"), h("i"), h("i")),
        h(
          "div",
          { className: "stage-body" },
          h("aside"),
          h(
            "div",
            { className: "stage-content" },
            h("strong", null, copy.offerings[0]),
            h("div", { className: "line" }),
            h("div", { className: "line short" }),
          ),
        ),
      ),
    );
  }
  if (family === "full_bleed_statement") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h("span", { className: "rail" }, copy.offerings.join(" / ")),
    );
  }
  return h(
    "section",
    {
      className: `hero centered_dual_cta`,
      "data-hero-family": "centered_dual_cta",
    },
    copyNode,
  );
}

export function renderTrustedVisualCandidateHtml(input: {
  brief: SiteBrief;
  blueprint: TrustedVisualPreviewBlueprint;
}) {
  const h = React.createElement;
  const { palette } = input.blueprint;
  const companyInitial = Array.from(input.brief.companyName.trim())[0] || "F";
  const page = h(
    "html",
    { lang: input.brief.primaryLanguage },
    h(
      "head",
      null,
      h("meta", { charSet: "utf-8" }),
      h("meta", { name: "viewport", content: "width=1200" }),
      h("style", null, PREVIEW_CSS),
    ),
    h(
      "body",
      {
        className: `type-system--${input.blueprint.typeSystem}`,
        style: {
          "--canvas": palette.canvas,
          "--ink": palette.ink,
          "--accent": palette.accent,
          "--muted": palette.muted,
        } as React.CSSProperties,
      },
      h(
        "div",
        {
          className: `frame density--${input.blueprint.density} radius--${input.blueprint.radiusStyle} motion--${input.blueprint.motionLevel} decoration--${input.blueprint.decorationStyle} background--${input.blueprint.backgroundStyle}`,
        },
        h(
          "header",
          { className: "nav" },
          h(
            "div",
            { className: "brand" },
            h("span", { className: "brand-mark" }, companyInitial),
            input.brief.companyName,
          ),
          h(
            "nav",
            { className: "links" },
            h("span", null, "首页"),
            h("span", null, "服务"),
            h("span", null, "关于"),
            h("span", null, "联系"),
          ),
        ),
        h(PreviewHero, input),
      ),
    ),
  );
  return `<!doctype html>${renderToStaticMarkup(page)}`;
}

export async function renderTrustedVisualCandidatePreviews(input: {
  brief: SiteBrief;
  blueprints: TrustedVisualPreviewBlueprint[];
  signal: AbortSignal;
}) {
  if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
  const renderController = new AbortController();
  const forwardAbort = () => renderController.abort(abortReason(input.signal));
  input.signal.addEventListener("abort", forwardAbort, { once: true });
  const renderTimeout = setTimeout(
    () =>
      renderController.abort(
        new DOMException("Visual preview render timed out", "TimeoutError"),
      ),
    VISUAL_PREVIEW_RENDER_BUDGET_MS,
  );
  const signal = renderController.signal;
  const launchPromise = chromium.launch({
    headless: true,
    chromiumSandbox: false,
    timeout: VISUAL_PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS,
  });
  let browser: Awaited<typeof launchPromise> | undefined;
  try {
    try {
      browser = await raceWithAbort(launchPromise, signal);
    } catch (error) {
      if (signal.aborted) {
        void launchPromise
          .then((lateBrowser) => lateBrowser.close())
          .catch(() => undefined);
      }
      throw error;
    }
    const closeOnAbort = () => void browser?.close().catch(() => undefined);
    signal.addEventListener("abort", closeOnAbort, { once: true });
    const page = await raceWithAbort(
      browser.newPage({
        viewport: { width: 1200, height: 900 },
        deviceScaleFactor: 1,
      }),
      signal,
    );
    const previews: Array<{
      heroFamily: ReferenceBlueprintV3["heroFamily"];
      buffer: Buffer;
    }> = [];
    try {
      for (const blueprint of input.blueprints) {
        if (signal.aborted) throw abortReason(signal);
        await raceWithAbort(
          page.setContent(
            renderTrustedVisualCandidateHtml({ brief: input.brief, blueprint }),
            { waitUntil: "domcontentloaded", timeout: 10_000 },
          ),
          signal,
        );
        const buffer = await raceWithAbort(
          page.screenshot({
            type: "png",
            fullPage: false,
            animations: "disabled",
            timeout: 10_000,
          }),
          signal,
        );
        previews.push({
          heroFamily: blueprint.heroFamily,
          buffer: Buffer.from(buffer),
        });
      }
      return previews;
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
    }
  } finally {
    clearTimeout(renderTimeout);
    input.signal.removeEventListener("abort", forwardAbort);
    await browser?.close().catch(() => undefined);
  }
}
