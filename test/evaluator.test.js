const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createEvaluator, DEFAULT_STATE } = require("../lib/evaluator.js");

function makeConfig(rules = {}, mappings = []) {
  return {
    stateHeuristics: rules.heuristics || [],
    connectionMappings: mappings,
  };
}

describe("evaluator", () => {
  test("defaults to offline when nothing matches and no probe configured", () => {
    const ev = createEvaluator({ config: makeConfig() });
    assert.strictEqual(ev.current().state, DEFAULT_STATE);
  });

  test("manual override to offline is published immediately and absolutely", async () => {
    const online = async () => ({ state: "online", ping: 5 });
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig(),
      onState: (state) => seen.push(state),
      probe: online,
    });
    // offline is the floor — forcing it can never lie, so it's absolute
    // and synchronous (no probe needed). Establish a non-offline state
    // first so the transition is observable (publishing
    // offline-from-offline is deduped); the `online` override is
    // reachability-gated, so await its probe.
    ev.setOverride("online");
    await new Promise((r) => setTimeout(r, 10));
    seen.length = 0;
    ev.setOverride("offline");
    assert.strictEqual(ev.current().state, "offline");
    assert.deepStrictEqual(seen, ["offline"]);
    assert.strictEqual(ev.getOverride(), "offline");
  });

  test("metered override is honored when reachable, else stays offline", async () => {
    const online = async () => ({ state: "online", ping: 20 });
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig(),
      onState: (state, ping) => seen.push({ state, ping }),
      probe: online,
    });
    ev.setOverride("metered");
    // No synchronous publish — the override is gated on a probe.
    assert.deepStrictEqual(seen, []);
    await new Promise((r) => setTimeout(r, 10));
    // Probe confirms reachability, so the override wins.
    assert.strictEqual(ev.current().state, "metered");
    assert.strictEqual(ev.getOverride(), "metered");
    assert.deepStrictEqual(seen, [{ state: "metered", ping: 20 }]);
  });

  test("metered override falls back to offline when the uplink is down", async () => {
    let reachable = true;
    const probe = async () =>
      reachable
        ? { state: "online", ping: 10 }
        : { state: "offline", ping: null };
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig(),
      onState: (state, ping) => seen.push({ state, ping }),
      probe,
    });
    // Establish a non-offline published state first so the fallback is
    // observable (publishing offline-from-offline is deduped).
    ev.setOverride("online");
    await new Promise((r) => setTimeout(r, 10));
    seen.length = 0;
    // Drop the uplink, then force metered: it can't manufacture
    // connectivity, so the state must fall back to offline.
    reachable = false;
    ev.setOverride("metered");
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(ev.current().state, "offline");
    assert.deepStrictEqual(seen, [{ state: "offline", ping: null }]);
  });

  test("online override is honored when reachable", async () => {
    const online = async () => ({ state: "online", ping: 15 });
    const ev = createEvaluator({
      config: makeConfig(),
      probe: online,
    });
    ev.setOverride("online");
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(ev.current().state, "online");
  });

  test("clearing override falls through to rules", async () => {
    const probe = async () => ({ state: "online", ping: 30 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "watch.state.onWatch",
            triggerValue: "true",
            resultingState: "metered",
          },
        ],
      }),
      probe,
    });
    ev.setOverride("offline");
    assert.strictEqual(ev.current().state, "offline");

    // Seed the heuristic value before clearing the override so the rule
    // matches on the re-evaluation triggered by setOverride(null).
    ev.set("watch.state.onWatch", true);
    ev.setOverride(null);
    // Reachability resolves via the probe (online), then the on-watch
    // heuristic refines it to metered.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(ev.current().state, "metered");
    assert.strictEqual(ev.getOverride(), null);
  });

  test("on-watch heuristic refines a reachable base to metered", async () => {
    const probe = async () => ({ state: "online", ping: 25 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "watch.state.onWatch",
            triggerValue: "true",
            resultingState: "metered",
          },
        ],
      }),
      probe,
    });
    ev.set("watch.state.onWatch", true);
    await new Promise((r) => setTimeout(r, 10));
    // online base + on-watch -> metered.
    assert.strictEqual(ev.current().state, "metered");
  });

  test("high-seas maritime zone heuristic refines a reachable base to metered", async () => {
    const probe = async () => ({ state: "online", ping: 25 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "navigation.maritimeZone",
            triggerValue: "high-seas",
            resultingState: "metered",
          },
        ],
      }),
      probe,
    });
    ev.set("navigation.maritimeZone", "high-seas");
    await new Promise((r) => setTimeout(r, 10));
    // online base + high-seas (Starlink ocean data) -> metered.
    assert.strictEqual(ev.current().state, "metered");
  });

  test("territorial maritime zones do not trigger the metered rule", async () => {
    const probe = async () => ({ state: "online", ping: 25 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "navigation.maritimeZone",
            triggerValue: "high-seas",
            resultingState: "metered",
          },
        ],
      }),
      probe,
    });
    for (const zone of ["territorial-sea", "internal-waters", "land"]) {
      ev.set("navigation.maritimeZone", zone);
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(
        ev.current().state,
        "online",
        `zone ${zone} should not clamp the state`,
      );
    }
  });

  test("on-watch heuristic does not upgrade an offline base", async () => {
    const probe = async () => ({ state: "offline", ping: null });
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "watch.state.onWatch",
            triggerValue: "true",
            resultingState: "metered",
          },
        ],
      }),
      onState: (state, ping) => seen.push({ state, ping }),
      probe,
    });
    ev.set("watch.state.onWatch", true);
    await new Promise((r) => setTimeout(r, 10));
    // No internet -> stays offline; the heuristic can't manufacture
    // connectivity it doesn't have.
    assert.strictEqual(ev.current().state, "offline");
  });

  test("heuristic does not downgrade captive below its severity", async () => {
    const probe = async () => ({ state: "captive", ping: 80 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "watch.state.onWatch",
            triggerValue: "true",
            resultingState: "metered",
          },
        ],
      }),
      probe,
    });
    ev.set("watch.state.onWatch", true);
    await new Promise((r) => setTimeout(r, 10));
    // captive (severity 2) is worse than metered (1); heuristic can't
    // weaken it, so the state stays captive.
    assert.strictEqual(ev.current().state, "captive");
  });

  test("offline-forcing heuristic overrides any reachable base", async () => {
    const probe = async () => ({ state: "online", ping: 25 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "environment.indoors",
            triggerValue: "true",
            resultingState: "offline",
          },
        ],
      }),
      probe,
    });
    ev.set("environment.indoors", true);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(ev.current().state, "offline");
  });

  test("negated heuristic matches when value differs from triggerValue", async () => {
    const probe = async () => ({ state: "online", ping: 25 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "watch.state.onWatch",
            triggerValue: "true",
            negate: true,
            resultingState: "metered",
          },
        ],
      }),
      probe,
    });
    ev.set("watch.state.onWatch", false);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(ev.current().state, "metered");
  });

  test("negated heuristic does not match the trigger value itself", () => {
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "watch.state.onWatch",
            triggerValue: "true",
            negate: true,
            resultingState: "metered",
          },
        ],
      }),
      onState: (state) => seen.push(state),
    });
    ev.set("watch.state.onWatch", true);
    // Trigger value itself must NOT match; stays at the default state.
    assert.strictEqual(ev.current().state, DEFAULT_STATE);
  });

  test("negated heuristic does not match an absent value", () => {
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "networking.lte.connectionText",
            triggerValue: "No service",
            negate: true,
            resultingState: "online",
          },
        ],
      }),
      onState: (state) => seen.push(state),
    });
    ev.reevaluate();
    // No value set yet — a NOT rule still needs a value to negate against.
    assert.deepStrictEqual(seen, []);
  });

  test("hardware up mapping triggers a targeted verify probe", async () => {
    const calls = [];
    const probe = async () => {
      calls.push("probe");
      return { state: "online", ping: 42 };
    };
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({}, [
        {
          path: "network.providers.starlink.status",
          matchValue: "connected",
          resultingState: "online",
        },
      ]),
      onState: (state, ping) => seen.push({ state, ping }),
      probe,
    });
    ev.set("network.providers.starlink.status", "connected");
    // No immediate publish — the uplink "up" must be verified first.
    assert.deepStrictEqual(seen, []);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(seen, [{ state: "online", ping: 42 }]);
  });

  test("negated hardware mapping matches any operator except the configured value", async () => {
    const calls = [];
    const probe = async () => {
      calls.push("probe");
      return { state: "online", ping: 50 };
    };
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({}, [
        {
          path: "networking.lte.connectionText",
          matchValue: "No service",
          negate: true,
          resultingState: "online",
        },
      ]),
      onState: (state, ping) => seen.push({ state, ping }),
      probe,
    });
    // An actual operator name differs from "No service" -> match.
    ev.set("networking.lte.connectionText", "Telia");
    assert.deepStrictEqual(seen, []);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(seen, [{ state: "online", ping: 50 }]);
  });

  test("negated hardware mapping does not match the excluded value", () => {
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({}, [
        {
          path: "networking.lte.connectionText",
          matchValue: "No service",
          negate: true,
          resultingState: "offline",
        },
      ]),
      onState: (state, ping) => seen.push({ state, ping }),
    });
    ev.set("networking.lte.connectionText", "No service");
    // The excluded value must NOT match.
    assert.deepStrictEqual(seen, []);
  });

  test("negated hardware down mapping transitions to offline for any other value", async () => {
    const online = async () => ({ state: "online", ping: 10 });
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({}, [
        {
          path: "network.providers.starlink.status",
          matchValue: "disconnected",
          negate: true,
          resultingState: "offline",
        },
      ]),
      onState: (state, ping) => seen.push({ state, ping }),
      probe: online,
    });
    ev.setOverride("online");
    await new Promise((r) => setTimeout(r, 10));
    seen.length = 0;
    ev.set("network.providers.starlink.status", "connected");
    ev.setOverride(null);
    assert.deepStrictEqual(seen, [{ state: "offline", ping: null }]);
  });

  test("hardware down mapping transitions to offline instantly (0ms)", async () => {
    const online = async () => ({ state: "online", ping: 10 });
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({}, [
        {
          path: "network.providers.starlink.status",
          matchValue: "disconnected",
          resultingState: "offline",
        },
      ]),
      onState: (state, ping) => seen.push({ state, ping }),
      probe: online,
    });
    // Establish a non-offline state so the down transition is observable.
    // `online` override is reachability-gated, so await its probe.
    ev.setOverride("online");
    await new Promise((r) => setTimeout(r, 10));
    seen.length = 0;
    // Seed the down value, then clear the override so the hardware rule
    // fires on re-evaluation.
    ev.set("network.providers.starlink.status", "disconnected");
    ev.setOverride(null);
    // Instant down: published synchronously with no probe, null ping.
    assert.deepStrictEqual(seen, [{ state: "offline", ping: null }]);
  });

  test("unwatched path does not trigger a re-evaluation", () => {
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig(),
      onState: (state) => seen.push(state),
    });
    ev.set("some.unrelated.path", 42);
    assert.deepStrictEqual(seen, []);
  });

  test("probe fallback is used when no rule matches", async () => {
    const calls = [];
    const probe = async () => {
      calls.push("probe");
      return { state: "online", ping: 12 };
    };
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig(),
      onState: (state, ping) => seen.push({ state, ping }),
      probe,
    });
    ev.reevaluate();
    // Probe runs async; give it a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(seen, [{ state: "online", ping: 12 }]);
    assert.strictEqual(ev.current().state, "online");
    assert.strictEqual(ev.current().ping, 12);
  });

  test("override beats a matching heuristic", async () => {
    const online = async () => ({ state: "online", ping: 10 });
    const ev = createEvaluator({
      config: makeConfig({
        heuristics: [
          {
            path: "watch.state.onWatch",
            triggerValue: "true",
            resultingState: "metered",
          },
        ],
      }),
      probe: online,
    });
    ev.set("watch.state.onWatch", true);
    ev.setOverride("online");
    await new Promise((r) => setTimeout(r, 10));
    // The online override wins over the metered heuristic, and is gated
    // on reachability (probe says online) so it publishes online.
    assert.strictEqual(ev.current().state, "online");
  });

  test("forceProbe re-runs the probe and publishes", async () => {
    let n = 0;
    const probe = async () => ({ state: "online", ping: ++n });
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig(),
      onState: (state, ping) => seen.push({ state, ping }),
      probe,
    });
    await ev.forceProbe();
    await ev.forceProbe();
    assert.deepStrictEqual(seen, [
      { state: "online", ping: 1 },
      { state: "online", ping: 2 },
    ]);
  });

  test("hardwareState returns the first matching mapping's state, else null", () => {
    const ev = createEvaluator({
      config: makeConfig({}, [
        {
          path: "uplink.status",
          matchValue: "online",
          resultingState: "online",
        },
      ]),
    });
    assert.strictEqual(ev.hardwareState(), null);
    ev.set("uplink.status", "online");
    assert.strictEqual(ev.hardwareState(), "online");
  });

  test("forceProbe skips the network probe when a hardware mapping resolves offline", async () => {
    let probed = 0;
    const probe = async () => {
      probed++;
      return { state: "online", ping: 5 };
    };
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig({}, [
        {
          path: "uplink.status",
          matchValue: "offline",
          resultingState: "offline",
        },
      ]),
      onState: (state) => seen.push(state),
      probe,
    });
    ev.set("uplink.status", "offline");
    await ev.forceProbe();
    assert.strictEqual(probed, 0, "hardware offline must not spend probe data");
    assert.strictEqual(ev.current().state, "offline");
  });

  test("forceProbe skips the network probe under an offline override", async () => {
    let probed = 0;
    const probe = async () => {
      probed++;
      return { state: "online", ping: 5 };
    };
    const ev = createEvaluator({
      config: makeConfig(),
      onState: () => {},
      probe,
    });
    ev.setOverride("offline");
    await ev.forceProbe();
    assert.strictEqual(probed, 0, "forced offline must not spend probe data");
    assert.strictEqual(ev.current().state, "offline");
  });

  test("forceProbe publishes under a reachability-gated override", async () => {
    let n = 0;
    const online = async () => ({ state: "online", ping: ++n });
    const seen = [];
    const ev = createEvaluator({
      config: makeConfig(),
      onState: (state, ping) => seen.push({ state, ping }),
      probe: online,
    });
    ev.setOverride("metered");
    await new Promise((r) => setTimeout(r, 10));
    seen.length = 0;
    // A timer-driven re-verification must not silently clear the forced
    // state; it publishes under the override instead.
    await ev.forceProbe();
    assert.deepStrictEqual(seen, [{ state: "metered", ping: 2 }]);
  });
});
