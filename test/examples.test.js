const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const pluginFactory = require("../index.js");

/** Deterministic fake probe so the suite never touches the network. */
const fakeProbe = async () => ({ state: "online", ping: 5 });

/**
 * Minimal mock app that captures `registerResourceProvider` calls so we
 * can exercise the examples provider without a running server.
 */
function createMockApp({ withRegistry = true } = {}) {
  const messages = [];
  const errors = [];
  const providers = [];
  return {
    debug: () => {},
    error: (msg) => errors.push(msg),
    setPluginStatus: () => {},
    setProviderStatus: () => {},
    subscriptionmanager: {
      subscribe: () => {},
    },
    handleMessage: (id, delta) => messages.push({ id, delta }),
    registerResourceProvider: withRegistry
      ? (provider) => providers.push(provider)
      : undefined,
    getProviders: () => providers,
    getErrors: () => errors,
    getMessages: () => messages,
  };
}

describe("status-tiles examples provider", () => {
  test("ships a well-formed examples JSON loaded at module scope", () => {
    // The factory exposes the loaded examples indirectly through the
    // provider; here we assert shape via the provider after start.
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });

    const provider = app.getProviders()[0];
    assert.strictEqual(provider.type, "statusTileExamples");

    const listed = provider.methods.listResources();
    // listResources is async; assert on the resolved shape.
    return listed.then((resources) => {
      assert.ok(
        Object.hasOwn(resources, "signalk-internet"),
        "examples keyed by plugin id while running",
      );
      const examples = resources["signalk-internet"];
      assert.ok(examples.name, "collection has a name");
      assert.ok(Array.isArray(examples.sets) && examples.sets.length > 0);
      const set = examples.sets[0];
      assert.ok(set.id, "set has a stable id");
      assert.ok(set.name, "set has a name");
      assert.ok(Array.isArray(set.tiles) && set.tiles.length > 0);
      const tile = set.tiles[0];
      assert.ok(tile.id, "tile has an id");
      assert.ok(tile.label, "tile has a label");
      assert.ok(Array.isArray(tile.checks) && tile.checks.length > 0);
      assert.strictEqual(tile.checks[0].type, "stateMatch");
      assert.strictEqual(tile.checks[0].path, "network.internet.state");
      plugin.stop();
    });
  });

  test("listResources returns {} when stopped (no stale entries)", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });

    const provider = app.getProviders()[0];
    assert.ok(
      Object.keys(await provider.methods.listResources()).length > 0,
      "present while running",
    );

    plugin.stop();
    assert.deepStrictEqual(await provider.methods.listResources(), {});
  });

  test("getResource returns the set for the plugin id, throws otherwise", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    const provider = app.getProviders()[0];

    const examples = await provider.methods.getResource("signalk-internet");
    assert.strictEqual(examples.sets[0].id, "internet-connectivity");

    await assert.rejects(
      provider.methods.getResource("some-other-plugin"),
      /No such statusTileExamples resource/,
    );
    plugin.stop();
  });

  test("getResource throws when stopped", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    const provider = app.getProviders()[0];
    plugin.stop();

    await assert.rejects(
      provider.methods.getResource("signalk-internet"),
      /No such statusTileExamples resource/,
    );
  });

  test("setResource and deleteResource throw (read-only)", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    const provider = app.getProviders()[0];

    await assert.rejects(provider.methods.setResource(), /read-only provider/);
    await assert.rejects(
      provider.methods.deleteResource(),
      /read-only provider/,
    );
    plugin.stop();
  });

  test("registers the provider at most once across a restart", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.stop();
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    plugin.stop();
    const examples = app
      .getProviders()
      .filter((p) => p.type === "statusTileExamples");
    assert.strictEqual(examples.length, 1);
  });

  test("does not crash and logs once when the server has no registry", () => {
    const app = createMockApp({ withRegistry: false });
    const plugin = pluginFactory(app);
    assert.doesNotThrow(() =>
      plugin.start({ pollInterval: 60, probe: fakeProbe }),
    );
    assert.ok(
      app.getErrors().some((e) => e.includes("resource provider registry")),
      "expected a single disabled-log line",
    );
    plugin.stop();
  });
});
