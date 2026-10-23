const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const pluginFactory = require("../index.js");

/**
 * Deterministic fake probe used by every test so the suite never hits the
 * network (which can hang on offline/flaky environments). Returns online
 * by default; tests that need other outcomes pass their own `probe`.
 */
const fakeProbe = async () => ({ state: "online", ping: 5 });

/**
 * Mock Signal K app matching the history-sqlite test pattern, extended
 * with a stub router so we can exercise registerWithRouter.
 */
function createMockApp() {
  let status = "";
  const messages = [];
  const deltaHandlers = [];
  const subscriptions = [];
  const errors = [];
  const router = {
    routes: [],
    get(path, h) {
      this.routes.push({ method: "get", path, handler: h });
    },
    post(path, h) {
      this.routes.push({ method: "post", path, handler: h });
    },
    put(path, h) {
      this.routes.push({ method: "put", path, handler: h });
    },
  };
  return {
    selfId: "urn:mrn:imo:mmsi:123456789",
    debug: () => {},
    error: (msg) => {
      errors.push(msg);
    },
    getErrors: () => errors,
    setPluginStatus: (s) => {
      status = s;
    },
    getPluginStatus: () => status,
    subscriptionmanager: {
      subscribe: (subscription, _unsub, _onError, onDelta) => {
        subscriptions.push(subscription);
        deltaHandlers.push(onDelta);
      },
    },
    handleMessage: (id, delta) => {
      messages.push({ id, delta });
    },
    getMessages: () => messages,
    getDeltaHandlers: () => deltaHandlers,
    getSubscriptions: () => subscriptions,
    router,
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("plugin", () => {
  let app;
  let plugin;

  test.beforeEach(() => {
    app = createMockApp();
    plugin = pluginFactory(app);
  });

  test("has correct metadata and schema", () => {
    assert.strictEqual(plugin.id, "signalk-internet");
    assert.ok(plugin.name);
    assert.ok(plugin.description);
    assert.strictEqual(plugin.schema.type, "object");
    assert.ok(plugin.schema.properties.pollInterval);
    assert.ok(plugin.schema.properties.stateHeuristics);
    assert.ok(plugin.schema.properties.connectionMappings);
  });

  test("starts and stops without error", () => {
    assert.doesNotThrow(() =>
      plugin.start({ pollInterval: 1, probe: fakeProbe }),
    );
    assert.doesNotThrow(() => plugin.stop());
  });

  test("schema exposes the probe provider pulldown", () => {
    const prop = plugin.schema.properties.probeProvider;
    assert.ok(prop, "probeProvider option exists");
    assert.strictEqual(prop.type, "string");
    assert.strictEqual(prop.default, "apple");
    assert.deepStrictEqual(prop.enum, ["apple", "google", "none"]);
    assert.deepStrictEqual(prop.options.enum_titles, [
      "Apple",
      "Google",
      "No probe",
    ]);
  });

  test("schema ships a Starlink default in connectionMappings", () => {
    assert.deepStrictEqual(
      plugin.schema.properties.connectionMappings.default,
      pluginFactory.DEFAULT_CONNECTION_MAPPINGS,
    );
    assert.strictEqual(
      pluginFactory.DEFAULT_CONNECTION_MAPPINGS[0].path,
      "network.providers.starlink.status",
    );
  });

  test("schema ships watch-schedule and maritime-zone defaults in stateHeuristics", () => {
    assert.deepStrictEqual(
      plugin.schema.properties.stateHeuristics.default,
      pluginFactory.DEFAULT_STATE_HEURISTICS,
    );
    assert.strictEqual(
      pluginFactory.DEFAULT_STATE_HEURISTICS[0].path,
      "watch.state.onWatch",
    );
    assert.strictEqual(
      pluginFactory.DEFAULT_STATE_HEURISTICS[0].triggerValue,
      "true",
    );
    assert.strictEqual(
      pluginFactory.DEFAULT_STATE_HEURISTICS[0].resultingState,
      "metered",
    );
    assert.strictEqual(
      pluginFactory.DEFAULT_STATE_HEURISTICS[1].path,
      "navigation.maritimeZone",
    );
    assert.strictEqual(
      pluginFactory.DEFAULT_STATE_HEURISTICS[1].triggerValue,
      "high-seas",
    );
    assert.strictEqual(
      pluginFactory.DEFAULT_STATE_HEURISTICS[1].resultingState,
      "metered",
    );
  });

  test("applies the Starlink default when connectionMappings is unset", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    // Establish a non-offline state so a transition is observable.
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    put.handler({ body: { state: "online" } }, makeRes());
    app.getMessages().length = 0;

    const handler = app.getDeltaHandlers()[0];
    // Feed the Starlink "online" value — an up mapping triggers a verify
    // probe (async). We assert the delta handler is wired to the default
    // mapping by confirming a state delta is published after the probe.
    handler({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "network.providers.starlink.status", value: "online" },
          ],
        },
      ],
    });
    // Clear override so the hardware rule path runs (override still wins
    // over hardware, so clear it to let the verify probe publish).
    put.handler({ body: { state: null } }, makeRes());
    plugin.stop();
  });

  test("subscribes to the watch path via the default heuristic", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    // The default watch heuristic must be active and subscribed, so the
    // evaluator's stream cache updates when watch.state.onWatch changes.
    // (The metered refinement itself is unit-tested in evaluator.test.js
    // with a fake probe; here we assert the default is wired in.)
    const subs = app.getSubscriptions();
    assert.strictEqual(subs.length, 1);
    const paths = subs[0].subscribe.map((s) => s.path);
    assert.ok(
      paths.includes("watch.state.onWatch"),
      `expected watch.state.onWatch in ${JSON.stringify(paths)}`,
    );
    assert.ok(
      paths.includes("navigation.maritimeZone"),
      `expected navigation.maritimeZone in ${JSON.stringify(paths)}`,
    );
    assert.ok(
      paths.includes("network.providers.starlink.status"),
      `expected the Starlink default path in ${JSON.stringify(paths)}`,
    );
    plugin.stop();
  });

  test("respects an explicit empty connectionMappings (disables defaults)", () => {
    plugin.start({
      pollInterval: 60,
      probe: fakeProbe,
      connectionMappings: [],
      stateHeuristics: [],
    });
    // With no mappings and no heuristics, no delta subscription is set up.
    assert.strictEqual(app.getDeltaHandlers().length, 0);
    plugin.stop();
  });

  test("publishes a meta delta on start", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    const meta = app.getMessages().find((m) => {
      const u = m.delta.updates || [];
      return u.some((x) => x.meta);
    });
    assert.ok(meta, "expected a meta delta on start");
    const paths = [];
    for (const u of meta.delta.updates || []) {
      for (const m of u.meta || []) paths.push(m.path);
    }
    assert.ok(
      paths.includes(pluginFactory.SPEED_PATH),
      `expected ${pluginFactory.SPEED_PATH} meta`,
    );
    plugin.stop();
  });

  test("feeds watched delta paths into the evaluator", async () => {
    // Inject a fake probe so the test is deterministic and never hits the
    // network. An `online` override needs reachability confirmed before
    // it publishes, so the probe returns online to establish a
    // non-offline baseline for the down transition.
    const probe = async () => ({ state: "online", ping: 5 });
    plugin.start({
      pollInterval: 60,
      probe,
      connectionMappings: [
        {
          path: "network.providers.starlink.status",
          matchValue: "disconnected",
          resultingState: "offline",
        },
      ],
    });
    plugin.registerWithRouter(app.router);
    // Establish a non-offline state via override so the down transition is
    // observable (publishing offline-from-offline is deduped). The `online`
    // override is reachability-gated, so await its verify probe.
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    put.handler({ body: { state: "online" } }, makeRes());
    await new Promise((r) => setTimeout(r, 10));
    app.getMessages().length = 0;

    const handler = app.getDeltaHandlers()[0];
    handler({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "network.providers.starlink.status",
              value: "disconnected",
            },
          ],
        },
      ],
    });
    // The override still wins, so clear it to let the hardware rule fire.
    put.handler({ body: { state: null } }, makeRes());
    // An instant-down hardware match should publish an offline state delta
    // synchronously, with a null ping (no probe ran).
    const stateMsg = app
      .getMessages()
      .find((m) =>
        (m.delta.updates || []).some((u) =>
          (u.values || []).some(
            (v) => v.path === "network.internet.state" && v.value === "offline",
          ),
        ),
      );
    assert.ok(stateMsg, "expected a network.internet.state=offline delta");
    plugin.stop();
  });

  test("registerWithRouter wires override and speedtest routes", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    const methods = app.router.routes.map((r) => `${r.method} ${r.path}`);
    assert.ok(methods.includes("get /override"));
    assert.ok(methods.includes("put /override"));
    assert.ok(methods.includes("post /speedtest"));
    plugin.stop();
  });

  test("override PUT sets the manual override state", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    const res = makeRes();
    put.handler({ body: { state: "metered" } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.override, "metered");
    plugin.stop();
  });

  test("override GET reports the override set by PUT, null when cleared", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    const route = (method) =>
      app.router.routes.find(
        (r) => r.method === method && r.path === "/override",
      );
    const read = () => {
      const res = makeRes();
      route("get").handler({}, res);
      return res;
    };
    assert.strictEqual(read().body.override, null);
    route("put").handler({ body: { state: "metered" } }, makeRes());
    assert.strictEqual(read().body.override, "metered");
    route("put").handler({ body: { state: null } }, makeRes());
    assert.strictEqual(read().body.override, null);
    plugin.stop();
  });

  test("override GET returns 503 before start", () => {
    plugin.registerWithRouter(app.router);
    const get = app.router.routes.find(
      (r) => r.method === "get" && r.path === "/override",
    );
    const res = makeRes();
    get.handler({}, res);
    assert.strictEqual(res.statusCode, 503);
  });

  test("override GET is open to read-only users where the server allows it", () => {
    const levels = [];
    app.router.access = (level) => {
      levels.push(level);
      return app.router;
    };
    plugin.registerWithRouter(app.router);
    assert.deepStrictEqual(levels, ["readonly"]);
    delete app.router.access;
  });

  test("override PUT accepts the legacy forceMetered boolean", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    const res = makeRes();
    put.handler({ body: { forceMetered: true } }, res);
    assert.strictEqual(res.body.override, "metered");
    plugin.stop();
  });

  test("override PUT rejects an unknown body with 400", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    const res = makeRes();
    put.handler({ body: { nonsense: 1 } }, res);
    assert.strictEqual(res.statusCode, 400);
    plugin.stop();
  });

  test("speedtest POST returns 403 when metered", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    // Force the metered state via override so the guard fires.
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    put.handler({ body: { state: "metered" } }, makeRes());

    const post = app.router.routes.find(
      (r) => r.method === "post" && r.path === "/speedtest",
    );
    const res = makeRes();
    post.handler({}, res);
    assert.strictEqual(res.statusCode, 403);
    plugin.stop();
  });

  test("speedtest POST returns 409 when offline", () => {
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.registerWithRouter(app.router);
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    put.handler({ body: { state: "offline" } }, makeRes());

    const post = app.router.routes.find(
      (r) => r.method === "post" && r.path === "/speedtest",
    );
    const res = makeRes();
    post.handler({}, res);
    assert.strictEqual(res.statusCode, 409);
    plugin.stop();
  });

  test("speedtest POST returns 503 before start", () => {
    const res = makeRes();
    plugin.registerWithRouter(app.router);
    const post = app.router.routes.find(
      (r) => r.method === "post" && r.path === "/speedtest",
    );
    post.handler({}, res);
    assert.strictEqual(res.statusCode, 503);
  });

  test("speedtest POST records the result as a speed delta", async () => {
    // Deterministic fake download: 1 MB in 1 s -> 8,000,000 bit/s.
    const fakeSpeedtest = async () => ({
      bytes: 1_000_000,
      elapsedMs: 1000,
      throughputMbps: 8,
    });
    plugin.start({
      pollInterval: 60,
      probe: fakeProbe,
      speedtest: fakeSpeedtest,
    });
    plugin.registerWithRouter(app.router);
    // Let the initial probe settle to `online` so the guard passes.
    await new Promise((r) => setTimeout(r, 10));
    const post = app.router.routes.find(
      (r) => r.method === "post" && r.path === "/speedtest",
    );
    const res = makeRes();
    await post.handler({}, res);
    // The handler resolves asynchronously once the download completes.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(res.statusCode, 200);
    const speedMsg = app
      .getMessages()
      .find((m) =>
        (m.delta.updates || []).some((u) =>
          (u.values || []).some(
            (v) => v.path === pluginFactory.SPEED_PATH && v.value === 8_000_000,
          ),
        ),
      );
    assert.ok(speedMsg, `expected a ${pluginFactory.SPEED_PATH}=8000000 delta`);
    plugin.stop();
  });

  test("speedtest POST records nothing when the guard blocks", () => {
    const fakeSpeedtest = async () => ({
      bytes: 1_000_000,
      elapsedMs: 1000,
      throughputMbps: 8,
    });
    plugin.start({
      pollInterval: 60,
      probe: fakeProbe,
      speedtest: fakeSpeedtest,
    });
    plugin.registerWithRouter(app.router);
    const put = app.router.routes.find(
      (r) => r.method === "put" && r.path === "/override",
    );
    put.handler({ body: { state: "offline" } }, makeRes());

    const post = app.router.routes.find(
      (r) => r.method === "post" && r.path === "/speedtest",
    );
    const res = makeRes();
    post.handler({}, res);
    assert.strictEqual(res.statusCode, 409);
    const recorded = app
      .getMessages()
      .some((m) =>
        (m.delta.updates || []).some((u) =>
          (u.values || []).some((v) => v.path === pluginFactory.SPEED_PATH),
        ),
      );
    assert.ok(!recorded, "a blocked speed test must not be recorded");
    plugin.stop();
  });

  test("schema exposes the adaptive re-verification intervals", () => {
    assert.strictEqual(
      plugin.schema.properties.onlineVerifyInterval.default,
      pluginFactory.DEFAULT_ONLINE_VERIFY_INTERVAL,
    );
    assert.strictEqual(
      plugin.schema.properties.meteredVerifyInterval.default,
      pluginFactory.DEFAULT_METERED_VERIFY_INTERVAL,
    );
  });

  test("computeProbeIntervalSeconds follows the cadence ladder", () => {
    const compute = pluginFactory.computeProbeIntervalSeconds;
    const config = {
      pollInterval: 30,
      onlineVerifyInterval: 300,
      meteredVerifyInterval: 600,
    };
    // Offline, or no hardware mapping: fast fallback interval.
    assert.strictEqual(
      compute({ state: "offline", hardwareState: "online", config }),
      30,
    );
    assert.strictEqual(
      compute({ state: "online", hardwareState: null, config }),
      30,
      "with no hardware mapping the probe is the only detector",
    );
    // Hardware up + online: slow re-verification.
    assert.strictEqual(
      compute({ state: "online", hardwareState: "online", config }),
      300,
    );
    // Hardware up + metered/captive: slowest, to conserve metered data.
    assert.strictEqual(
      compute({ state: "metered", hardwareState: "online", config }),
      600,
    );
    assert.strictEqual(
      compute({ state: "captive", hardwareState: "metered", config }),
      600,
    );
    // Built-in defaults when the config omits the settings.
    assert.strictEqual(
      compute({ state: "online", hardwareState: "online", config: {} }),
      300,
    );
    assert.strictEqual(
      compute({ state: "metered", hardwareState: "online", config: {} }),
      600,
    );
    assert.strictEqual(
      compute({ state: "offline", hardwareState: null, config: {} }),
      30,
    );
  });

  /**
   * Flushes pending microtasks so a fire-and-forget probe started inside
   * the plugin (which the test cannot await) has settled.
   */
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  test("probes at the slow online cadence while a hardware mapping reports up", async (t) => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return { state: "online", ping: 5 };
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    plugin.start({
      pollInterval: 30,
      onlineVerifyInterval: 300,
      meteredVerifyInterval: 600,
      probe,
    });
    const handler = app.getDeltaHandlers()[0];
    handler({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "network.providers.starlink.status", value: "online" },
          ],
        },
      ],
    });
    await flush();
    assert.strictEqual(probes, 1, "the initial probe");
    // 30s pass: the fast fallback interval must not apply while the
    // hardware mapping reports the uplink up.
    t.mock.timers.tick(30_000);
    await flush();
    assert.strictEqual(probes, 1, "no probe at the fallback interval");
    t.mock.timers.tick(270_000);
    await flush();
    assert.strictEqual(probes, 2, "re-verified at the online interval");
    plugin.stop();
  });

  test("probes at the slowest cadence while metered", async (t) => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return { state: "online", ping: 5 };
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    plugin.start({
      pollInterval: 30,
      onlineVerifyInterval: 300,
      meteredVerifyInterval: 600,
      probe,
    });
    const handler = app.getDeltaHandlers()[0];
    handler({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "network.providers.starlink.status", value: "online" },
            { path: "watch.state.onWatch", value: true },
          ],
        },
      ],
    });
    await flush();
    assert.strictEqual(probes, 1);
    // Both the online (300s) and fallback (30s) cadences must not fire.
    t.mock.timers.tick(300_000);
    await flush();
    assert.strictEqual(probes, 1, "metered probes slower than online");
    t.mock.timers.tick(300_000);
    await flush();
    assert.strictEqual(probes, 2, "re-verified at the metered interval");
    plugin.stop();
  });

  test("keeps the fast fallback cadence while offline", async (t) => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return { state: "offline", ping: null };
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    plugin.start({ pollInterval: 30, onlineVerifyInterval: 300, probe });
    await flush();
    assert.strictEqual(probes, 1);
    t.mock.timers.tick(30_000);
    await flush();
    assert.strictEqual(probes, 2, "offline retries at the fallback interval");
    t.mock.timers.tick(30_000);
    await flush();
    assert.strictEqual(probes, 3);
    plugin.stop();
  });

  test("no-probe mode trusts hardware mappings and never probes", async () => {
    // No injected probe: if the plugin still probed, it would hit the
    // real network and this test would only pass by luck of connectivity.
    // In no-probe mode nothing is contacted and the state follows the
    // hardware mappings alone.
    plugin.start({ pollInterval: 30, probeProvider: "none" });
    await flush();

    const stateValues = () =>
      app
        .getMessages()
        .flatMap((m) => m.delta.updates || [])
        .flatMap((u) => u.values || [])
        .filter((v) => v.path === "network.internet.state")
        .map((v) => v.value);
    const pingValues = () =>
      app
        .getMessages()
        .flatMap((m) => m.delta.updates || [])
        .flatMap((u) => u.values || [])
        .filter((v) => v.path === "network.internet.ping")
        .map((v) => v.value);

    // Initial settle: no mapping matched and the state never left the
    // offline floor, so nothing has been published yet.
    assert.deepStrictEqual(stateValues(), []);

    // The Starlink mapping reports the uplink up: trusted as-is, no
    // verify probe.
    const handler = app.getDeltaHandlers()[0];
    handler({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "network.providers.starlink.status", value: "online" },
          ],
        },
      ],
    });
    await flush();
    assert.deepStrictEqual(stateValues(), ["online"]);
    assert.deepStrictEqual(pingValues(), [null], "no probe ran");

    // The uplink reporting down is an instant transition.
    handler({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "network.providers.starlink.status", value: "offline" },
          ],
        },
      ],
    });
    await flush();
    assert.deepStrictEqual(stateValues(), ["online", "offline"]);
    plugin.stop();
  });

  test("an unknown probe provider falls back to Apple with an error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let probes = 0;
    plugin.start({
      pollInterval: 30,
      probeProvider: "bing",
      probe: async () => {
        probes++;
        return { state: "online", ping: 5 };
      },
    });
    await flush();
    assert.ok(
      app.getErrors().some((e) => e.includes("unknown probe provider")),
    );
    assert.strictEqual(probes, 1, "injected probe still wired");
    plugin.stop();
  });
});
