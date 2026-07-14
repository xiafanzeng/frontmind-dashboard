export const LEGACY_CONFIG_STORAGE_KEY = "frontmind-client-config";
export const DEVICE_PREFERENCES_STORAGE_KEY = "frontmind-client-preferences";

type LegacyClientConfig = Record<string, unknown> & {
  apiKey?: unknown;
  baseUrl?: unknown;
};

function readLegacyConfig(): LegacyClientConfig | null {
  try {
    const raw = localStorage.getItem(LEGACY_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as LegacyClientConfig)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads the old browser-stored credential only when an explicit migration
 * action needs it. Callers must never render or log the returned value.
 */
export function readLegacyApiKey(): string | null {
  const key = readLegacyConfig()?.apiKey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

export function hasLegacyApiKey(): boolean {
  return Boolean(readLegacyApiKey());
}

/**
 * Removes credential material while preserving non-sensitive device choices,
 * such as the user's preferred public model profile.
 */
export function clearLegacyCredentials(): void {
  const config = readLegacyConfig();
  if (!config) return;

  if (typeof config.agentProfile === "string" && config.agentProfile) {
    localStorage.setItem(
      DEVICE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ agentProfile: config.agentProfile }),
    );
  }
  localStorage.removeItem(LEGACY_CONFIG_STORAGE_KEY);
}
