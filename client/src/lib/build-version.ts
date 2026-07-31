declare const __FRONTMIND_BUILD_VERSION__: string;

export type FrontMindBuildInfo = {
  version: string;
  gitSha?: string;
  builtAt?: string;
  copyRevision?: string;
};

const initialVersion = __FRONTMIND_BUILD_VERSION__;
const PENDING_BUILD_DRAFT_KEY = "frontmind.pending-build-draft";
let reloadStarted = false;

export async function checkFrontMindBuildVersion(options?: {
  reloadOnMismatch?: boolean;
  pendingDraft?: string;
}) {
  try {
    const response = await fetch(
      `/__frontmind__/version.json?_t=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!response.ok) return true;
    const data = (await response.json()) as Partial<FrontMindBuildInfo>;
    const version = typeof data.version === "string" ? data.version : null;
    if (!version || version === initialVersion) return true;
    if (options?.reloadOnMismatch !== false && !reloadStarted) {
      const pendingDraft = options?.pendingDraft;
      if (pendingDraft?.trim()) {
        sessionStorage.setItem(
          PENDING_BUILD_DRAFT_KEY,
          JSON.stringify({
            text: pendingDraft,
            savedAt: Date.now(),
          }),
        );
      }
      reloadStarted = true;
      console.info(
        `[VersionCheck] New version detected: ${version} (was ${initialVersion}). Reloading...`,
      );
      window.location.reload();
    }
    return false;
  } catch {
    return true;
  }
}

export function consumePendingFrontMindBuildDraft() {
  try {
    const raw = sessionStorage.getItem(PENDING_BUILD_DRAFT_KEY);
    sessionStorage.removeItem(PENDING_BUILD_DRAFT_KEY);
    if (!raw) return "";
    const value = JSON.parse(raw) as { text?: unknown; savedAt?: unknown };
    if (
      typeof value.text !== "string" ||
      typeof value.savedAt !== "number" ||
      Date.now() - value.savedAt > 30 * 60 * 1000
    ) {
      return "";
    }
    return value.text;
  } catch {
    return "";
  }
}

export async function requireCurrentFrontMindBuild(pendingDraft?: string) {
  return checkFrontMindBuildVersion({
    reloadOnMismatch: true,
    pendingDraft,
  });
}
