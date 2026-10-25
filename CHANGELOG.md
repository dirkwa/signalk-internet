# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A **Connectivity Probe** pulldown in the plugin configuration (#2): **Apple** (default, unchanged), **Google**, or **No probe**. Google sends a plain HTTP request to `connectivitycheck.gstatic.com/generate_204` and expects status 204 — no TLS handshake and no response body, cheaper on metered uplinks, and captive-portal redirects are detected as HTTP 3xx instead of TLS certificate failures. **No probe** never contacts an outside service: the state is taken on trust from hardware mappings (Starlink, modem status) and contextual rules alone, defaulting to `offline` when none matches, and manual overrides are gated on the hardware mappings.

### Fixed

- **The state no longer outlives the plugin.** Signal K keeps a path's last value after the plugin that published it stops, so disabling the plugin while the link was `metered` or `offline` left that state in place until the server restarted, and plugins that pause downloads on it stayed paused. Stopping now publishes `null` for `network.internet.state` and `network.internet.ping`, and a probe still in flight when the plugin stops no longer publishes its result afterwards.

### Changed

- Probing internals are provider-based: the probe resolves the selected provider's hostname and decides online/captive from the HTTP status (Google) or response body (Apple), using `node:http` for plain-HTTP endpoints and never following redirects.

## [0.7.1] - 2026-10-18

## [0.7.0] - 2026-10-11

### Changed
- Periodic probing is now adaptive instead of a fixed 30-second timer (#1). While no hardware mapping matches, or the state is `offline`, the existing Fallback Ping Interval applies. While a hardware mapping reports the uplink up, re-verification slows to a new Online Re-verification Interval (default 300 seconds), and slows further to a new Metered Re-verification Interval (default 600 seconds) while the state is `metered` or `captive`, conserving metered data. Hardware down-transitions were already instant via the delta stream and remain so.
- Timer-driven probes no longer run — or spend probe data — when a manual `offline` override is active or a hardware mapping resolves the uplink as offline. They also now respect a reachability-gated override (`online`/`metered`/`captive`) instead of silently publishing the raw probe state over the user's forced state.
- The README documents the probe cadence and its per-probe data cost.

## [0.6.0] - 2026-09-29

### Added
- Recommends the new `signalk-starlink-offshore` companion plugin, which
  publishes `navigation.maritimeZone` (`territorial-sea`,
  `internal-waters`, `land`, or `high-seas`). A new shipped default
  heuristic clamps the internet state to `metered` while the vessel is
  on the high seas, where Starlink switches to its metered ocean data
  plan; territorial waters and inland sailing stay on the default
  unlimited plan. The shipped Status Tiles example tile now shows the
  maritime zone in its footer.

## [0.5.0] - 2026-08-28

### Added
- Ships a ready-made Status Tiles example set discoverable by the
  Status Tiles webapp for one-tap copy. The plugin registers a read-only
  `statusTileExamples` resource provider in `start()` (gated by the
  running state and idempotent per instance, returning `{}` when stopped
  so a disabled plugin leaves no stale entries). The set contains a
  single `internet` tile mapping `network.internet.state` to
  green/amber/red/neutral, with footer context from the plugin's own
  ping path plus the recommended Starlink/LTE companion paths.

## [0.4.0] - 2026-08-27

### Added
- Speed-test results are now **recorded and shown in the connection
  history**: every successful speed test publishes a
  `network.internet.speed.download` delta (bit/s, with `meta` units), so
  results land in whatever history provider stores the connection
  history — no custom database. The webapp's connection history queries
  the new path alongside the state and renders each recorded test in the
  event console (`[ 7.3 Mbit/s ]`), and the status card shows the last
  measured download speed live.
- The webapp now visually indicates a lost Signal K stream: a flat red
  `SIGNAL LOST — RECONNECTING` banner appears when the WebSocket drops.

### Changed
- Updated the webapp to the revised "Tactical Sci-Fi" UI spec: the
  day/night theme now uses per-mode intensity-shifted semantic colors
  (bright/saturated day, dimmed night) over a constant dark canvas
  instead of dimming the background; panel edges and ultra-faint theme
  tints are derived from the theme color via
  `rgba(var(--theme-color-rgb), …)` so they follow the active mode; and
  the connection-history event list is now a 3-column pseudo-console
  (`Timestamp | Message | Status`) with right-aligned bracketed statuses
  in monospace, `YYYY-MM-DD HH:mm` local ship-time timestamps without a
  timezone suffix, and a 50-line render cap.
- WebSocket subscriptions now request a `minRate` floor (1s) and
  reconnect with exponential backoff (1s doubling to a 30s cap, reset on
  a successful open) instead of a fixed 5s retry.
- Units are no longer hardcoded in the webapp: the ping and speed
  readouts read `meta.units` from the Signal K tree and scale values with
  SI prefixes (`7,340,000 bit/s` → `7.3 Mbit/s`) via a shared,
  unit-tested `format.js` helper.

## [0.3.0] - 2026-08-26
### Changed
- Restyled the plugin webapp (status card + connection history) to the
  "Tactical Sci-Fi" Signal K UI spec: dark canvas with the semantic-neon
  color system, flat geometry with corner-bracket framing, hardware-style
  inputs and bracket toggle buttons, monospace tabular-numeric telemetry,
  48px touch targets, and a fluid single-column-to-grid layout. The override
  control is now a select + explicit `[ Apply ]` button (enabled only when the
  selection differs from the applied value) so a stray tap can't change
  connectivity policy. The page now also passively listens to `vessels.self.environment.mode` and
  reflects `day`/`night` onto `<html data-mode>` for night-mode dimming.

## [0.2.0] - 2026-08-23

### Added
- `negate` option on contextual heuristic and hardware mapping rules to
  match when a string value **differs** from the configured trigger/match
  value (a NOT matcher). Lets you treat e.g. any LTE operator other than
  "No service" as `online`.
- Default contextual heuristic: while a watch schedule is running
  (`watch.state.onWatch === true`) the state is assumed `metered`, so
  downstream plugins hold off on bandwidth-heavy work offshore. Shipped
  as a pre-seeded `stateHeuristics` default; clear or edit the list to
  opt out.

### Changed
- Heuristics are now **modifiers**, not verdicts: they refine a
  reachability base that the hardware mapping / active probe establishes
  first, and can only make it more severe (`online < metered < captive <
  offline`). A "metered when on watch" rule no longer reports `metered`
  when the uplink is actually down — it stays `offline`.
- Manual overrides are now reachability-gated for non-`offline` states.
  Forcing `online`/`metered`/`captive` is honored only when the probe
  confirms a connection; with no uplink the state falls back to `offline`
  rather than claiming connectivity that isn't there. Forcing `offline`
  remains absolute and synchronous. The speed-test guard still honors an
  override's intent immediately (forced `metered` -> 403, forced `offline`
  -> 409) without waiting for the probe.
- Internal `probe` injection: `start({ probe })` lets tests inject a fake
  probe so the suite is deterministic and never hits the network.

## [0.1.0] - 2026-08-23

### Added
- Initial version
