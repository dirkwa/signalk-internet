const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const pluginFactory = require("../index.js");
const pkg = require("../package.json");

/** Deterministic fake probe so the suite never touches the network. */
const fakeProbe = async () => ({ state: "online", ping: 5 });

function createMockApp() {
  const providers = [];
  return {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    subscriptionmanager: { subscribe: () => {} },
    handleMessage: () => {},
    registerResourceProvider: (provider) => providers.push(provider),
    provider: (type) => providers.find((p) => p.type === type),
  };
}

/** Maps a manifest URL to the file the server serves for it. */
function publicFile(url) {
  const prefix = `/${pkg.name}/`;
  assert.ok(url.startsWith(prefix), `${url} is under ${prefix}`);
  return join(__dirname, "..", "public", url.slice(prefix.length));
}

describe("plotterExtensions provider", () => {
  test("lists the manifest while running and nothing once stopped", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    const provider = app.provider("plotterExtensions");

    assert.deepStrictEqual(await provider.methods.listResources(), {
      "signalk-internet": pluginFactory.PLOTTER_EXTENSION,
    });
    assert.strictEqual(
      await provider.methods.getResource("signalk-internet"),
      pluginFactory.PLOTTER_EXTENSION,
    );

    plugin.stop();
    assert.deepStrictEqual(await provider.methods.listResources(), {});
    await assert.rejects(
      provider.methods.getResource("signalk-internet"),
      /No such plotterExtensions resource/,
    );
  });

  test("is read-only", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ pollInterval: 60, probe: fakeProbe });
    const provider = app.provider("plotterExtensions");
    await assert.rejects(provider.methods.setResource(), /read-only provider/);
    await assert.rejects(
      provider.methods.deleteResource(),
      /read-only provider/,
    );
    plugin.stop();
  });
});

describe("plotter extension manifest", () => {
  const manifest = pluginFactory.PLOTTER_EXTENSION;

  test("targets API version 1 with the package version", () => {
    assert.strictEqual(manifest.apiVersion, "1");
    assert.strictEqual(manifest.version, pkg.version);
  });

  test("the toolbar button opens a panel of this manifest", () => {
    const panelIds = manifest.panels.map((p) => p.id);
    for (const button of manifest.buttons) {
      assert.ok(panelIds.includes(button.action.panel), button.id);
    }
  });

  test("every page it points at ships in public/", () => {
    const urls = [...manifest.panels, ...manifest.background].map((c) => c.url);
    for (const url of urls) {
      assert.ok(existsSync(publicFile(url)), url);
    }
  });
});

describe("plotter extension view helpers", () => {
  let view;
  before(async () => {
    view = await import("../public/plotterext/view.js");
  });

  test("labels known states and falls back to Unknown", () => {
    assert.strictEqual(view.stateLabel("metered"), "Metered");
    assert.strictEqual(view.stateLabel(undefined), "Unknown");
  });

  test("decorates the button by cost: warning when metered, alarm offline", () => {
    assert.strictEqual(view.buttonStyle("online"), "normal");
    assert.strictEqual(view.buttonStyle("metered"), "warning");
    assert.strictEqual(view.buttonStyle("captive"), "warning");
    assert.strictEqual(view.buttonStyle("offline"), "alarm");
    assert.strictEqual(view.buttonStyle(null), "normal");
  });

  test("formats rows in their units", () => {
    const row = (path) => view.ROWS.find((r) => r.path === path);
    assert.strictEqual(
      view.formatRow(row("network.internet.ping"), 41.6),
      "42 ms",
    );
    assert.strictEqual(
      view.formatRow(
        row("network.providers.starlink.downlink_throughput"),
        20980848,
      ),
      "21 Mbit/s",
    );
    assert.strictEqual(
      view.formatRow(row("navigation.maritimeZone"), "high-seas"),
      "high-seas",
    );
    assert.strictEqual(view.formatRow(row("network.internet.ping"), null), "—");
  });

  test("offers Auto plus the online, metered and offline overrides", () => {
    assert.deepStrictEqual(
      view.OVERRIDE_CHOICES.map(([value]) => value),
      ["", "online", "metered", "offline"],
    );
  });
});
