/**
 * Signal K Internet Connectivity Monitor plugin.
 *
 * Centralizes internet-state detection so downstream plugins can pause
 * heavy operations when the vessel goes offline or hits a metered link.
 * Publishes a unified `network.internet.state` + `network.internet.ping`
 * delta via a top-down rules engine: manual override → contextual
 * heuristics → hardware uplink mappings → active DNS/HTTP probing.
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const pkg = require("./package.json");

const { createEvaluator } = require("./lib/evaluator.js");
const {
  probeWithRetry,
  DEFAULT_PROBE_PROVIDER,
  PROVIDERS,
} = require("./lib/prober.js");
const { guard, runSpeedTest, GuardError } = require("./lib/speedtest.js");

/**
 * Signal K paths published by this plugin.
 */
const STATE_PATH = "network.internet.state";
const PING_PATH = "network.internet.ping";
const SPEED_PATH = "network.internet.speed.download";

/**
 * Plugin identifier (matches package name without the scope).
 */
const PLUGIN_ID = "signalk-internet";

/**
 * Default re-verification interval (seconds) while a hardware mapping
 * reports the uplink up and the resolved state is online.
 */
const DEFAULT_ONLINE_VERIFY_INTERVAL = 300;

/**
 * Default re-verification interval (seconds) while the resolved state is
 * `metered` or `captive` — deliberately slower than the online interval
 * to conserve expensive metered data.
 */
const DEFAULT_METERED_VERIFY_INTERVAL = 600;

/**
 * Example Status Tiles set shipped for one-tap copy. Discovered by the
 * Status Tiles webapp through the `statusTileExamples` resource type.
 * Pure config — no code runs from it — so it is low-risk to load once
 * at module scope. See doc/sharing-example-tile-sets.md upstream and
 * `status-tiles-examples.json` for the set contents.
 */
const STATUS_TILES_EXAMPLES = JSON.parse(
  readFileSync(join(__dirname, "status-tiles-examples.json"), "utf8"),
);

/** Where the server serves `public/` (the package is a `signalk-webapp`). */
const PUBLIC_BASE = `/${pkg.name}`;

/**
 * Plotter Extensions manifest (Freeboard-SK and other chart plotters that
 * read the `plotterExtensions` resource type). A toolbar button opens a
 * small window with the live state, ping and Starlink values and the
 * manual override; a background runtime colours the button by state.
 * Pages are served from `public/plotterext/`.
 */
const PLOTTER_EXTENSION = {
  name: "Internet Connectivity",
  description:
    "Internet state at a glance on the chart, with the manual override (online, metered, offline).",
  version: pkg.version,
  apiVersion: "1",
  requires: ["buttons", "panels.iframe", "signalk.stream"],
  optional: [
    "windows",
    "background.iframe",
    "buttons.decorations",
    "nightMode",
  ],
  buttons: [
    {
      id: "internet-status",
      title: "Internet",
      slot: "mapToolbar",
      icon: "satellite_alt",
      action: {
        type: "toggleWindow",
        panel: "internet-status",
        geometry: { anchor: "top-right", width: 320, height: 360 },
        restoreKey: "internet-status",
      },
    },
  ],
  panels: [
    {
      id: "internet-status",
      title: "Internet",
      type: "iframe",
      url: `${PUBLIC_BASE}/plotterext/status.html`,
    },
  ],
  background: [
    {
      id: "internet-indicator",
      title: "Internet state on the toolbar button",
      type: "iframe",
      url: `${PUBLIC_BASE}/plotterext/indicator.html`,
    },
  ],
};

/**
 * Default hardware uplink mappings shipped out of the box.
 *
 * `signalk-starlink` publishes `network.providers.starlink.status` with
 * the string value `"online"` when the dish has internet routing. We
 * pre-seed this so a Starlink-equipped vessel gets correct state without
 * any configuration; the user can still override or extend the list.
 */
const DEFAULT_CONNECTION_MAPPINGS = [
  {
    path: "network.providers.starlink.status",
    matchValue: "online",
    resultingState: "online",
  },
];

