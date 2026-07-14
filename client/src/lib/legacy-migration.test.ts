import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLegacyCredentials,
  DEVICE_PREFERENCES_STORAGE_KEY,
  hasLegacyApiKey,
  LEGACY_CONFIG_STORAGE_KEY,
  readLegacyApiKey,
} from "./legacy-migration";

describe("legacy credential migration helpers", () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.mocked(localStorage.removeItem).mockReset();
  });

  it("detects a legacy key without exposing unrelated invalid data", () => {
    vi.mocked(localStorage.getItem).mockReturnValue(
      JSON.stringify({ apiKey: "  legacy-secret  ", agentProfile: "frontmind-pro" })
    );

    expect(hasLegacyApiKey()).toBe(true);
    expect(readLegacyApiKey()).toBe("legacy-secret");
  });

  it("scrubs credentials and preserves device-only preferences", () => {
    vi.mocked(localStorage.getItem).mockReturnValue(
      JSON.stringify({
        apiKey: "legacy-secret",
        baseUrl: "https://old.example.test",
        agentProfile: "frontmind-base",
      })
    );

    clearLegacyCredentials();

    expect(localStorage.setItem).toHaveBeenCalledWith(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ agentProfile: "frontmind-base" })
    );
    expect(localStorage.removeItem).toHaveBeenCalledWith(
      LEGACY_CONFIG_STORAGE_KEY,
    );
  });
});
