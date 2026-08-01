const fail = (code) => {
  console.error(code);
  process.exit(1);
};

const exactValues = {
  NODE_ENV: "production",
  PORT: "3001",
  FRONTMIND_PUBLIC_URL: "https://dashboard.frontmind.net",
  FRONTMIND_WEBSITE_URL: "https://www.frontmind.net",
  FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_TTL_SECONDS: "300",
  FRONTMIND_PREPARED_FILE_DIR: "/var/lib/frontmind/prepared-files",
  FRONTMIND_PREPARED_FILE_TTL_MS: "2592000000",
  FRONTMIND_DASHBOARD_ASSET_DIR: "/var/lib/frontmind/dashboard-assets",
  FRONTMIND_PDF_WORKERS: "1",
  FRONTMIND_CONVERSATION_RETENTION_DAYS: "30",
  FRONTMIND_SERVICE_ENTITLEMENT_ENFORCEMENT: "auto",
  FRONTMIND_KB_SKILL_PATH:
    "/app/dist/private-workflows/socratic-kb-builder.skill",
  FRONTMIND_BRAND_QUESTION_SKILL_PATH:
    "/app/dist/private-workflows/brand-question-portfolio.skill",
  FRONTMIND_RESPONSE_LOGIC_SKILL_PATH:
    "/app/dist/private-workflows/response-logic-builder.skill",
};

const secretNames = [
  "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
  "FRONTMIND_PRESALES_SERVICE_TOKEN",
  "FRONTMIND_PROVISIONING_SERVICE_TOKEN",
  "FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET",
  "FRONTMIND_MONITOR_API_KEY",
];

const decodeBase64Key = (name) => {
  const value = process.env[name] || "";
  if (!value.startsWith("base64:")) fail(`${name}_FORMAT_INVALID`);
  const encoded = value.slice("base64:".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail(`${name}_FORMAT_INVALID`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
  ) {
    fail(`${name}_FORMAT_INVALID`);
  }
};

try {
  const approvedReleaseSha = process.env.FRONTMIND_APPROVED_RELEASE_SHA || "";
  if (!/^[a-f0-9]{40}$/u.test(approvedReleaseSha)) {
    fail("FRONTMIND_APPROVED_RELEASE_SHA_VALUE_INVALID");
  }
  const expectedArtifactRoot =
    process.env.FRONTMIND_EXPECTED_ARTIFACT_ROOT_SHA256 || "";
  if (!/^[a-f0-9]{64}$/u.test(expectedArtifactRoot)) {
    fail("FRONTMIND_EXPECTED_ARTIFACT_ROOT_SHA256_VALUE_INVALID");
  }
  const configuredBuildSourceSha = process.env.FRONTMIND_BUILD_SHA || "";
  if (
    configuredBuildSourceSha &&
    (!/^[a-f0-9]{40}$/u.test(configuredBuildSourceSha) ||
      configuredBuildSourceSha === approvedReleaseSha)
  ) {
    fail("FRONTMIND_BUILD_SHA_VALUE_INVALID");
  }

  for (const [name, expected] of Object.entries(exactValues)) {
    if (process.env[name] !== expected) fail(`${name}_VALUE_INVALID`);
  }

  const knowledgeBaseRollout =
    process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT || "";
  if (!/^(?:100|[0-9]{1,2})(?:\.\d{1,2})?$/u.test(knowledgeBaseRollout)) {
    fail("FRONTMIND_KB_V4_ROLLOUT_PERCENT_VALUE_INVALID");
  }
  const rolloutValue = Number(knowledgeBaseRollout);
  if (rolloutValue < 0 || rolloutValue > 100) {
    fail("FRONTMIND_KB_V4_ROLLOUT_PERCENT_VALUE_INVALID");
  }
  const knowledgeBaseAllowlist =
    process.env.FRONTMIND_KB_V4_ALLOW_USER_IDS || "";
  if (
    knowledgeBaseAllowlist &&
    !/^[1-9]\d*(?:,[1-9]\d*)*$/u.test(knowledgeBaseAllowlist)
  ) {
    fail("FRONTMIND_KB_V4_ALLOW_USER_IDS_VALUE_INVALID");
  }
  const knowledgeBaseWritesDisabled =
    process.env.KNOWLEDGE_BASE_WRITES_DISABLED || "";
  if (
    knowledgeBaseWritesDisabled &&
    !/^(?:0|1|false|true|no|yes|off|on)$/iu.test(knowledgeBaseWritesDisabled)
  ) {
    fail("KNOWLEDGE_BASE_WRITES_DISABLED_VALUE_INVALID");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL_MISSING");
  let target;
  try {
    target = new URL(databaseUrl);
  } catch {
    fail("DATABASE_URL_FORMAT_INVALID");
  }
  if (
    target.protocol !== "mysql:" ||
    target.hostname !== "mysql" ||
    (target.port && target.port !== "3306") ||
    decodeURIComponent(target.username) !== "frontmind_dashboard" ||
    target.pathname !== "/frontmind_dashboard" ||
    target.search ||
    target.hash ||
    !target.password
  ) {
    fail("DATABASE_URL_TARGET_INVALID");
  }

  decodeBase64Key("FRONTMIND_CREDENTIAL_ENCRYPTION_KEY");
  for (const name of secretNames.slice(1)) {
    const value = process.env[name] || "";
    if (
      value.length < 32 ||
      /^(?:replace|placeholder|changeme|test|example)/iu.test(value)
    ) {
      fail(`${name}_VALUE_INVALID`);
    }
  }

  const secrets = secretNames.map((name) => process.env[name]);
  if (new Set(secrets).size !== secrets.length) {
    fail("PRODUCTION_SECRETS_NOT_UNIQUE");
  }

  const viteValues = Object.entries(process.env)
    .filter(([name]) => name.startsWith("VITE_"))
    .map(([, value]) => value)
    .filter(Boolean);
  if (viteValues.some((value) => secrets.includes(value))) {
    fail("PRODUCTION_SECRET_EXPOSED_TO_VITE");
  }

  console.log("RUNTIME_ENV_OK");
} catch {
  fail("RUNTIME_ENV_CHECK_FAILED");
}
