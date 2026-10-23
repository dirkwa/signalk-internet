/**
 * Status window of the chart plotter extension: the live connectivity
 * state, the manual override and the connection values, over the host's
 * Signal K stream. The override goes through this plugin's REST API on
 * the user's own session, which the server restricts to administrators.
 *
 * @file plotterext/status.js
 */

import { connectExtension } from "./vendor/plotterext-bus.js";
import {
  formatRow,
  OVERRIDE_CHOICES,
  ROWS,
  STATE_PATH,
  stateLabel,
} from "./view.js";

const OVERRIDE_URL = "/plugins/signalk-internet/override";

const stateEl = document.getElementById("state");
const stateLabelEl = document.getElementById("state-label");
const sourceEl = document.getElementById("source");
const choicesEl = document.getElementById("choices");
const messageEl = document.getElementById("message");
const valuesEl = document.getElementById("values");

/** @type {string|null|undefined} undefined until the server answered */
let override;

const buttons = OVERRIDE_CHOICES.map(([value, label]) => {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "radio");
  button.textContent = label;
  button.addEventListener("click", () => setOverride(value || null));
  choicesEl.append(button);
  return { value: value || null, button };
});

const rowEls = new Map(
  ROWS.map((row) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = row.label;
    dt.hidden = true;
    dd.hidden = true;
    valuesEl.append(dt, dd);
    return [row.path, { row, dt, dd }];
  }),
);

function renderOverride() {
  for (const { value, button } of buttons) {
    button.setAttribute("aria-checked", String(value === override));
    button.disabled = override === undefined;
  }
  sourceEl.textContent =
    override === undefined ? "" : override ? "Manual" : "Auto";
}

/** @param {string} text @param {boolean} [isError] */
function showMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.className = isError ? "message error" : "message";
}

/** @param {Response} res */
function failureText(res) {
  return res.status === 401 || res.status === 403
    ? "Only an administrator can change the override."
    : `Override failed (HTTP ${res.status}).`;
}

async function loadOverride() {
  try {
    const res = await fetch(OVERRIDE_URL);
    if (!res.ok) {
      showMessage(failureText(res), true);
      return;
    }
    override = (await res.json()).override ?? null;
    renderOverride();
  } catch (err) {
    showMessage(`Override unavailable: ${err.message}`, true);
  }
}

/** @param {string|null} value */
async function setOverride(value) {
  try {
    const res = await fetch(OVERRIDE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: value }),
    });
    if (!res.ok) {
      showMessage(failureText(res), true);
      return;
    }
    override = (await res.json()).override ?? null;
    renderOverride();
    showMessage("");
  } catch (err) {
    showMessage(`Override failed: ${err.message}`, true);
  }
}

const client = await connectExtension();

if (client.hasCapability("nightMode")) {
  const applyNight = ({ enabled }) => {
    document.documentElement.dataset.mode = enabled ? "night" : "day";
  };
  await client.subscribe(["nightMode.changed"], (_name, params) =>
    applyNight(params),
  );
  applyNight(await client.call("nightMode.get"));
}

renderOverride();
loadOverride();

/** @type {Set<string>} paths a delta has already filled */
const seen = new Set();

/** @param {string} path @param {unknown} value */
function render(path, value) {
  if (path === STATE_PATH) {
    stateEl.dataset.state = typeof value === "string" ? value : "unknown";
    stateLabelEl.textContent = stateLabel(value);
    return;
  }
  const entry = rowEls.get(path);
  if (!entry) return;
  entry.dd.textContent = formatRow(entry.row, value);
  entry.dt.hidden = entry.dd.hidden = value == null;
}

/**
 * The host shares one server subscription among its extensions, so a path
 * the toolbar indicator already holds sends no initial value to this
 * window; the current values come from the REST API instead.
 *
 * @param {string} path
 */
async function seed(path) {
  try {
    const res = await fetch(
      `/signalk/v1/api/vessels/self/${path.replaceAll(".", "/")}/value`,
    );
    if (!res.ok) return;
    const value = await res.json();
    if (!seen.has(path)) render(path, value);
  } catch {
    // The stream fills the value on its next update.
  }
}

const paths = [STATE_PATH, ...rowEls.keys()];
await client.signalk.subscribe(paths, ({ path, value }) => {
  seen.add(path);
  render(path, value);
});
for (const path of paths) seed(path);
