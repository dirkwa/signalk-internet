const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
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
} = require("../lib/prober.js");

/**
 * Starts a local HTTP server for the handler's lifetime, then hands the
 * base URL to the callback. Used to exercise the HTTP semantics (status
 * codes, redirects) without touching the network.
 *
 * @param {Function} handler - node:http request handler
 * @param {Function} fn - Receives the base URL
 */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("prober", () => {
  test("returns offline when DNS resolution fails", async () => {
    const result = await probe({
      provider: {
        dnsHost: "definitely-not-a-real-host.invalid",
        url: "https://invalid.localhost.invalid/x",
        verify: "body",
      },
      timeoutMs: 1000,
    });
    assert.strictEqual(result.state, "offline");
    assert.strictEqual(result.ping, null);
  });

  test("probeWithRetry returns offline on persistent DNS failure", async () => {
    const result = await probeWithRetry({
      provider: {
        dnsHost: "definitely-not-a-real-host.invalid",
        url: "https://invalid.localhost.invalid/x",
        verify: "body",
      },
      timeoutMs: 500,
    });
    assert.strictEqual(result.state, "offline");
  });

  test("shipped providers point at the expected endpoints", () => {
    assert.strictEqual(DEFAULT_PROBE_PROVIDER, "apple");
    assert.strictEqual(DEFAULT_DNS_HOST, "captive.apple.com");
    assert.strictEqual(
      DEFAULT_CAPTIVE_URL,
      "https://captive.apple.com/hotspot-detect.html",
    );
    assert.strictEqual(GOOGLE_DNS_HOST, "connectivitycheck.gstatic.com");
    assert.strictEqual(
      GOOGLE_CAPTIVE_URL,
      "http://connectivitycheck.gstatic.com/generate_204",
    );
    assert.strictEqual(PROVIDERS.apple.verify, "body");
    assert.strictEqual(PROVIDERS.google.verify, "status");
    assert.ok(SUCCESS_MARKER.length > 0);
  });

  test("status verification: 204 is online", () => {
    assert.deepStrictEqual(interpret(PROVIDERS.google, 204, ""), {
      state: "online",
    });
  });

  test("status verification: a redirect means a captive portal", () => {
    // Captive portals answer generate_204 with a 302 to their login
    // page; redirects are never followed.
    assert.deepStrictEqual(interpret(PROVIDERS.google, 302, ""), {
      state: "captive",
    });
  });

  test("status verification: any other status is captive too", () => {
    assert.deepStrictEqual(interpret(PROVIDERS.google, 200, "hello"), {
      state: "captive",
    });
  });

  test("body verification: the success marker is online", () => {
    assert.deepStrictEqual(
      interpret(PROVIDERS.apple, 200, "<HTML><TITLE>Success</TITLE>"),
      { state: "online" },
    );
  });

  test("body verification: unexpected body is captive", () => {
    assert.deepStrictEqual(
      interpret(PROVIDERS.apple, 200, "<HTML>Please log in</HTML>"),
      { state: "captive" },
    );
  });

  test("resolveProvider resolves shipped providers by name", () => {
    assert.strictEqual(resolveProvider("apple"), PROVIDERS.apple);
    assert.strictEqual(resolveProvider("google"), PROVIDERS.google);
    assert.strictEqual(resolveProvider(undefined), PROVIDERS.apple);
  });

  test("resolveProvider accepts explicit provider objects", () => {
    const spec = { url: "http://127.0.0.1/x", verify: "status" };
    assert.strictEqual(resolveProvider(spec), spec);
  });

  test("resolveProvider rejects unknown providers", () => {
    assert.throws(() => resolveProvider("bing"), /Unknown probe provider/);
    assert.throws(() => resolveProvider({ url: 42 }), /Invalid probe provider/);
    assert.throws(() => resolveProvider(null), /Invalid probe provider/);
  });

  test("fetchWithTimeout reports status codes over plain HTTP", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      async (base) => {
        const { statusCode, body, ping } = await fetchWithTimeout(
          `${base}/generate_204`,
          1000,
        );
        assert.strictEqual(statusCode, 204);
        assert.strictEqual(body, "");
        assert.ok(typeof ping === "number");
      },
    );
  });

  test("fetchWithTimeout does not follow redirects", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { Location: "http://portal.example/login" });
        res.end();
      },
      async (base) => {
        const { statusCode } = await fetchWithTimeout(`${base}/x`, 1000);
        assert.strictEqual(statusCode, 302);
      },
    );
  });

  test("fetchWithTimeout uses HTTPS for https URLs", async () => {
    // An https URL to an HTTP-only server must fail the TLS handshake
    // rather than fall back to plaintext (which would silently leak the
    // probe to a captive portal).
    await assert.rejects(
      fetchWithTimeout("https://127.0.0.1:1/x", 1000),
      Error,
    );
  });
});
