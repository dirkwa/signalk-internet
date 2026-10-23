/**
 * Pure view helpers shared by the chart plotter extension pages: which
 * Signal K values the status window lists, how each one reads, and how
 * the toolbar button is decorated for each connectivity state.
 *
 * No DOM and no host calls, so they are unit-testable in Node.
 *
 * @file plotterext/view.js
 */

import { formatSI } from "../format.js";

/** Connectivity state published by this plugin. */
const STATE_PATH = "network.internet.state";

const STATE_LABELS = {
  online: "Online",
  offline: "Offline",
  metered: "Metered",
  captive: "Captive portal",
};

/**
 * Override choices offered in the window, in display order. An empty
 * value clears the override (automatic detection).
 */
const OVERRIDE_CHOICES = [
  ["", "Auto"],
  ["online", "Online"],
  ["metered", "Metered"],
  ["offline", "Offline"],
];

/**
 * Values listed under the state. A row stays hidden until its path has
 * a value, so the Starlink and maritime-zone rows only appear when
 * signalk-starlink or signalk-starlink-offshore is running.
 */
const ROWS = [
  { path: "network.internet.ping", label: "Ping", unit: "ms" },
  {
    path: "network.internet.speed.download",
    label: "Last speed test",
    unit: "bit/s",
  },
  { path: "network.providers.starlink.status", label: "Starlink" },
  {
    path: "network.providers.starlink.downlink_throughput",
    label: "Starlink down",
    unit: "bit/s",
  },
  {
    path: "network.providers.starlink.uplink_throughput",
    label: "Starlink up",
    unit: "bit/s",
  },
  {
    path: "network.providers.starlink.latency",
    label: "Starlink latency",
    unit: "ms",
  },
  { path: "navigation.maritimeZone", label: "Maritime zone" },
];

/**
 * @param {string|null|undefined} state
 * @returns {string} Display label for a connectivity state
 */
function stateLabel(state) {
  return STATE_LABELS[state] || "Unknown";
}

/**
 * Formats one row's value for display.
 *
 * @param {{unit?: string}} row
 * @param {unknown} value
 * @returns {string}
 */
function formatRow(row, value) {
  if (value == null) return "—";
  if (row.unit === "ms") {
    return typeof value === "number" ? `${Math.round(value)} ms` : "—";
  }
  if (row.unit) {
    return typeof value === "number" ? formatSI(value, row.unit) : "—";
  }
  return String(value);
}

/**
 * Toolbar button decoration for a connectivity state: `warning` while
 * data costs money or is held by a portal, `alarm` while offline.
 *
 * @param {string|null|undefined} state
 * @returns {"normal"|"warning"|"alarm"}
 */
function buttonStyle(state) {
  if (state === "metered" || state === "captive") return "warning";
  if (state === "offline") return "alarm";
  return "normal";
}

export {
  buttonStyle,
  formatRow,
  OVERRIDE_CHOICES,
  ROWS,
  STATE_PATH,
  stateLabel,
};
