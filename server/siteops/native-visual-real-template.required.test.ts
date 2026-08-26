import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  prepareNativeTemplateCandidate,
  readNativeSourceArchive,
} from "./native-visual-source";

const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/sanitized-vite-landing/", import.meta.url),
);
const ZIP_ROOT = "sanitized-vite-landing";
const FIXED_ZIP_DATE = new Date("2026-01-01T00:00:00.000Z");

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixtureFiles(
  directory = FIXTURE_ROOT,
  prefix = "",
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await fixtureFiles(absolute, relative)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Fixture entry must be a regular file: ${relative}`);
    }
    files.push({ path: relative, bytes: await readFile(absolute) });
  }
  return files;
}

async function realTemplateZip() {
  const zip = new JSZip();
  const files = await fixtureFiles();
  for (const file of files) {
    zip.file(`${ZIP_ROOT}/${file.path}`, file.bytes, {
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return { archive, files };
}

describe("required sanitized real Vite Template preparation", () => {
  it("normalizes, mirrors, builds, screenshots, and reads back a complete page-level project", async () => {
    const { archive, files: fixture } = await realTemplateZip();
    const fixturePaths = fixture.map((file) => file.path);
    expect(fixturePaths).toEqual(
      expect.arrayContaining([
        "package.json",
        "index.html",
        "vite.config.ts",
        "tsconfig.json",
        "src/main.tsx",
        "src/App.tsx",
        "src/App.css",
        "src/index.css",
        "src/components/Header.tsx",
        "src/components/Hero.tsx",
        "src/components/FeatureGrid.tsx",
        "src/components/Footer.tsx",
        "src/assets/product-preview.svg",
        "src/assets/dot-grid.svg",
        "public/brand-mark.svg",
      ]),
    );

    const providerZip = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect(providerZip.file(`${ZIP_ROOT}/src/main.tsx`)).not.toBeNull();
    expect(
      providerZip.file(`${ZIP_ROOT}/src/components/Hero.tsx`),
    ).not.toBeNull();

    let attemptedRemoteFetches = 0;
    const prepared = await prepareNativeTemplateCandidate({
      templateId: "sanitized-real-vite-landing",
      slug: "sanitized-real-vite-landing",
      version: "fixture-v1",
      archive,
      expectedArchiveSha256: sha256(archive),
      signal: AbortSignal.timeout(120_000),
      fetchRemoteAsset: async () => {
        attemptedRemoteFetches += 1;
        throw new Error("The sanitized fixture must not fetch remote media");
      },
      fetchRemoteStyleAsset: async () => {
        attemptedRemoteFetches += 1;
        throw new Error("The sanitized fixture must not fetch remote styles");
      },
    });

    expect(attemptedRemoteFetches).toBe(0);
    expect(prepared).toMatchObject({
      templateId: "sanitized-real-vite-landing",
      templateSlug: "sanitized-real-vite-landing",
      framework: "vite_react",
      entrypoint: "src/App.tsx",
      demoEntrypoint: "src/App.tsx",
      sourceDirectory: "source",
    });
    expect(prepared.sourceArchiveSha256).toBe(sha256(prepared.sourceArchive));
    expect(prepared.previewSha256).toBe(sha256(prepared.preview));

    const screenshot = await sharp(prepared.preview).metadata();
    expect(screenshot).toMatchObject({
      format: "png",
      width: 1440,
      height: 1000,
    });

    const restored = await readNativeSourceArchive(prepared.sourceArchive);
    expect(restored.manifest).toMatchObject({
      providerItemKey:
        "t:sanitized-real-vite-landing:sanitized-real-vite-landing",
      providerVersion: "fixture-v1",
      entrypoint: "src/App.tsx",
      demoEntrypoint: "src/App.tsx",
      sourceTreeSha256: prepared.sourceTreeSha256,
    });
    expect(restored.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "src/App.tsx",
        "src/App.css",
        "src/index.css",
        "src/components/Header.tsx",
        "src/components/Hero.tsx",
        "src/components/Hero.css",
        "src/components/FeatureGrid.tsx",
        "src/components/FeatureGrid.css",
        "src/components/Footer.tsx",
        "src/components/layout.css",
        "src/assets/product-preview.svg",
        "src/assets/dot-grid.svg",
        "public/brand-mark.svg",
      ]),
    );
    expect(
      restored.files
        .find((file) => file.path === "src/App.tsx")
        ?.bytes.toString("utf8"),
    ).toContain('data-template="sanitized-studio-landing"');
    expect(
      restored.files
        .find((file) => file.path === "src/main.tsx")
        ?.bytes.toString("utf8"),
    ).toContain("frontmind-tailwind.css");
    expect(
      restored.files
        .find((file) => file.path === "src/assets/product-preview.svg")
        ?.bytes.toString("utf8"),
    ).toContain("Sample project workspace");
  }, 150_000);
});