/**
 * Default contextual state rules shipped out of the box.
 *
 * Two shipped heuristics:
 *
 * - While a watch schedule is running the vessel is typically offshore on
 *   a metered uplink (satellite, roaming SIM), so we conservatively assume
 *   `metered` to keep downstream plugins from burning expensive bandwidth.
 * - `signalk-starlink-offshore` publishes `navigation.maritimeZone` based
 *   on the vessel's position; on the high seas Starlink switches to the
 *   metered ocean data plan, while territorial waters and inland sailing
 *   are covered by the standard unlimited plan.
 *
 * Heuristics are modifiers, not verdicts: they only clamp an
 * already-reachable base state down to `metered` — when there is no
 * internet (dish down, no LTE) the state stays `offline` rather than
 * falsely reporting a metered connection. The Signal K core publishes
 * `watch.state.onWatch` as a boolean; the evaluator coerces both sides to
 * strings before comparing, so a boolean `true` matches the configured
 * `triggerValue: "true"`. A user who wants different assumptions (or
 * none) can edit or clear the list.
 */
const DEFAULT_STATE_HEURISTICS = [
  {
    path: "watch.state.onWatch",
    triggerValue: "true",
    resultingState: "metered",
  },
  {
    path: "navigation.maritimeZone",
    triggerValue: "high-seas",
    resultingState: "metered",
  },
];

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin}
 */
