/**
 * Priority rules engine for internet connectivity state.
 *
 * The engine resolves a connectivity state top-down:
 *
 *   1. Manual override (forced by REST / Web UI). `offline` is absolute;
 *      any other override is reachability-gated so it can't claim a
 *      connection that isn't there.
 *   2. Hardware instant-down (a mapping resolving to `offline`)
 *   3. Reachability base (hardware "up" mapping -> verify probe, else
 *      active probing fallback)
 *   4. Contextual heuristics refine the resolved base
 *
 * Heuristics are **modifiers**, not verdicts: they refine a base state
 * that has first been established by reachability. A heuristic can only
 * make the state more severe (down the ladder
 * `online < metered < captive < offline`), never better, so "metered"
 * is never reported when there is in fact no internet. The classic case is
 * a watch schedule: `online` (Starlink reachable) + on-watch -> `metered`,
 * while on-watch with the dish down stays `offline`. The same principle
 * gates a manual `online`/`metered`/`captive` override: forcing metered
 * means "metered if reachable, else offline."
 *
 * Hardware and heuristic rules feed off the live Signal K delta stream
 * cache maintained by the plugin; the evaluator exposes a `set` method to
 * push cached path values into it. When a hardware rule flips its uplink
 * to "down" the engine transitions to offline with zero delay; when it
 * flips to "up" the engine requests a single targeted probe to confirm
 * actual routing before publishing online.
 *
 * @file evaluator.js
 */

/**
 * Valid global connectivity states.
 * @typedef {"online"|"offline"|"metered"|"captive"} InternetState
 */

/**
 * Default connectivity state when nothing is known.
 */
const DEFAULT_STATE = "offline";

/**
 * Severity ordering used by heuristic refinement: a matching heuristic
 * can only clamp the base state down this ladder, never up it. `offline`
 * is the floor so a "metered when on watch" rule never lies about having
 * internet when the uplink is actually down.
 *
 * @type {Record<InternetState, number>}
 */
const SEVERITY = {
  online: 0,
  metered: 1,
  captive: 2,
  offline: 3,
};

/**
 * Creates a new evaluator instance.
 *
 * @param {Object} options
 * @param {Object} options.config - Plugin configuration
 * @param {Function} [options.onState] - Called with the new state when it
 *   changes (signature: `(state, ping|null) => void`)
 * @param {Function} [options.probe] - Active probe function
 *   `(options) => Promise<{state, ping}>`; defaults to no-op
 */
