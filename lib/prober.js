/**
 * Active internet probing: DNS resolution and HTTP captive-portal
 * detection.
 *
 * Uses only Node.js native modules (`node:dns`, `node:http`,
 * `node:https`, `node:timers/promises`) to keep the plugin dependency-free.
 *
 * A probe resolves a provider-specific hostname and fetches the
 * provider's captive-portal detection endpoint. Two probe providers are
 * shipped:
 *
 *   - `apple`: HTTPS request to captive.apple.com; the connection is
 *     online when the response body contains the expected "Success"
 *     marker.
 *   - `google`: plain HTTP request to connectivitycheck.gstatic.com;
 *     the connection is online when the response status is 204 No
 *     Content. No TLS handshake and no response body, which keeps the
 *     probe cheap on metered uplinks. Redirects are never followed, so
 *     a captive portal's HTTP redirect is detected as `captive` instead
 *     of failing a certificate check.
 *
 * If DNS or the request fails outright the connection is `offline`; if
 * the request succeeds but the answer is not the expected one, the
 * connection is behind a `captive` portal.
 *
 * @file prober.js
 */

const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const { setTimeout: sleep } = require("node:timers/promises");

/**
 * Provider used when the configuration does not name one.
 */
const DEFAULT_PROBE_PROVIDER = "apple";

/**
 * Default hostname to resolve for the Apple provider's DNS check.
 */
const DEFAULT_DNS_HOST = "captive.apple.com";

/**
 * Apple's captive-portal detection URL. Returns a known body when there
 * is unfettered internet access.
 */
const DEFAULT_CAPTIVE_URL = "https://captive.apple.com/hotspot-detect.html";

/**
 * Expected response body fragment indicating an open connection.
 *
 * The Apple captive endpoint returns `<HTML><HEAD><TITLE>Success</TITLE>`
 * when the device can reach the internet directly.
 */
const SUCCESS_MARKER = "Success";

/**
 * Hostname resolved for the Google provider's DNS check.
 */
const GOOGLE_DNS_HOST = "connectivitycheck.gstatic.com";

/**
 * Google's connectivity check URL. Returns HTTP 204 when the device can
 * reach the internet directly.
 */
const GOOGLE_CAPTIVE_URL = "http://connectivitycheck.gstatic.com/generate_204";

/**
 * Shipped probe providers. `verify` selects how success is decided:
 * `"body"` matches the Apple success marker in the response body,
 * `"status"` requires an HTTP 204 (Google generate_204 style).
 */
const PROVIDERS = {
  apple: {
    dnsHost: DEFAULT_DNS_HOST,
    url: DEFAULT_CAPTIVE_URL,
    verify: "body",
  },
  google: {
    dnsHost: GOOGLE_DNS_HOST,
    url: GOOGLE_CAPTIVE_URL,
    verify: "status",
  },
};

/**
 * Per-request timeout in milliseconds.
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Result of a probe.
 *
 * @typedef {Object} ProbeResult
 * @property {"online"|"offline"|"captive"} state - Resolved connectivity
 * @property {number|null} ping - Round-trip latency in ms, or null on failure
 */

/**
 * Resolves a probe provider spec. A string names a shipped provider; an
 * object is used as-is (tests inject local endpoints this way).
 *
 * @param {string|{dnsHost?: string, url: string, verify: "body"|"status"}}
 *   [provider] - Provider name or explicit spec
 * @returns {{dnsHost?: string, url: string, verify: "body"|"status"}}
 * @throws {Error} on an unknown provider name or malformed spec
 */
function resolveProvider(provider = DEFAULT_PROBE_PROVIDER) {
  if (typeof provider === "string") {
    const known = PROVIDERS[provider];
    if (!known) {
      throw new Error(`Unknown probe provider: ${provider}`);
    }
    return known;
  }
  if (
    provider &&
    typeof provider === "object" &&
    typeof provider.url === "string" &&
    (provider.verify === "body" || provider.verify === "status")
  ) {
    return provider;
  }
  throw new Error(`Invalid probe provider: ${provider}`);
}

/**
 * Decides the connectivity state from a probe response.
 *
 * `status` verification (Google generate_204): 204 is online. A 3xx
 * redirect means a captive portal is intercepting (redirects are never
 * followed), and any other unexpected status is treated as captive too —
 * the endpoint answered, but not the way an open internet would.
 *
 * `body` verification (Apple hotspot-detect): the expected marker in the
 * body is online, anything else captive.
 *
 * @param {{verify: "body"|"status"}} spec - Resolved provider spec
 * @param {number|undefined} statusCode - HTTP status of the response
 * @param {string} body - Response body
 * @returns {{state: "online"|"captive"}}
 */
function interpret(spec, statusCode, body) {
  if (spec.verify === "status") {
    if (statusCode === 204) {
      return { state: "online" };
    }
    return { state: "captive" };
  }
  if (typeof body === "string" && body.includes(SUCCESS_MARKER)) {
    return { state: "online" };
  }
  return { state: "captive" };
}

/**
 * Fetches a URL with a hard timeout, returning the status code, the
 * body string, and the round-trip time in milliseconds. Plain HTTP and
 * HTTPS URLs are both supported; redirects are never followed so a
 * captive portal's redirect surfaces as a status code.
 *
 * @param {string} url - URL to fetch
 * @param {number} [timeoutMs=REQUEST_TIMEOUT_MS] - Timeout in ms
 * @returns {Promise<{body: string, statusCode: number|undefined, ping: number}>}
 * @throws {Error} on network failure or timeout
 */
function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      // A captive portal often answers 200/302 with the wrong content;
      // we consume the response regardless of status and let the caller
      // inspect both.
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ body, statusCode: res.statusCode, ping: Date.now() - start });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
  });
}

/**
 * Runs a single internet probe: DNS lookup + captive-portal check.
 *
 * @param {Object} [options]
 * @param {string|{dnsHost?: string, url: string, verify: "body"|"status"}}
 *   [options.provider] - Provider name or explicit spec
 * @param {number} [options.timeoutMs=REQUEST_TIMEOUT_MS] - Per-step timeout
 * @returns {Promise<ProbeResult>}
 */
async function probe({ provider, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const spec = resolveProvider(provider);
  const dnsHost = spec.dnsHost ?? new URL(spec.url).hostname;

  // DNS resolution: failure means offline.
  try {
    await dns.resolve4(dnsHost);
  } catch (_err) {
    return { state: "offline", ping: null };
  }

  // Connectivity check with the same hard timeout.
  try {
    const { body, statusCode, ping } = await fetchWithTimeout(
      spec.url,
      timeoutMs,
    );
    return { ...interpret(spec, statusCode, body), ping };
  } catch (_err) {
    return { state: "offline", ping: null };
  }
}

/**
 * Runs a probe with a short retry backoff. Two attempts back-to-back reduce
 * false negatives from transient DNS hiccups on flaky uplinks.
 *
 * @param {Object} [options] - Same as {@link probe}
 * @returns {Promise<ProbeResult>}
 */
async function probeWithRetry(options) {
  const first = await probe(options);
  if (first.state !== "offline") {
    return first;
  }
  await sleep(1000);
  return probe(options);
}

module.exports = {
  probe,
  probeWithRetry,
  fetchWithTimeout,
  interpret,
  resolveProvider,
  PROVIDERS,
  DEFAULT_PROBE_PROVIDER,
  DEFAULT_DNS_HOST,
  DEFAULT_CAPTIVE_URL,
  GOOGLE_DNS_HOST,
  GOOGLE_CAPTIVE_URL,
  SUCCESS_MARKER,
  REQUEST_TIMEOUT_MS,
};