module.exports = (app) => {
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);
  const unsubscribes = [];
  let evaluator = null;
  /** @type {NodeJS.Timeout|null} handle of the adaptive probe timer */
  let probeTimer = null;

  /**
   * Cancels any pending periodic probe. Factory-scoped so `stop()` can
   * reach it (the scheduling helpers themselves are start-scoped since
   * they need the per-start config and evaluator).
   */
  function clearProbeTimer() {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }
  // Injectable speed test (tests); falls back to the real HTTPS download.
  let speedTestFn = null;
  /** @type {boolean} plugin started; gates the resource providers */
  let running = false;
  /** @type {boolean} resource providers registered with the server */
  let providerRegistered = false;

  const plugin = {
    id: PLUGIN_ID,
    name: "Internet Connectivity Monitor",
    description:
      "Centralized internet connectivity state detection with fallback active probing",

    schema: {
      type: "object",
      properties: {
        probeProvider: {
          type: "string",
          title: "Connectivity Probe",
          default: DEFAULT_PROBE_PROVIDER,
          enum: ["apple", "google", "none"],
          options: {
            enum_titles: ["Apple", "Google", "No probe"],
          },
          description:
            "Active probe verifying that the uplink actually routes to the internet. Apple sends a small HTTPS request to its captive-portal detection endpoint and checks the body; Google sends a plain HTTP request expecting status 204 — no TLS handshake and no response body, cheaper on metered uplinks. Both detect captive portals. 'No probe' never contacts an outside service: the state is taken on trust from hardware mappings (Starlink, modem status) and contextual rules alone, defaulting to offline when none matches.",
        },
        pollInterval: {
          type: "integer",
          title: "Fallback Ping Interval (seconds)",
          default: 30,
          description:
            "Active probing cadence while the state is offline, or whenever no hardware mapping can report the uplink (the probe is then the only state detector). Hardware down-transitions are picked up instantly from the delta stream, so this interval only governs outage/recovery detection.",
        },
        onlineVerifyInterval: {
          type: "integer",
          title: "Online Re-verification Interval (seconds)",
          default: DEFAULT_ONLINE_VERIFY_INTERVAL,
          description:
            "How often to re-verify the uplink with an active probe while a hardware mapping reports it up and the resolved state is online. Much slower than the fallback interval: hardware down-transitions arrive instantly over the delta stream, so this only guards against a modem that stays up but stops routing.",
        },
        meteredVerifyInterval: {
          type: "integer",
          title: "Metered Re-verification Interval (seconds)",
          default: DEFAULT_METERED_VERIFY_INTERVAL,
          description:
            "How often to re-verify while the resolved state is metered or captive. Deliberately slower than the online interval to conserve expensive metered data.",
        },
        stateHeuristics: {
          type: "array",
          title: "Contextual State Rules (refine reachability)",
          default: DEFAULT_STATE_HEURISTICS,
          description:
            "Heuristics refine an already-resolved reachability state and can only make it more severe (online < metered < captive < offline). They never create connectivity the uplink/probe didn't establish, so a 'metered when on watch' or 'metered on the high seas' rule has no effect when the internet is actually down.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", title: "Signal K Path" },
              triggerValue: { type: "string", title: "Trigger Value" },
              negate: {
                type: "boolean",
                title: "NOT (match when value differs)",
                default: false,
              },
              resultingState: {
                type: "string",
                enum: ["online", "metered", "offline"],
              },
            },
          },
        },
        connectionMappings: {
          type: "array",
          title: "Hardware Delta Mappings",
          default: DEFAULT_CONNECTION_MAPPINGS,
          items: {
            type: "object",
            properties: {
              path: { type: "string", title: "Hardware Path" },
              matchValue: { type: "string", title: "Value to Match" },
              negate: {
                type: "boolean",
                title: "NOT (match when value differs)",
                default: false,
              },
              resultingState: {
                type: "string",
                enum: ["online", "metered", "offline"],
              },
            },
          },
        },
      },
    },

    start: (options) => {
      running = true;
      registerResourceProviders();
      const raw = options || {};
      // Fall back to the shipped Starlink mapping when the user hasn't
      // configured any (undefined). An explicit empty array means the user
      // disabled hardware mappings, so we respect that.
      const config = {
        ...raw,
        connectionMappings:
          raw.connectionMappings === undefined
            ? DEFAULT_CONNECTION_MAPPINGS
            : raw.connectionMappings,
        stateHeuristics:
          raw.stateHeuristics === undefined
            ? DEFAULT_STATE_HEURISTICS
            : raw.stateHeuristics,
      };

      // Probe provider selection. Schema restricts the pulldown to the
      // shipped values, but saved configs can carry anything — fall
      // back to the default rather than throwing on every probe.
      let probeProvider =
        raw.probeProvider === undefined
          ? DEFAULT_PROBE_PROVIDER
          : raw.probeProvider;
      if (probeProvider !== "none" && !PROVIDERS[probeProvider]) {
        app.error(
          `${PLUGIN_ID}: unknown probe provider "${probeProvider}", using "${DEFAULT_PROBE_PROVIDER}"`,
        );
        probeProvider = DEFAULT_PROBE_PROVIDER;
      }

      /**
       * Publishes a connectivity delta to the Signal K bus.
       *
       * @param {"online"|"offline"|"metered"|"captive"} state
       * @param {number|null} ping - Round-trip latency in ms
       */
      function publish(state, ping) {
        app.handleMessage(PLUGIN_ID, {
          context: "vessels.self",
          updates: [
            {
              source: { label: PLUGIN_ID, src: "internet" },
              timestamp: new Date().toISOString(),
              values: [
                { path: STATE_PATH, value: state },
                { path: PING_PATH, value: ping },
              ],
            },
          ],
        });
        setStatus(`Internet: ${state}${ping != null ? ` (${ping}ms)` : ""}`);
        // The probe cadence depends on the resolved state, so a published
        // transition (e.g. online → metered) reschedules the countdown
        // immediately instead of waiting out the previous interval.
        scheduleProbe();
      }

      /**
       * Active probe used by the evaluator. Uses the retrying variant
       * to ride through transient DNS hiccups. Tests may inject a
       * custom probe via `options.probe` to avoid hitting the network.
       * The "No probe" provider (or a failed probe) leaves it null and
       * the evaluator falls back to event-driven hardware mappings.
       */
      let activeProbe = null;
      if (typeof raw.probe === "function") {
        activeProbe = raw.probe;
      } else if (probeProvider !== "none") {
        activeProbe = () => probeWithRetry({ provider: probeProvider });
      }

      evaluator = createEvaluator({
        config,
        onState: publish,
        probe: activeProbe,
      });
      speedTestFn = typeof raw.speedtest === "function" ? raw.speedtest : null;

      // Subscribe to the Signal K paths the heuristic and hardware rules
      // watch, so the evaluator's stream cache stays current.
      const watchedPaths = collectWatchedPaths(config);
      if (watchedPaths.length > 0) {
        const subscription = {
          context: "vessels.self",
          subscribe: watchedPaths.map((path) => ({ path, policy: "instant" })),
        };
        app.subscriptionmanager.subscribe(
          subscription,
          unsubscribes,
          (err) => app.error(`Subscription error: ${err}`),
          (delta) => feedDelta(delta, evaluator),
        );
      }

      /**
       * Seconds until the next periodic probe, based on the resolved
       * state and whether a hardware mapping currently reports the
       * uplink up. See `computeProbeIntervalSeconds` for the cadence
       * ladder.
       */
      function probeIntervalSeconds() {
        return computeProbeIntervalSeconds({
          state: evaluator.current().state,
          hardwareState: evaluator.hardwareState(),
          config,
        });
      }

      /**
       * Schedules the next periodic probe at the cadence the current
       * state calls for. Re-invoked after every published state change
       * and after each completed probe, so the loop is self-rescheduling
       * and always adapts to the latest state.
       */
      function scheduleProbe() {
        clearProbeTimer();
        // A probe still in flight when the plugin stopped can call back
        // into publish after `stop()` has cleared the evaluator; do not
        // schedule anything in that case.
        if (!evaluator) return;
        // "No probe" mode is fully event-driven: forceProbe would only
        // re-publish the hardware-derived state, so no timer is needed.
        if (!activeProbe) return;
        probeTimer = setTimeout(() => {
          probeTimer = null;
          Promise.resolve(evaluator.forceProbe())
            .catch((err) => app.error(`Probe failed: ${err.message}`))
            .finally(scheduleProbe);
        }, probeIntervalSeconds() * 1000);
      }

      // Kick off an initial probe so the state settles quickly on start,
      // with the adaptive timer loop running behind it.
      scheduleProbe();
      evaluator.forceProbe();

      // Send meta so consumers know the units and meaning of our paths.
      app.handleMessage(PLUGIN_ID, {
        context: "vessels.self",
        updates: [
          {
            meta: [
              {
                path: STATE_PATH,
                value: {
                  displayName: "Internet state",
                  description:
                    "Unified internet connectivity state: online, offline, metered, or captive",
                },
              },
              {
                path: PING_PATH,
                value: {
                  units: "ms",
                  displayName: "Internet ping",
                  description:
                    "Round-trip latency to the verification endpoint",
                },
              },
              {
                path: SPEED_PATH,
                value: {
                  units: "bit/s",
                  displayName: "Internet download speed",
                  description:
                    "Download throughput measured by the last successful speed test",
                },
              },
            ],
          },
        ],
      });

      setStatus("Internet monitor started");
    },

    stop: () => {
      running = false;
      clearProbeTimer();
      for (const f of unsubscribes) f();
      unsubscribes.length = 0;
      evaluator = null;
      speedTestFn = null;
      setStatus("Internet monitor stopped");
    },
  };

  // --- Speed-test recording ------------------------------------------------

  /**
   * Publishes a completed speed-test measurement so it is recorded by
   * whatever history provider is running (the same mechanism behind the
   * connection history) and stays visible to other consumers. The value
   * is in bit/s so UIs can scale it with SI prefixes; speed tests are
   * manual, infrequent actions, so one delta per run does not spam the
   * bus. Failures are not recorded — only real measurements.
   *
   * Factory-scoped so the REST router can call it.
   *
   * @param {{bytes: number, elapsedMs: number, throughputMbps: number}} result
   */
  function recordSpeed(result) {
    const bitsPerSecond =
      result.elapsedMs > 0
        ? Math.round((result.bytes * 8) / (result.elapsedMs / 1000))
        : 0;
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          source: { label: PLUGIN_ID, src: "internet" },
          timestamp: new Date().toISOString(),
          values: [{ path: SPEED_PATH, value: bitsPerSecond }],
        },
      ],
    });
  }

  /**
   * Registers this plugin's read-only resource providers: the
   * `statusTileExamples` set the Status Tiles webapp offers for one-tap
   * copy, and the `plotterExtensions` manifest that puts the internet
   * status button and window into chart plotters such as Freeboard-SK.
   * Provision is gated by `running` (returns {} when stopped, so a
   * disabled plugin disappears from the discovery lists with no stale
   * entries) and registered at most once per plugin instance — a restart
   * (stop+start on a config save) must not double-register. Skipped on
   * servers without the resource provider registry (older servers).
   */
  function registerResourceProviders() {
    if (providerRegistered) return;
    if (typeof app.registerResourceProvider !== "function") {
      app.error(
        `${PLUGIN_ID}: server has no resource provider registry; status-tiles examples and the chart plotter extension disabled`,
      );
      return;
    }
    registerReadOnlyProvider("statusTileExamples", STATUS_TILES_EXAMPLES);
    registerReadOnlyProvider("plotterExtensions", PLOTTER_EXTENSION);
    providerRegistered = true;
  }

  /**
   * Registers a provider serving one fixed resource keyed by the plugin id.
   *
   * @param {string} type - Resource type
   * @param {object} resource - The resource served while running
   */
  function registerReadOnlyProvider(type, resource) {
    app.registerResourceProvider({
      type,
      methods: {
        listResources: async () => (running ? { [PLUGIN_ID]: resource } : {}),
        getResource: async (id) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(`No such ${type} resource: ${id}`);
          }
          return resource;
        },
        setResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`);
        },
        deleteResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`);
        },
      },
    });
  }

  /**
   * Collects every Signal K path referenced by the configured heuristic
   * and hardware rules, de-duplicated.
   *
   * @param {object} config - Plugin configuration
   * @returns {string[]}
   */
  function collectWatchedPaths(config) {
    const paths = new Set();
    for (const rule of config.stateHeuristics || []) {
      if (rule.path) paths.add(rule.path);
    }
    for (const rule of config.connectionMappings || []) {
      if (rule.path) paths.add(rule.path);
    }
    return [...paths];
  }

  /**
   * Feeds a Signal K delta into the evaluator's stream cache. Only paths
   * the evaluator watches cause a re-evaluation.
   *
   * @param {object} delta - Signal K delta
   * @param {object} ev - Evaluator instance
   */
  function feedDelta(delta, ev) {
    if (!delta?.updates) return;
    for (const update of delta.updates) {
      if (!update.values) continue;
      for (const v of update.values) {
        ev.set(v.path, v.value);
      }
    }
  }

  // --- REST API -----------------------------------------------------------
  // Mounted by the server at /plugins/<id>. We expose the override toggle
  // and the guarded speed test endpoint.

  /**
   * Registers REST routes on the plugin router.
   *
   * @param {object} router - Express router
   */
  plugin.registerWithRouter = (router) => {
    // Plotter users who are not administrators still see whether the state
    // is manual; servers without router.access keep every route admin-only.
    const readonly = router.access ? router.access("readonly") : router;

    /**
     * GET /override — the manual state override currently set, or null.
     */
    readonly.get("/override", (_req, res) => {
      if (!evaluator) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      res.json({ override: evaluator.getOverride() });
    });

    /**
     * PUT /override — set or clear the manual state override.
     * Body: `{ "state": "online"|"offline"|"metered"|"captive"|null }`
     * (the SPEC's `forceMetered` boolean is accepted for backwards
     * compatibility and maps to the metered state).
     */
    router.put("/override", (req, res) => {
      if (!evaluator) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      let body = req.body;
      if (body == null) {
        // Express may not have parsed JSON; try to parse manually
        try {
          body = JSON.parse(req.body);
        } catch {
          body = {};
        }
      }
      const state = resolveOverride(body);
      if (state === undefined) {
        res.status(400).json({ message: "Invalid override body" });
        return;
      }
      evaluator.setOverride(state);
      res.json({ override: evaluator.getOverride() });
    });

    /**
     * POST /speedtest — run a guarded server-side download test.
     * 403 when metered, 409 when offline.
     *
     * The guard honors a manual override's intent immediately (a forced
     * `offline` blocks with 409, a forced `metered` blocks with 403) even
     * before the reachability probe that gates the *published* state has
     * resolved — a user who forces metered explicitly asks us to hold off
     * on bandwidth, so we shouldn't run a speedtest while we verify.
     */
    router.post("/speedtest", (_req, res) => {
      if (!evaluator) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const override = evaluator.getOverride();
      const { state } = evaluator.current();
      // Effective guard state: override intent wins for the explicit
      // bandwidth-blocking cases; otherwise fall back to the resolved
      // (probe-gated) state.
      const guardState =
        override === "offline" || override === "metered" ? override : state;
      try {
        guard(guardState);
      } catch (err) {
        if (err instanceof GuardError) {
          res.status(err.status).json({ message: err.message });
          return;
        }
        throw err;
      }
      // Tests may inject a fake test via `options.speedtest` to avoid
      // hitting the network (mirrors the `probe` injection).
      const runTest =
        typeof speedTestFn === "function" ? speedTestFn : runSpeedTest;
      runTest()
        .then((result) => {
          recordSpeed(result);
          res.json(result);
        })
        .catch((err) => {
          app.error(`Speed test failed: ${err.message}`);
          res.status(500).json({ message: err.message });
        });
    });
  };

  return plugin;
};

