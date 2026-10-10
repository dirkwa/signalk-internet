# Internet Connectivity Monitor for Signal K

This plugin serves as an internet connectivity monitor for Signal K. Many Signal K plugins interact with internet-based services, and this plugin provides the necessary deltas for them to know if the boat is connected or not.

* `network.internet.state`: `online`, `offline`, `metered`
* `network.internet.ping`: round-trip ping time to a verification endpoint

In addition to its own detection logic, the plugin can read status from uplink-specific provider plugins. Examples:

* signalk-starlink sets `network.providers.starlink.status` to `online` when Starlink is connected
* signalk-starlink-offshore sets `navigation.maritimeZone` to `territorial-sea`, `internal-waters`, `land`, or `high-seas`. The plugin ships a rule marking Starlink as `metered` while on the high seas (ocean data), keeping the default plan in territorial waters.
* signalk-teltonika-rutx provides operator name in `networking.lte.connectionText`. You can set different operators as `online` or `metered`

## Probing cadence

The plugin re-verifies the uplink with an active probe (a DNS lookup followed by a small HTTPS request to Apple's captive-portal detection endpoint) at a cadence that adapts to the situation:

* No hardware mapping matches, or the state is `offline`: the **Fallback Ping Interval** (default 30 seconds). Without a hardware mapping the probe is the only state detector, so outages and recoveries must be noticed quickly. With a hardware mapping, its down-transition already arrives instantly over the Signal K delta stream, so while offline this interval merely retries verification.
* A hardware mapping reports the uplink up and the state is `online`: the **Online Re-verification Interval** (default 300 seconds). This slow cadence only guards against a modem that stays "up" but stops routing.
* The state is `metered` or `captive`: the **Metered Re-verification Interval** (default 600 seconds) — deliberately slower than the online cadence to conserve expensive metered data.

Each probe costs a few kilobytes of traffic (the TLS handshake dominates; the response body is under 100 bytes), so at the 30-second fallback cadence probing works out to roughly 15 MB per day. That is why re-verification while a hardware mapping reports the uplink up is much slower. On very tight uplinks, raise all three intervals in the plugin configuration.

No periodic probe runs at all while a manual `offline` override is active or a hardware mapping resolves the uplink as down — those states are authoritative and cost zero probe traffic.
