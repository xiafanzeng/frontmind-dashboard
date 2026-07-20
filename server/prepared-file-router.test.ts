import { describe, expect, it } from "vitest";
import { parseByteRange } from "./prepared-file-router";
import { createPreparedAssetId } from "./prepared-file-service";

describe("prepared PDF byte ranges", () => {
  it("returns the complete response when Range is absent", () => {
    expect(parseByteRange(undefined, 1_000)).toBeNull();
  });

  it("parses bounded and open-ended ranges", () => {
    expect(parseByteRange("bytes=0-65535", 100_000)).toEqual({
      start: 0,
      end: 65_535,
    });
    expect(parseByteRange("bytes=900-", 1_000)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it("parses suffix ranges and clamps them to the file", () => {
    expect(parseByteRange("bytes=-100", 1_000)).toEqual({
      start: 900,
      end: 999,
    });
    expect(parseByteRange("bytes=-2000", 1_000)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it.each([
    "bytes=",
    "items=0-2",
    "bytes=5-2",
    "bytes=1000-",
    "bytes=0-1,5-6",
  ])("rejects invalid or unsupported range %s", range => {
    expect(parseByteRange(range, 1_000)).toBe("invalid");
  });
});

describe("prepared PDF asset identity", () => {
  it("is stable for the same owned upstream file", () => {
    const first = createPreparedAssetId(7, "credential-1", {
      kind: "file",
      fileId: "file-123",
    });
    const second = createPreparedAssetId(7, "credential-1", {
      kind: "file",
      fileId: "file-123",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{40}$/);
  });

  it("isolates assets by owner and credential", () => {
    const source = { kind: "file" as const, fileId: "file-123" };
    expect(createPreparedAssetId(7, "credential-1", source)).not.toBe(
      createPreparedAssetId(8, "credential-1", source),
    );
    expect(createPreparedAssetId(7, "credential-1", source)).not.toBe(
      createPreparedAssetId(7, "credential-2", source),
    );
  });

  it("keeps a stable external asset id when only a signed query changes", () => {
    const first = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/report.pdf?signature=old",
    });
    const second = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/report.pdf?signature=new",
    });
    expect(first).toBe(second);
  });

  it("keeps content-selecting query parameters in the asset identity", () => {
    const first = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/download?file=report-a.pdf&signature=old",
    });
    const second = createPreparedAssetId(7, "credential-1", {
      kind: "external",
      url: "https://objects.example.com/download?file=report-b.pdf&signature=new",
    });
    expect(first).not.toBe(second);
  });
});