/**
 * Resolves the override state from a request body, accepting both the
 * SPEC's `forceMetered` boolean and a direct `state` string.
 *
 * @param {object} body
 * @returns {"online"|"offline"|"metered"|"captive"|null|undefined} state,
 *   or `undefined` when the body is unrecognizable
 */
function resolveOverride(body) {
  if (!body || typeof body !== "object") return undefined;
  if (typeof body.state === "string") {
    const valid = ["online", "offline", "metered", "captive"];
    if (valid.includes(body.state)) return body.state;
    if (body.state === "") return null;
    return undefined;
  }
  if (body.state === null) return null;
  if (typeof body.forceMetered === "boolean") {
    return body.forceMetered ? "metered" : null;
  }
  if (body.forceMetered === null) return null;
  return undefined;
}

/**
 * Computes the seconds until the next periodic probe.
 *
 * Cadence ladder, slowest for the states that cost the most data:
 *
 *   - `offline`, or no hardware mapping matches: the fast fallback
 *     interval. With no mapping the active probe is the only state
 *     detector, so outage recovery must be noticed quickly; with a
 *     mapping its down-transition already arrives instantly via the
 *     delta stream and this interval only retries verification.
 *   - `online` with a hardware mapping up: slow re-verification — the
 *     delta stream handles real down-transitions, this only catches a
 *     modem that stays "up" but stops routing.
 *   - `metered`/`captive` with a hardware mapping up: slowest, to
 *     conserve metered data.
 *
 * @param {object} args
 * @param {string} args.state - Current resolved connectivity state
 * @param {string|null} args.hardwareState - State of the first matching
 *   hardware mapping, or null when none matches
 * @param {object} args.config - Plugin configuration
 * @returns {number} seconds until the next probe
 */
