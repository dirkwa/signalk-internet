# Technical Work Document: `@meri-imperiumi/signalk-internet`

**Package Identifier:** `@meri-imperiumi/signalk-internet`

**License Compatibility:** EUPL-1.2 (Zero external runtime dependencies; uses native Node.js APIs)

**Target Architecture:** Offline-first, event-driven aggregator with fallback active probing and vanilla Web Component UI.

---

## 1. Executive Summary & Goals

Many Signal K plugins perform internet-dependent operations (fetching weather GRIBs, uploading logbooks, syncing telemetry). Currently, each plugin implements its own polling, backoff, and retry mechanisms. When the vessel loses internet, multiple plugins independently slam local routers with failed requests, wasting CPU cycles and battery power.

`@meri-imperiumi/signalk-internet` centralizes internet state detection. It acts as a **system-wide breaker**, publishing a unified Signal K delta that downstream plugins consume via Pub/Sub. When the vessel goes offline or switches to a metered connection, downstream plugins receive immediate notification to pause heavy operations, cache data, and sleep.

---

## 2. Signal K Data Schema

The plugin broadcasts under a custom `network.internet` namespace. To keep the history database clean and avoid spamming the bus, speed test results are explicitly omitted from the delta stream and kept strictly as point-in-time API responses.

| Signal K Path | Type | Values / Units | Description |
| --- | --- | --- | --- |
| `network.internet.state` | `string` | `online`, `offline`, `metered`, `captive` | Unified global internet connectivity state. |
| `network.internet.ping` | `number` | `ms` | Round-trip latency to verification endpoint. |

When the plugin stops, both paths are published as `null`: no value means nobody is reporting on the link.

### Delta Payload Example

```json
{
  "updates": [
    {
      "values": [
        { "path": "network.internet.state", "value": "metered" },
        { "path": "network.internet.ping", "value": 120 }
      ]
    }
  ]
}

```

---

## 3. Priority Rules Engine & Architecture

The plugin evaluates connection state using a top-down deterministic rules engine. The first matching rule sets the global state:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Manual Override (PUT /override endpoint or Web UI toggle)│
└──────────────────────────────┬──────────────────────────────┘
                               │ (if null)
┌──────────────────────────────▼──────────────────────────────┐
│ 2. State Heuristics (e.g., watch.state.onWatch === true)     │
└──────────────────────────────┬──────────────────────────────┘
                               │ (if no match)
┌──────────────────────────────▼──────────────────────────────┐
│ 3. Hardware Mappings (Starlink status, LTE SIM operator)    │
└──────────────────────────────┬──────────────────────────────┘
                               │ (if no match)
┌──────────────────────────────▼──────────────────────────────┐
│ 4. Active Probing / Fallback Timer Loop (DNS / HTTP probe)   │
└──────────────────────────────┬──────────────────────────────┘
                               │ (if unreachable)
                               ▼
                          ['offline']

```

### Evaluation Order

1. **Manual Override:** Forced setting via REST/Web UI (e.g., force `metered` for an offshore passage).
2. **Contextual Heuristics:** Inferred vessel state (e.g., if `watch.state.onWatch` is `true`, assume offshore and set to `metered`).
3. **Hardware Mappings:** Match specific Signal K deltas from per-uplink plugins (e.g., `@meri-imperiumi/signalk-teltonika-rutx11`, `signalk-starlink`).
4. **Active Verification & Fallback Timer:** If no hardware state matches, the plugin falls back to an active polling loop (e.g., every 30s) testing DNS resolution and a configurable captive-portal endpoint: Apple's HTTPS hotspot-detect (default, body-marker check) or Google's plain-HTTP 204 connectivity check. With **No probe** selected, this layer is skipped entirely and the hardware mappings alone decide the state.

---

## 4. Hardware Uplink Integration (Event-Driven vs. Timer Loop)

To minimize detection latency and avoid unnecessary timer churn:

* **Event-Driven Instant Down:** Subscribes to upstream hardware paths using `app.subscriptionManager`. If an uplink plugin reports `down` or `disconnected`, the state transitions to `offline` with 0ms delay.
* **Targeted Up Verification:** When an uplink flips to `connected`, the plugin fires a single targeted HTTP probe to confirm actual internet routing before publishing `online` or `captive`.
* **Adaptive Timer Loop:** The periodic probe cadence adapts to the resolved state. Without a matching hardware mapping (or while `offline`) the fast Fallback Ping Interval applies, since the probe is then the only state detector. While a hardware mapping reports the uplink up, re-verification slows to the Online Re-verification Interval, and slows further to the Metered Re-verification Interval while the state is `metered` or `captive` to conserve metered data. No periodic probe runs while a manual `offline` override is active or a hardware mapping resolves the uplink as down.

---

## 5. Plugin Configuration Schema

```json
{
  "type": "object",
  "properties": {
    "pollInterval": {
      "type": "integer",
      "title": "Fallback Ping Interval (seconds)",
      "default": 30
    },
    "onlineVerifyInterval": {
      "type": "integer",
      "title": "Online Re-verification Interval (seconds)",
      "default": 300
    },
    "meteredVerifyInterval": {
      "type": "integer",
      "title": "Metered Re-verification Interval (seconds)",
      "default": 600
    },
    "stateHeuristics": {
      "type": "array",
      "title": "Contextual State Rules",
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "title": "Signal K Path" },
          "triggerValue": { "type": "string", "title": "Trigger Value" },
          "resultingState": { "type": "string", "enum": ["online", "metered", "offline"] }
        }
      }
    },
    "connectionMappings": {
      "type": "array",
      "title": "Hardware Delta Mappings",
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "title": "Hardware Path" },
          "matchValue": { "type": "string", "title": "Value to Match" },
          "resultingState": { "type": "string", "enum": ["online", "metered", "offline"] }
        }
      }
    }
  }
}

```

---

## 6. Server REST API Specification

| Method | Endpoint | Description |
| --- | --- | --- |
| `PUT` | `/plugins/signalk-internet/override` | Sets or clears manual state override (`{ "forceMetered": true | false | null }`). |
| `POST` | `/plugins/signalk-internet/speedtest` | Triggers a server-side download test (pulls max 5MB via `https` from CDN). **Hard Guard:** Returns `403 Forbidden` if current state is `metered`, and `409 Conflict` if `offline`, protecting expensive satellite bandwidth. |

---

## 7. Web UI & History Integration

The plugin embeds a buildless frontend served from its `/public` directory:

* **Technology:** Native Web Components (`customElements`) and vanilla ES Modules.
* **Status Dashboard (`status-card.js`):** Shows live state and controls for manual override. Dynamically disables the server-side speed test button when the Signal K stream reports `metered` or `offline` to prevent accidental bandwidth usage.
* **Timeline View (`history-log.js`):** Queries the standard Signal K v2 History API (`/signalk/v2/api/history/values?paths=network.internet.state`) to render connection history without needing a custom database engine. Integrates seamlessly with setups running `signalk-history-sqlite`.

---

## 8. Package Directory Structure

```text
@meri-imperiumi/signalk-internet/
├── index.js              # Plugin entry point & lifecycle manager
├── package.json          # Signal K plugin manifest
├── lib/
│   ├── evaluator.js      # Rules engine logic & stream state cache
│   ├── prober.js         # Native DNS / HTTP captive portal checks
│   └── speedtest.js      # Node.js native HTTPS speed test with metered guards
└── public/
    ├── index.html        # Web UI mounting point
    ├── app.js            # Frontend module entry point
    └── components/
        ├── status-card.js # Live status, dynamic UI guards & override toggle
        └── history-log.js # Timeline component querying v2 History API

```
