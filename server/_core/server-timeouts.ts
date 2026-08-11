import type { Server } from "node:http";

export const SERVER_HEADERS_TIMEOUT_MS = 60_000;
export const SERVER_REQUEST_TIMEOUT_MS = 21 * 60_000;
export const SERVER_SOCKET_TIMEOUT_MS = 25 * 60_000;
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 5_000;

/** Explicit limits prevent Node defaults from cutting off managed ingress. */
export function configureServerTimeouts(
  server: Pick<
    Server,
    "headersTimeout" | "requestTimeout" | "timeout" | "keepAliveTimeout"
  >,
) {
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.timeout = SERVER_SOCKET_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
}
