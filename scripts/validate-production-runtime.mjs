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
  FRONTMIND_ICP_MATERIAL_DIR: "/var/lib/frontmind/icp-materials",
  FRONTMIND_ICP_RETENTION_DAYS: "365",
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
  "FRONTMIND_ICP_MATERIAL_KEY",
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
  for (const [name, expected] of Object.entries(exactValues)) {
    if (process.env[name] !== expected) fail(`${name}_VALUE_INVALID`);
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
  decodeBase64Key("FRONTMIND_ICP_MATERIAL_KEY");

  for (const name of secretNames.slice(2)) {
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
