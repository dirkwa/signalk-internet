# Internet Connectivity Monitor for Signal K

This plugin serves as an internet connectivity monitor for Signal K. Many Signal K plugins interact with internet-based services, and this plugin provides the necessary deltas for them to know if the boat is connected or not.

* `network.internet.state`: `online`, `offline`, `metered`
* `network.internet.ping`: round-trip ping time to a verification endpoint

In addition to its own detection logic, the plugin can read status from uplink-specific provider plugins. Examples:

* signalk-starlink sets `network.providers.starlink.status` to `online` when Starlink is connected
* signalk-starlink-offshore sets `navigation.maritimeZone` to `territorial-sea`, `internal-waters`, `land`, or `high-seas`. The plugin ships a rule marking Starlink as `metered` while on the high seas (ocean data), keeping the default plan in territorial waters.
* signalk-teltonika-rutx provides operator name in `networking.lte.connectionText`. You can set different operators as `online` or `metered`

## Probing

The plugin re-verifies the uplink with an active probe (a DNS lookup followed by a small captive-portal detection request) at a cadence that adapts to the situation. The **Connectivity Probe** setting in the plugin configuration chooses the verification method:

* **Apple** (default): a small HTTPS request to `captive.apple.com/hotspot-detect.html`, with the response body checked for the expected success marker.
* **Google**: a plain HTTP request to `connectivitycheck.gstatic.com/generate_204` expecting status `204 No Content`. No TLS handshake and no response body, so it is the cheapest option on metered uplinks. Redirects are never followed, so a captive portal's redirect is detected as such instead of failing a TLS certificate check.
* **No probe**: the plugin never contacts an outside service. The state is taken on trust from the hardware mappings (Starlink, modem status) and contextual rules alone, defaulting to `offline` when no mapping matches. Manual overrides are still gated on the hardware mappings.

The probe runs at a cadence that adapts to the situation:

* No hardware mapping matches, or the state is `offline`: the **Fallback Ping Interval** (default 30 seconds). Without a hardware mapping the probe is the only state detector, so outages and recoveries must be noticed quickly. With a hardware mapping, its down-transition already arrives instantly over the Signal K delta stream, so while offline this interval merely retries verification.
* A hardware mapping reports the uplink up and the state is `online`: the **Online Re-verification Interval** (default 300 seconds). This slow cadence only guards against a modem that stays "up" but stops routing.
* The state is `metered` or `captive`: the **Metered Re-verification Interval** (default 600 seconds) — deliberately slower than the online cadence to conserve expensive metered data.

Each Apple probe costs a few kilobytes of traffic (the TLS handshake dominates; the response body is under 100 bytes), while a Google probe is a fraction of that (plain HTTP, empty 204 response), so at the 30-second fallback cadence probing works out to at most roughly 15 MB per day. That is why re-verification while a hardware mapping reports the uplink up is much slower. On very tight uplinks, switch to the Google probe, raise all three intervals, or pick **No probe** in the plugin configuration.

No periodic probe runs at all while a manual `offline` override is active or a hardware mapping resolves the uplink as down — those states are authoritative and cost zero probe traffic.

## On the chart

In chart plotters that support [Plotter Extensions](https://github.com/SignalK/freeboard-sk/blob/master/docs/api/plotter-extensions-api.md), such as Freeboard-SK, the plugin adds an **Internet** button (a satellite dish) to the map toolbar. It opens a small window with the current state, the manual override (**Auto**, **Online**, **Metered**, **Offline**) and the connection values: ping, the last speed test, and the Starlink status, throughput and latency and the maritime zone when signalk-starlink and signalk-starlink-offshore are running. The button turns to a warning while the state is `metered` or `captive` and to an alarm while `offline`, so a costly or lost connection shows without opening the window. Switching the override goes through the plugin's REST API, which the server reserves for administrators.

The extension pages use the [signalk-plotterext-bus](https://github.com/joelkoz/signalk-plotterext-bus) client, bundled into `public/plotterext/vendor/` so the plugin keeps shipping without a build step. After bumping that devDependency, refresh the bundle with `npm run vendor:plotterext`.
