import { useEffect, useMemo, useState } from "react";
import { BookOpen, Database, FileText, Images, Search } from "lucide-react";

import MarkdownRenderer from "@/components/MarkdownRenderer";
import { Input } from "@/components/ui/input";
import type { KnowledgeAsset, KnowledgeDocument } from "@shared/dashboard";

type KnowledgeDisplayAsset = KnowledgeAsset & {
  sectionHint?: string;
  caption?: string;
  alt?: string;
  source?: string;
  title?: string;
  documentPath?: string;
};

export type KnowledgeSnapshotView = {
  id: string;
  version: number;
  sourceFileName: string;
  documents: KnowledgeDocument[];
  assets: KnowledgeDisplayAsset[];
  documentCount: number;
  imageCount: number;
  characterCount: number;
  totalBytes: number;
  createdAt: Date | number | string;
};

function archiveFileName(filePath: string) {
  return filePath.replaceAll("\\", "/").split("/").pop()?.toLowerCase() || "";
}

function splitMarkdownSections(content: string) {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line) && current.some((item) => item.trim())) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some((item) => item.trim()))
    sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

function sectionHeading(content: string) {
  return content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || "";
}

function normalizedMatchValue(value: string | undefined) {
  return (value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("\\", "/")
    .replace(/https?:\/\//g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const genericAssetTerms = new Set([
  "asset",
  "assets",
  "company",
  "image",
  "images",
  "knowledge",
  "kb",
  "media",
  "photo",
  "photos",
  "picture",
  "pictures",
  "www",
  "com",
  "cn",
  "企业",
  "图片",
  "图像",
  "照片",
  "素材",
  "知识库",
]);

function matchingTerms(value: string) {
  let normalizedValue = value.replaceAll("\\", "/");
  try {
    normalizedValue = decodeURI(normalizedValue);
  } catch {
    // Keep the original text when an imported source contains malformed escapes.
  }
  return normalizedValue
    .split("/")
    .flatMap((part) => {
      const withoutExtension = part.replace(/\.[^.]+$/, "");
      return withoutExtension.split(/[_.\-\s]+/);
    })
    .map((part) => normalizedMatchValue(part))
    .filter(
      (part) =>
        part.length >= 2 && !genericAssetTerms.has(part) && !/^\d+$/.test(part),
    );
}

function assetPathTerms(asset: KnowledgeDisplayAsset) {
  return matchingTerms(asset.path);
}

function includesMeaningful(haystack: string, needle: string) {
  return needle.length >= 2 && haystack.includes(needle);
}

function directReferenceScore(asset: KnowledgeDisplayAsset, section: string) {
  const normalizedSection = section.toLowerCase().replaceAll("\\", "/");
  const assetPath = asset.path.replaceAll("\\", "/").toLowerCase();
  const assetName = archiveFileName(assetPath);
  if (asset.url && normalizedSection.includes(asset.url.toLowerCase()))
    return 1_000;
  if (normalizedSection.includes(assetPath)) return 980;
  if (assetName.length > 3 && normalizedSection.includes(assetName)) return 960;
  return 0;
}

function contextualAssetScore(input: {
  asset: KnowledgeDisplayAsset;
  document: KnowledgeDocument;
  section: string;
}) {
  const { asset, document, section } = input;
  const normalizedSection = normalizedMatchValue(section);
  const normalizedHeading = normalizedMatchValue(sectionHeading(section));
  const normalizedDocument = normalizedMatchValue(
    `${document.title} ${document.path}`,
  );
  let score = 0;

  const sectionHint = normalizedMatchValue(asset.sectionHint);
  if (sectionHint) {
    if (
      includesMeaningful(normalizedHeading, sectionHint) ||
      includesMeaningful(sectionHint, normalizedHeading)
    ) {
      score += 120;
    } else if (includesMeaningful(normalizedSection, sectionHint)) {
      score += 90;
    } else if (includesMeaningful(normalizedDocument, sectionHint)) {
      score += 70;
    }
  }

  const documentPath = normalizedMatchValue(asset.documentPath);
  if (
    documentPath &&
    (includesMeaningful(normalizedDocument, documentPath) ||
      includesMeaningful(documentPath, normalizedDocument))
  ) {
    score += 100;
  }

  for (const value of [asset.caption, asset.alt, asset.title]) {
    const normalized = normalizedMatchValue(value);
    if (!normalized) continue;
    if (
      includesMeaningful(normalizedHeading, normalized) ||
      includesMeaningful(normalized, normalizedHeading)
    ) {
      score += 45;
    } else if (includesMeaningful(normalizedSection, normalized)) {
      score += 32;
    } else if (includesMeaningful(normalizedDocument, normalized)) {
      score += 18;
    }
  }

  const source = normalizedMatchValue(asset.source);
  if (source) {
    if (includesMeaningful(normalizedSection, source)) score += 55;
    else if (
      includesMeaningful(normalizedDocument, source) ||
      includesMeaningful(source, normalizedDocument)
    )
      score += 40;
    for (const term of matchingTerms(asset.source || "")) {
      if (includesMeaningful(normalizedHeading, term)) score += 28;
      else if (includesMeaningful(normalizedSection, term)) score += 18;
      else if (includesMeaningful(normalizedDocument, term)) score += 12;
    }
  }

  for (const term of assetPathTerms(asset)) {
    if (includesMeaningful(normalizedHeading, term)) score += 20;
    else if (includesMeaningful(normalizedSection, term)) score += 12;
    else if (includesMeaningful(normalizedDocument, term)) score += 8;
  }
  return score;
}

type AssetPlacement = {
  bySection: Map<string, Map<number, KnowledgeDisplayAsset[]>>;
  relatedByDocument: Map<string, KnowledgeDisplayAsset[]>;
};

function placeKnowledgeAssets(snapshot: KnowledgeSnapshotView): AssetPlacement {
  const bySection = new Map<string, Map<number, KnowledgeDisplayAsset[]>>();
  const relatedByDocument = new Map<string, KnowledgeDisplayAsset[]>();
  const documentSections = snapshot.documents.map((document) => ({
    document,
    sections: splitMarkdownSections(document.content),
  }));
  const fallbackDocument = snapshot.documents[0];

  for (const asset of snapshot.assets.filter((candidate) => candidate.url)) {
    let best:
      | {
          documentPath: string;
          sectionIndex: number;
          score: number;
        }
      | undefined;

    for (const entry of documentSections) {
      entry.sections.forEach((section, sectionIndex) => {
        const directScore = directReferenceScore(asset, section);
        const score =
          directScore ||
          contextualAssetScore({
            asset,
            document: entry.document,
            section,
          });
        if (!best || score > best.score) {
          best = {
            documentPath: entry.document.path,
            sectionIndex,
            score,
          };
        }
      });
    }

    if (best && best.score > 0) {
      const documentMap =
        bySection.get(best.documentPath) ||
        new Map<number, KnowledgeDisplayAsset[]>();
      const sectionAssets = documentMap.get(best.sectionIndex) || [];
      sectionAssets.push(asset);
      documentMap.set(best.sectionIndex, sectionAssets);
      bySection.set(best.documentPath, documentMap);
      continue;
    }

    if (fallbackDocument) {
      const related = relatedByDocument.get(fallbackDocument.path) || [];
      related.push(asset);
      relatedByDocument.set(fallbackDocument.path, related);
    }
  }

  return { bySection, relatedByDocument };
}

function assetDisplayName(asset: KnowledgeDisplayAsset) {
  return (
    asset.caption?.trim() ||
    asset.alt?.trim() ||
    asset.title?.trim() ||
    archiveFileName(asset.path)
      .replace(/\.[^.]+$/, "")
      .replaceAll(/[_-]+/g, " ")
  );
}

function isExternalHttpUrl(value: string | undefined) {
  return /^https?:\/\//i.test(value || "");
}

function KnowledgeImageGrid({
  assets,
  ariaLabel,
  alternating = false,
}: {
  assets: KnowledgeDisplayAsset[];
  ariaLabel: string;
  alternating?: boolean;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className={`grid h-full gap-3 border-[#e8e1ee] bg-white p-4 ${
        alternating ? "lg:order-first lg:border-r" : "lg:border-l"
      }`}
    >
      {assets.map((asset) => {
        const displayName = assetDisplayName(asset);
        return (
          <figure key={asset.key} className="min-w-0">
            <img
              src={asset.url}
              alt={asset.alt?.trim() || displayName}
              loading="lazy"
              className="aspect-[4/3] w-full rounded-2xl bg-[#f6f3f8] object-cover"
            />
            <figcaption className="px-1 pt-2 text-xs leading-5 text-[#716a80]">
              <span className="block break-words font-medium text-[#51495d]">
                {displayName}
              </span>
              {isExternalHttpUrl(asset.source) && (
                <a
                  href={asset.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 inline-flex text-[#6d3497] hover:underline"
                >
                  查看图片来源
                </a>
              )}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

export default function KnowledgeBaseViewer({
  snapshot,
  loading = false,
}: {
  snapshot?: KnowledgeSnapshotView | null;
  loading?: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setSelectedPath(snapshot?.documents[0]?.path ?? null);
  }, [snapshot?.id]);

  const filteredDocuments = useMemo(() => {
    if (!snapshot) return [];
    const keyword = search.trim().toLowerCase();
    if (!keyword) return snapshot.documents;
    return snapshot.documents.filter(
      (document) =>
        document.title.toLowerCase().includes(keyword) ||
        document.path.toLowerCase().includes(keyword) ||
        document.content.toLowerCase().includes(keyword),
    );
  }, [search, snapshot]);

  const selectedDocument =
    snapshot?.documents.find((document) => document.path === selectedPath) ||
    filteredDocuments[0] ||
    snapshot?.documents[0];
  const documentSections = useMemo(
    () =>
      selectedDocument ? splitMarkdownSections(selectedDocument.content) : [],
    [selectedDocument],
  );
  const assetPlacement = useMemo(
    () => (snapshot ? placeKnowledgeAssets(snapshot) : null),
    [snapshot],
  );
  const selectedSectionAssets = selectedDocument
    ? assetPlacement?.bySection.get(selectedDocument.path)
    : undefined;
  const selectedRelatedAssets = selectedDocument
    ? assetPlacement?.relatedByDocument.get(selectedDocument.path) || []
    : [];
  if (loading) {
    return (
      <div className="grid min-h-[520px] place-items-center rounded-[20px] border border-[#e8e1ee] bg-white/80">
        <div className="text-center text-sm text-[#716a80]">
          <Database className="mx-auto mb-3 h-7 w-7 animate-pulse text-[#5b2a86]" />
          正在加载知识库
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="grid min-h-[520px] place-items-center rounded-[20px] border border-dashed border-[#d8cde3] bg-white/65 px-6 text-center">
        <div className="max-w-md">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#5b2a86]/10 text-[#5b2a86]">
            <BookOpen className="h-6 w-6" />
          </div>
          <h2 className="mt-5 text-xl font-semibold text-[#171321]">
            尚未发布知识库
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#716a80]">
            在“构建流程”中完成全部节点后，点击“更新知识库”同步最终内容；管理员也可以上传已有知识库文件。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          ["知识文档", `${snapshot.documentCount} 篇`],
          ["图片资产", `${snapshot.imageCount} 张`],
          ["内容字数", snapshot.characterCount.toLocaleString("zh-CN")],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-[#e8e1ee] bg-white px-4 py-3 shadow-[0_8px_24px_rgba(33,19,58,.045)]"
          >
            <p className="text-xs text-[#716a80]">{label}</p>
            <p className="mt-1 text-lg font-semibold text-[#5b2a86]">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid min-h-[650px] overflow-hidden rounded-[20px] border border-[#e8e1ee] bg-white shadow-[0_18px_48px_rgba(33,19,58,.07)] lg:grid-cols-[290px_minmax(0,1fr)]">
        <aside className="border-b border-[#e8e1ee] bg-[#fbf9fd] p-4 lg:border-b-0 lg:border-r">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a94a8]" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索全部知识内容"
              className="border-[#e1d8e8] bg-white pl-9"
            />
          </div>
          <p className="mb-2 mt-5 px-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#9a94a8]">
            文档目录
          </p>
          <div className="max-h-[510px] space-y-1 overflow-y-auto pr-1 custom-scrollbar">
            {filteredDocuments.map((document) => (
              <button
                key={document.path}
                type="button"
                onClick={() => setSelectedPath(document.path)}
                className={`flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition ${
                  selectedDocument?.path === document.path
                    ? "bg-[#5b2a86] text-white"
                    : "text-[#4f485c] hover:bg-[#eee8f2]"
                }`}
              >
                <FileText className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {document.title}
                  </span>
                  <span
                    className={`mt-0.5 block truncate text-xs ${
                      selectedDocument?.path === document.path
                        ? "text-white/60"
                        : "text-[#9a94a8]"
                    }`}
                  >
                    {document.path}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <article className="min-w-0 p-5 sm:p-8 lg:p-10">
          {selectedDocument ? (
            <>
              <div className="mb-8 border-b border-[#e8e1ee] pb-5">
                <p className="text-xs font-semibold text-[#5b2a86]">
                  知识库文档
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[#171321]">
                  {selectedDocument.title}
                </h2>
                <p className="mt-2 break-all text-xs text-[#9a94a8]">
                  {selectedDocument.path}
                </p>
              </div>
              <div className="space-y-6">
                {documentSections.map((section, index) => {
                  const sectionAssets = selectedSectionAssets?.get(index) || [];
                  return (
                    <section
                      key={`${selectedDocument.path}-${index}`}
                      className={`overflow-hidden rounded-[22px] border border-[#e8e1ee] bg-[#fbf9fd] ${
                        sectionAssets.length > 0
                          ? "grid items-start lg:grid-cols-[minmax(0,1fr)_minmax(280px,.72fr)]"
                          : ""
                      }`}
                    >
                      <div className="min-w-0 p-5 sm:p-7">
                        <MarkdownRenderer
                          content={section}
                          className="max-w-none text-[15px] leading-7"
                        />
                      </div>
                      {sectionAssets.length > 0 && (
                        <KnowledgeImageGrid
                          assets={sectionAssets}
                          ariaLabel={`${sectionHeading(section) || "知识正文"}配图`}
                          alternating={index % 2 === 1}
                        />
                      )}
                    </section>
                  );
                })}
                {selectedRelatedAssets.length > 0 && (
                  <section
                    aria-label="相关图片"
                    className="overflow-hidden rounded-[22px] border border-[#e8e1ee] bg-[#fbf9fd]"
                  >
                    <div className="flex items-center gap-3 border-b border-[#e8e1ee] px-5 py-4 sm:px-7">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#5b2a86]/10 text-[#5b2a86]">
                        <Images className="h-4 w-4" />
                      </span>
                      <h3 className="text-base font-semibold text-[#2e2738]">
                        相关图片
                      </h3>
                    </div>
                    <div className="grid gap-4 bg-white p-4 sm:grid-cols-2 xl:grid-cols-3">
                      {selectedRelatedAssets.map((asset) => {
                        const displayName = assetDisplayName(asset);
                        return (
                          <figure key={asset.key} className="min-w-0">
                            <img
                              src={asset.url}
                              alt={asset.alt?.trim() || displayName}
                              loading="lazy"
                              className="aspect-[4/3] w-full rounded-2xl bg-[#f6f3f8] object-cover"
                            />
                            <figcaption className="px-1 pt-2 text-xs leading-5 text-[#716a80]">
                              <span className="block break-words font-medium text-[#51495d]">
                                {displayName}
                              </span>
                              {isExternalHttpUrl(asset.source) && (
                                <a
                                  href={asset.source}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="mt-0.5 inline-flex text-[#6d3497] hover:underline"
                                >
                                  查看图片来源
                                </a>
                              )}
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center text-sm text-[#716a80]">
              没有匹配的知识内容
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