function computeProbeIntervalSeconds({ state, hardwareState, config }) {
  const cfg = config || {};
  if (state === "offline" || hardwareState === null) {
    return cfg.pollInterval || 30;
  }
  if (state === "metered" || state === "captive") {
    return cfg.meteredVerifyInterval || DEFAULT_METERED_VERIFY_INTERVAL;
  }
  return cfg.onlineVerifyInterval || DEFAULT_ONLINE_VERIFY_INTERVAL;
}

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.PLOTTER_EXTENSION = PLOTTER_EXTENSION;
module.exports.STATE_PATH = STATE_PATH;
module.exports.PING_PATH = PING_PATH;
module.exports.SPEED_PATH = SPEED_PATH;
module.exports.DEFAULT_CONNECTION_MAPPINGS = DEFAULT_CONNECTION_MAPPINGS;
module.exports.DEFAULT_STATE_HEURISTICS = DEFAULT_STATE_HEURISTICS;
module.exports.DEFAULT_PROBE_PROVIDER = DEFAULT_PROBE_PROVIDER;
module.exports.DEFAULT_ONLINE_VERIFY_INTERVAL = DEFAULT_ONLINE_VERIFY_INTERVAL;
module.exports.DEFAULT_METERED_VERIFY_INTERVAL =
  DEFAULT_METERED_VERIFY_INTERVAL;
module.exports.computeProbeIntervalSeconds = computeProbeIntervalSeconds;