function createEvaluator({ config, onState, probe } = {}) {
  /** @type {InternetState} */
  let state = DEFAULT_STATE;

  /** @type {number|null} */
  let ping = null;

  /** @type {InternetState|null} */
  let override = null;

  /** Path -> last seen value, fed by the delta stream */
  const streamCache = new Map();

  /**
   * Reads a numeric or string value for a path from the cache.
   * @param {string} path
   * @returns {unknown}
   */
  function get(path) {
    return streamCache.get(path);
  }

  /**
   * Returns the current resolved state and ping.
   * @returns {{state: InternetState, ping: number|null}}
   */
  function current() {
    return { state, ping };
  }

  /**
   * Sets or clears the manual override. Triggers a re-evaluation.
   *
   * @param {InternetState|null} value - State to force, or null to clear
   */
  function setOverride(value) {
    override = value;
    reevaluate();
  }

  /**
   * Returns the current manual override (null when not overridden).
   */
  function getOverride() {
    return override;
  }

  /**
   * Updates a cached stream value and re-evaluates if the path is watched
   * by a heuristic or hardware rule.
   *
   * @param {string} path - Signal K path
   * @param {unknown} value - Value (or null to remove)
   */
  function set(path, value) {
    if (value === null || value === undefined) {
      streamCache.delete(path);
    } else {
      streamCache.set(path, value);
    }
    if (isWatched(path)) {
      reevaluate();
    }
  }

  /**
   * Whether any configured rule reads this path.
   * @param {string} path
   * @returns {boolean}
   */
  function isWatched(path) {
    const heuristics = config.stateHeuristics || [];
    const mappings = config.connectionMappings || [];
    return (
      heuristics.some((r) => r.path === path) ||
      mappings.some((r) => r.path === path)
    );
  }

  /**
   * Evaluates the rule engine and updates the state, publishing via
   * `onState` when it changes.
   *
   * Order:
   *   1. Manual override:
   *      - `offline` is absolute and synchronous (it's the floor; forcing
   *        it can never lie).
   *      - `online`/`metered`/`captive` are reachability-gated: a probe
   *        runs, and if the uplink is actually down we publish `offline`
   *        rather than claiming a connection we don't have. So "force
   *        metered" means "metered if reachable, else offline."
   *   2. A hardware mapping resolving to `offline` is an event-driven
   *      instant down (0ms, no probe) — kept above heuristics so an
   *      explicit "disconnected" always wins immediately.
   *   3. Reachability base: a hardware "up" mapping triggers a targeted
   *      verify probe; otherwise the active probe fallback runs. The
   *      base is the probe's result (left untouched until it resolves so
   *      we never flicker to a wrong intermediate value).
   *   4. Heuristic refinement: matching heuristics clamp the base down the
   *      severity ladder (online < metered < captive < offline), never up,
   *      so a "metered when on watch" rule only applies when we actually
   *      have internet.
   *
   * Ping is carried from the probe when one ran; null for the synchronous
   * override-offline and instant-down paths.
   *
   * @returns {void}
   */
  function reevaluate() {
    // 1. Manual override. `offline` is absolute; any other override is
    //    reachability-gated so it can't claim connectivity that isn't
    //    there.
    if (override !== null) {
      if (override === "offline") {
        publish("offline", null);
        return;
      }
      triggerProbe();
      return;
    }

    // 2. Hardware instant-down: an explicit offline mapping publishes
    //    synchronously with no probe, no delay.
    const hardware = matchHardware();
    if (hardware?.state === "offline") {
      publish("offline", null);
      return;
    }

    // 3. Reachability base. A hardware "up" mapping still gets verified
    //    by a targeted probe (don't trust modem-up-but-no-internet); with
    //    no mapping the active probe fallback runs. Either way the base
    //    resolves asynchronously and is then refined by heuristics.
    triggerProbe();
  }

  /**
   * Tests whether a cached value matches a rule's expected value,
   * honoring an optional `negate` flag for a NOT variant.
   *
   * A rule without `negate` matches when the cached value equals the
   * configured one (e.g. `matchValue: "online"`). With `negate: true` it
   * matches when the value is present and differs (e.g.
   * `matchValue: "No service", negate: true` matches any operator
   * other than "No service"). An absent/undefined value never matches:
   * a NOT rule still needs a value to negate against, otherwise the
   * path is treated as unconfigured and lower-priority rules run.
   *
   * @param {unknown} value - Cached stream value
   * @param {string} expected - Rule's configured trigger/match value
   * @param {boolean} [negate] - Invert the equality check
   * @returns {boolean}
   */
  function valueMatches(value, expected, negate) {
    if (value === undefined) return false;
    const equal = String(value) === String(expected);
    return negate ? !equal : equal;
  }

  /**
   * Finds the first matching hardware uplink mapping.
   *
   * @returns {{state: InternetState}|null}
   */
  function matchHardware() {
    const rules = config.connectionMappings || [];
    for (const rule of rules) {
      if (!rule.path) continue;
      const value = get(rule.path);
      if (valueMatches(value, rule.matchValue, rule.negate)) {
        return { state: rule.resultingState };
      }
    }
    return null;
  }

  /**
   * State of the first matching hardware uplink mapping, or null when no
   * mapping matches (the active probe is then the only state detector).
   * Used by the plugin's adaptive probe timer to pick the re-verification
   * cadence.
   *
   * @returns {InternetState|null}
   */
  function hardwareState() {
    return matchHardware()?.state ?? null;
  }

  /**
   * Triggers an active probe and publishes the resolved state, picking
   * the publish rule from the live override at resolve time:
   *
   *   - no override: publish the probe result refined by matching
   *     heuristics (the normal reachability path).
   *   - override `offline`: handled synchronously in `reevaluate`, never
   *     reaches here.
   *   - override `online`/`metered`/`captive`: publish the override state
   *     unless the probe found no connectivity, in which case publish
   *     `offline`. This gates non-offline overrides on actual
   *     reachability so they can't claim a connection that isn't there.
   *
   * Reading the override at resolve time (rather than capturing it when
   * the probe starts) means an override set while a probe is already in
   * flight is still honored — the in-flight probe publishes under the
   * new override instead of being dropped by the re-entrancy guard.
   *
   * Re-entrancy guard: only one probe in flight at a time. The probe
   * result is authoritative — a hardware "up" mapping only triggers the
   * verify, it doesn't override what the probe finds.
   *
   * @returns {Promise<void>}
   */
  let probing = false;
  async function triggerProbe() {
    if (!probe || probing) return;
    probing = true;
    try {
      const result = await probe();
      if (override === "offline") {
        // An absolute offline override wins even over an in-flight probe
        // that started before it was set; ignore the probe result.
        publish("offline", null);
      } else if (override) {
        // A non-offline override is honored only when reachable.
        publish(result.state === "offline" ? "offline" : override, result.ping);
      } else {
        publish(refine(result.state), result.ping);
      }
    } finally {
      probing = false;
    }
  }

  /**
   * Applies matching heuristics as severity clamps on a resolved base
   * state. A heuristic can only make the state more severe
   * (`online < metered < captive < offline`), never better, so it can't
   * claim connectivity the base didn't establish.
   *
   * @param {InternetState} base - Probe-resolved reachability
   * @returns {InternetState}
   */
  function refine(base) {
    let refined = base;
    for (const rule of config.stateHeuristics || []) {
      if (!rule.path) continue;
      const value = get(rule.path);
      if (!valueMatches(value, rule.triggerValue, rule.negate)) continue;
      if (SEVERITY[rule.resultingState] > SEVERITY[refined]) {
        refined = rule.resultingState;
      }
    }
    return refined;
  }

  /**
   * Forces a fresh probe regardless of cached rule state. Used by the
   * adaptive timer loop and the "up verification" path after a hardware
   * uplink reports connected. The result is refined by heuristics.
   *
   * Two short-circuits avoid spending probe data when the outcome is
   * already known:
   *
   *   - a manual `offline` override is absolute, so no probe is needed
   *   - a hardware mapping resolving to `offline` is event-driven and
   *     authoritative; probing behind its back would only burn data and
   *     could contradict the instant-down it published
   *
   * When the override is a reachability-gated state
   * (`online`/`metered`/`captive`), the probe result is published under
   * the override — the same rule as `triggerProbe` — so a periodic
   * re-verification cannot silently clear a user's forced state while
   * still demoting to `offline` when the uplink actually went away.
   */
  async function forceProbe() {
    if (!probe) return;
    if (override === "offline" || matchHardware()?.state === "offline") {
      publish("offline", null);
      return;
    }
    probing = true;
    try {
      const result = await probe();
      if (override === "offline") {
        // An override set while the probe was in flight still wins.
        publish("offline", null);
      } else if (override) {
        publish(result.state === "offline" ? "offline" : override, result.ping);
      } else {
        publish(refine(result.state), result.ping);
      }
    } finally {
      probing = false;
    }
  }

  /**
   * Publishes a state change if it differs from the current one. Ping is
   * always carried along (null when unknown).
   *
   * @param {InternetState} newState
   * @param {number|null} newPing
   */
  function publish(newState, newPing) {
    if (newState === state && newPing === ping) return;
    state = newState;
    ping = newPing;
    if (onState) onState(state, ping);
  }

  return {
    current,
    set,
    setOverride,
    getOverride,
    reevaluate,
    forceProbe,
    hardwareState,
    // Exposed for tests / introspection
    _matchHardware: matchHardware,
    _refine: refine,
    _cache: streamCache,
  };
}

module.exports = {
  createEvaluator,
  DEFAULT_STATE,
  SEVERITY,
};
