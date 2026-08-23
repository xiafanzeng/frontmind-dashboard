import { describe, expect, it } from "vitest";

import { renderTrustedVisualCandidatePreviews } from "./react-static-runtime";

describe("trusted visual preview renderer", () => {
  it("rejects an already-aborted render before launching Chromium", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderTrustedVisualCandidatePreviews({
        brief: {} as never,
        blueprints: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
