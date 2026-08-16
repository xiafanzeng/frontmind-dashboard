import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildWebsiteKnowledgeImportFixture } from "./__testutils__/website-knowledge-import-archive";
import {
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT,
  WebsiteKnowledgeImportArchiveError,
  canonicalizeWebsiteKnowledgeImportArchive,
} from "./website-knowledge-import-archive-adapter";

describe("Website knowledge-import archive adapter", () => {
  it("gives rootless and arbitrary single-root packages identical canonical bytes", async () => {
    const rootless = await buildWebsiteKnowledgeImportFixture();
    const rooted = await buildWebsiteKnowledgeImportFixture({
      root: "另一个企业知识库根目录",
      reverse: true,
      date: new Date("2024-02-03T04:05:06.000Z"),
      unixPermissions: 0o100664,
      compressionLevel: 9,
    });

    const first = await canonicalizeWebsiteKnowledgeImportArchive(
      rootless.buffer,
    );
    const second = await canonicalizeWebsiteKnowledgeImportArchive(
      rooted.buffer,
    );
    const idempotent = await canonicalizeWebsiteKnowledgeImportArchive(
      first.buffer,
    );

    expect(second.sha256).toBe(first.sha256);
    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(idempotent.sha256).toBe(first.sha256);
    expect(idempotent.buffer.equals(first.buffer)).toBe(true);

    const canonical = await JSZip.loadAsync(first.buffer, { checkCRC32: true });
    const entries = Object.values(canonical.files).filter(
      (entry) => !entry.dir,
    );
    expect(entries.length).toBeGreaterThan(40);
    expect(
      entries.every((entry) =>
        entry.name.startsWith(`${WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT}/`),
      ),
    ).toBe(true);
    expect(
      entries.every(
        (entry) =>
          entry.date.toISOString() === "1980-01-01T00:00:00.000Z" &&
          entry.unixPermissions === 0o100644,
      ),
    ).toBe(true);

    const rootlessZip = await JSZip.loadAsync(rootless.buffer, {
      checkCRC32: true,
    });
    const originalManifest = await rootlessZip
      .file("00_package_manifest.json")!
      .async("nodebuffer");
    const canonicalManifest = await canonical
      .file(
        `${WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT}/00_package_manifest.json`,
      )!
      .async("nodebuffer");
    expect(canonicalManifest.equals(originalManifest)).toBe(true);
  });

  it("feeds a rootless Website package through the real strict reader without relaxing it", async () => {
    const source = await buildWebsiteKnowledgeImportFixture();
    await expect(
      readKnowledgeArchive(
        source.buffer,
        "rootless-website.zip",
        "raw-rootless-reader",
        { validationProfile: "website-lead-v1" },
      ),
    ).rejects.toThrow("知识库 ZIP 必须只包含一个企业知识库根目录");

    const canonical = await canonicalizeWebsiteKnowledgeImportArchive(
      source.buffer,
    );
    const parsed = await readKnowledgeArchive(
      canonical.buffer,
      "canonical-website.zip",
      "canonical-reader",
      { validationProfile: "website-lead-v1" },
    );
    try {
      expect(parsed.packageManifestSha256).toBe(source.packageManifestSha256);
      expect(
        parsed.documents.filter((document) => document.customerVisible),
      ).toHaveLength(40);
      expect(parsed.assets).toHaveLength(0);
    } finally {
      await removeStoredKnowledgeAssets(parsed.storedAssetKeys);
    }
  });

  it.each([
    {
      label: "a root and child copy of a standard file",
      mutate: (entries: Map<string, Buffer>) =>
        entries.set("nested/README.md", Buffer.from("duplicate", "utf8")),
    },
    {
      label: "multiple package manifests",
      mutate: (entries: Map<string, Buffer>) =>
        entries.set(
          "nested/00_package_manifest.json",
          entries.get("00_package_manifest.json")!,
        ),
    },
    {
      label: "multiple completeness reports",
      mutate: (entries: Map<string, Buffer>) =>
        entries.set(
          "nested/00_completeness.json",
          entries.get("00_completeness.json")!,
        ),
    },
  ])("rejects $label", async ({ mutate }) => {
    const source = await buildWebsiteKnowledgeImportFixture({ mutate });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(source.buffer),
    ).rejects.toBeInstanceOf(WebsiteKnowledgeImportArchiveError);
  });

  it("rejects duplicate normalized paths before choosing a package root", async () => {
    const source = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) =>
        entries.set("ＲＥＡＤＭＥ.md", Buffer.from("duplicate", "utf8")),
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(source.buffer),
    ).rejects.toThrow("重复规范路径");
  });

  it("rejects exact duplicate central-directory names hidden by the ZIP reader", async () => {
    const source = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) => {
        entries.set("extra/dup1.txt", Buffer.from("one", "utf8"));
        entries.set("extra/dup2.txt", Buffer.from("two", "utf8"));
      },
    });
    const duplicate = Buffer.from(source.buffer);
    const originalName = Buffer.from("extra/dup2.txt", "utf8");
    const duplicateName = Buffer.from("extra/dup1.txt", "utf8");
    let replaced = 0;
    let offset = 0;
    while ((offset = duplicate.indexOf(originalName, offset)) >= 0) {
      duplicateName.copy(duplicate, offset);
      offset += duplicateName.length;
      replaced += 1;
    }
    expect(replaced).toBe(2);
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(duplicate),
    ).rejects.toThrow("重复或含糊的中央目录路径");
  });

  it("rejects traversal, symlink, nested-wrapper, and out-of-root entries", async () => {
    const traversal = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) =>
        entries.set("../escape.txt", Buffer.from("escape", "utf8")),
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(traversal.buffer),
    ).rejects.toThrow("不安全的文件路径");

    const symlink = await buildWebsiteKnowledgeImportFixture({
      unixPermissions: 0o120777,
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(symlink.buffer),
    ).rejects.toThrow("符号链接");

    const nested = await buildWebsiteKnowledgeImportFixture({
      root: "outer/inner",
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(nested.buffer),
    ).rejects.toThrow("不在同一包根目录");

    const rooted = await buildWebsiteKnowledgeImportFixture({ root: "root" });
    const outsideZip = await JSZip.loadAsync(rooted.buffer);
    outsideZip.file("outside.txt", "outside", {
      createFolders: false,
      unixPermissions: 0o100644,
    });
    const outside = await outsideZip.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(outside),
    ).rejects.toThrow("包根目录之外");
  });

  it("rejects invalid ZIP bytes and an archive over the entry limit", async () => {
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(Buffer.from("not-a-zip")),
    ).rejects.toBeInstanceOf(WebsiteKnowledgeImportArchiveError);

    const oversized = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) => {
        for (let index = 0; index < 2_000; index += 1) {
          entries.set(`extra/${index}.txt`, Buffer.from([index & 0xff]));
        }
      },
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(oversized.buffer),
    ).rejects.toThrow("文件数量超出限制");
  });
});
