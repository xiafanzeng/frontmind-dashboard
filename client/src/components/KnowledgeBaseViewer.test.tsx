import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import KnowledgeBaseViewer, {
  type KnowledgeSnapshotView,
} from "./KnowledgeBaseViewer";

const snapshot: KnowledgeSnapshotView = {
  id: "snapshot-1",
  version: 3,
  sourceFileName: "企业知识库.zip",
  documents: [
    {
      path: "01/company.md",
      title: "企业概览",
      content: "## 企业概览\n企业基本信息。",
    },
    {
      path: "02/products.md",
      title: "产品方案",
      content: "## 产品方案\n产品与解决方案。",
    },
  ],
  assets: [
    {
      key: "asset-1",
      path: "images/factory.jpg",
      mimeType: "image/jpeg",
      size: 2_048,
      url: "/api/dashboard/knowledge/assets/snapshot-1/0",
    },
    {
      key: "asset-2",
      path: "images/product-line.jpg",
      mimeType: "image/jpeg",
      size: 3_072,
      url: "/api/dashboard/knowledge/assets/snapshot-1/1",
      sectionHint: "产品方案",
      caption: "产品解决方案示意图",
      alt: "产品解决方案",
      source: "https://example.com/products",
    },
  ],
  documentCount: 2,
  imageCount: 2,
  characterCount: 22,
  totalBytes: 1_024,
  createdAt: "2026-07-25T08:00:00.000Z",
};

describe("KnowledgeBaseViewer", () => {
  it("keeps authoritative snapshot metrics but omits a decorative directory count", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    expect(screen.getByText("文档目录")).toBeTruthy();
    expect(screen.queryByText(/文档目录\s*·\s*2/)).toBeNull();
    expect(screen.getByText("2 篇")).toBeTruthy();
    expect(screen.getByText("2 张")).toBeTruthy();
    expect(screen.getByText("22")).toBeTruthy();
    expect(screen.queryByText("版本")).toBeNull();
    expect(screen.queryByText("V3")).toBeNull();
    expect(screen.queryByText("待关联图片资产")).toBeNull();
  });

  it("places unmatched images in a related-images section inside the knowledge document", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    const relatedSection = screen.getByRole("region", {
      name: "相关图片",
    });
    expect(
      within(relatedSection).getByRole("img", { name: "factory" }),
    ).toBeTruthy();
    expect(screen.queryByText("待关联图片资产")).toBeNull();
  });

  it("uses image metadata to place an asset beside its matching section", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /产品方案/,
      }),
    );

    const productImages = screen.getByLabelText("产品方案配图");
    expect(
      within(productImages).getByRole("img", { name: "产品解决方案" }),
    ).toBeTruthy();
    expect(within(productImages).getByText("产品解决方案示意图")).toBeTruthy();
    expect(
      within(productImages).getByRole("link", { name: "查看图片来源" }),
    ).toHaveAttribute("href", "https://example.com/products");
    expect(screen.queryByRole("region", { name: "相关图片" })).toBeNull();
  });
});
