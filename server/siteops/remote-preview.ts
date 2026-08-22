import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import sharp from "sharp";

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 20_000_000;
const MAX_REDIRECTS = 3;
const ALLOWED_MIME_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Keep the address families in separate lists. Node intentionally maps IPv4
// through IPv4-mapped IPv6 entries when both families share one BlockList;
// that would make an IPv6 `::/96` deny rule reject every public IPv4 address.
const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicPreviewAddress(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const family = isIP(normalized);
  if (family === 4) return !blockedIpv4Addresses.check(normalized, "ipv4");
  if (family === 6) return !blockedIpv6Addresses.check(normalized, "ipv6");
  return false;
}

export type ResolvedPublicHttpsAddress = { address: string; family: 4 | 6 };
export type PinnedPublicHttpsTransport = (input: {
  url: URL;
  addresses: ResolvedPublicHttpsAddress[];
  signal: AbortSignal;
  headers: Record<string, string>;
}) => Promise<Response>;

async function assertSafeUrl(
  raw: string,
  resolveImpl: typeof lookup = lookup,
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PREVIEW_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("PREVIEW_URL_UNSAFE");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error("PREVIEW_URL_UNSAFE");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : ((await resolveImpl(hostname, {
        all: true,
        verbatim: true,
      })) as ResolvedPublicHttpsAddress[]);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicPreviewAddress(address))
  ) {
    throw new Error("PREVIEW_URL_PRIVATE_ADDRESS");
  }
  return { url, addresses };
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (typeof value === "string") {
      result.set(name, value);
    }
  }
  return result;
}

async function pinnedHttpsFetch(input: {
  url: URL;
  addresses: ResolvedPublicHttpsAddress[];
  signal: AbortSignal;
  headers: Record<string, string>;
}) {
  // Choosing one address and returning it from the TLS socket's lookup hook
  // closes the DNS-rebinding window between validation and connection.
  const selected = input.addresses[0]!;
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(
      input.url,
      {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
        servername: input.url.hostname,
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
      },
      (incoming) => {
        const peer = incoming.socket.remoteAddress;
        if (!peer || !isPublicPreviewAddress(peer)) {
          incoming.destroy(new Error("PREVIEW_CONNECTED_ADDRESS_UNSAFE"));
          return;
        }
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders(incoming.headers),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/**
 * Resolves and pins every HTTPS hop, then verifies the socket's actual peer
 * before exposing a response. `transport` exists only for deterministic
 * tests; production callers use the pinned Node HTTPS implementation.
 */
export async function fetchPinnedPublicHttps(input: {
  url: string | URL;
  signal: AbortSignal;
  headers?: Record<string, string>;
  maxRedirects?: number;
  allowedOrigin?: string;
  resolveImpl?: typeof lookup;
  transport?: PinnedPublicHttpsTransport;
}) {
  const maxRedirects = Math.max(
    0,
    Math.min(input.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS),
  );
  const initialUrl =
    typeof input.url === "string" ? input.url : input.url.toString();
  let resolved = await assertSafeUrl(initialUrl, input.resolveImpl);
  let allowedOrigin: string | null = null;
  if (input.allowedOrigin) {
    const parsed = await assertSafeUrl(input.allowedOrigin, input.resolveImpl);
    allowedOrigin = parsed.url.origin;
    if (resolved.url.origin !== allowedOrigin) {
      throw new Error("PREVIEW_REDIRECT_ORIGIN_INVALID");
    }
  }
  const transport = input.transport ?? pinnedHttpsFetch;
  for (let redirects = 0; ; redirects += 1) {
    const response = await transport({
      url: resolved.url,
      addresses: resolved.addresses,
      signal: input.signal,
      headers: input.headers ?? {},
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: resolved.url };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects >= maxRedirects) {
      throw new Error("PREVIEW_REDIRECT_INVALID");
    }
    const next = await assertSafeUrl(
      new URL(location, resolved.url).toString(),
      input.resolveImpl,
    );
    if (allowedOrigin && next.url.origin !== allowedOrigin) {
      throw new Error("PREVIEW_REDIRECT_ORIGIN_INVALID");
    }
    resolved = next;
  }
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) throw new Error("PREVIEW_BODY_MISSING");
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared <= 0 || declared > maxBytes)) {
    throw new Error("PREVIEW_SIZE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error("PREVIEW_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (bytes < 1) throw new Error("PREVIEW_BODY_MISSING");
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
}

export async function fetchSafeVisualPreview(input: {
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveImpl?: typeof lookup;
}) {
  const timeout = AbortSignal.timeout(12_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  const headers = {
    Accept: "image/avif,image/webp,image/png,image/jpeg",
    "User-Agent": "FrontMind-SiteOps-Preview/1.0",
  };
  const fetched = await fetchPinnedPublicHttps({
    url: input.url,
    signal,
    headers,
    maxRedirects: MAX_REDIRECTS,
    resolveImpl: input.resolveImpl,
    transport: input.fetchImpl
      ? ({ url }) =>
          input.fetchImpl!(url, {
            method: "GET",
            redirect: "manual",
            signal,
            headers,
          })
      : undefined,
  });
  const { response } = fetched;
  if (!response.ok) throw new Error("PREVIEW_FETCH_FAILED");
  const mimeType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error("PREVIEW_MIME_INVALID");
  }
  const buffer = await readBoundedBody(response, MAX_PREVIEW_BYTES);
  const image = sharp(buffer, {
    failOn: "error",
    limitInputPixels: MAX_PREVIEW_PIXELS,
  });
  const metadata = await image.metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_PREVIEW_PIXELS ||
    !["avif", "jpeg", "png", "webp"].includes(metadata.format || "")
  ) {
    throw new Error("PREVIEW_IMAGE_INVALID");
  }
  // Re-encoding removes EXIF/text/profile metadata and makes the immutable
  // artifact hash independent from provider-side metadata changes.
  const normalizedBuffer = await image
    .clone()
    .rotate()
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  if (normalizedBuffer.byteLength > MAX_PREVIEW_BYTES) {
    throw new Error("PREVIEW_TOO_LARGE");
  }
  const normalizedImage = sharp(normalizedBuffer, {
    failOn: "error",
    limitInputPixels: MAX_PREVIEW_PIXELS,
  });
  const [normalizedMetadata, stats] = await Promise.all([
    normalizedImage.metadata(),
    normalizedImage.stats(),
  ]);
  if (!normalizedMetadata.width || !normalizedMetadata.height) {
    throw new Error("PREVIEW_IMAGE_INVALID");
  }
  const visibleChannels = stats.channels.slice(0, 3);
  const brightness =
    visibleChannels.reduce((sum, channel) => sum + channel.mean, 0) /
    Math.max(1, visibleChannels.length);
  const contrast =
    visibleChannels.reduce((sum, channel) => sum + channel.stdev, 0) /
    Math.max(1, visibleChannels.length);
  const dominantHex = `#${[stats.dominant.r, stats.dominant.g, stats.dominant.b]
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")}`;
  return {
    finalUrl: fetched.finalUrl.toString(),
    mimeType: "image/png" as const,
    buffer: normalizedBuffer,
    width: normalizedMetadata.width,
    height: normalizedMetadata.height,
    sha256: createHash("sha256").update(normalizedBuffer).digest("hex"),
    visualSignals: {
      dominantHex,
      brightness: Math.round(brightness * 100) / 100,
      contrast: Math.round(contrast * 100) / 100,
    },
  };
}
