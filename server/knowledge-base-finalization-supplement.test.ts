import { describe, expect, it } from "vitest";

import {
  finalizationSupplementCoverage,
  parseFinalizationSupplementNdjson,
} from "./knowledge-base-finalization-supplement";

function record(
  kind: "overview" | "evidence" | "report" | "index",
  index: number,
) {
  return JSON.stringify({
    kind,
    id: `${kind}-${index}`,
    title: `${kind} title`,
    branchId: "branch-a",
    order: index,
    sourceIds: ["source-b", "source-a", "source-a"],
    bodyMarkdown: `# ${kind}\n\nbody`,
  });
}

describe("FINALIZATION_SUPPLEMENT.ndjson", () => {
  it("accepts only supplemental documents and yields a deterministic fingerprint", () => {
    const text = [
      record("overview", 0),
      record("evidence", 1),
      record("report", 2),
      record("index", 3),
    ].join("\n");
    const first = parseFinalizationSupplementNdjson(text);
    const second = parseFinalizationSupplementNdjson(text);
    expect(first.semanticFingerprint).toBe(second.semanticFingerprint);
    expect(first.records[0]?.sourceIds).toEqual(["source-a", "source-b"]);
    expect(finalizationSupplementCoverage(first.records)).toEqual({
      complete: true,
      missingKinds: [],
    });
  });

  it("rejects leaf content, identity/state/hash/count fields and duplicate keys", () => {
    expect(() =>
      parseFinalizationSupplementNdjson(
        JSON.stringify({
          kind: "leaf",
          id: "leaf-1",
          title: "leaf",
          branchId: "branch-a",
          bodyMarkdown: "body",
        }),
      ),
    ).toThrow(/FINALIZATION_SUPPLEMENT_RECORD_INVALID/u);
    for (const forbidden of ["tenantId", "taskId", "turnId", "hash", "count"]) {
      const value = JSON.parse(record("overview", 0));
      value[forbidden] = "forbidden";
      expect(() =>
        parseFinalizationSupplementNdjson(JSON.stringify(value)),
      ).toThrow(/FINALIZATION_SUPPLEMENT_RECORD_INVALID/u);
    }
    expect(() =>
      parseFinalizationSupplementNdjson(
        '{"kind":"overview","kind":"report","id":"x","title":"x","branchId":"b","bodyMarkdown":"body"}',
      ),
    ).toThrow(/FINALIZATION_SUPPLEMENT_DUPLICATE_KEY/u);
  });

  it("reports incomplete supplemental coverage", () => {
    const parsed = parseFinalizationSupplementNdjson(
      [record("overview", 0), record("evidence", 1)].join("\n"),
    );
    expect(finalizationSupplementCoverage(parsed.records)).toEqual({
      complete: false,
      missingKinds: ["report", "index"],
    });
  });

  it("rejects adversarial nesting before recursive parsing can exhaust the stack", () => {
    const deeplyNested = `${"[".repeat(70)}0${"]".repeat(70)}`;
    expect(() => parseFinalizationSupplementNdjson(deeplyNested)).toThrow(
      /FINALIZATION_SUPPLEMENT_JSON_DEPTH_LIMIT/u,
    );
  });
});
