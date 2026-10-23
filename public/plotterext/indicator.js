/**
 * Background runtime of the chart plotter extension: keeps the toolbar
 * button's decoration in step with `network.internet.state`, so a
 * metered or lost connection shows on the chart without opening the
 * window.
 *
 * @file plotterext/indicator.js
 */

import { connectExtension } from "./vendor/plotterext-bus.js";
import { buttonStyle, STATE_PATH } from "./view.js";

const client = await connectExtension();

if (client.hasCapability("buttons.decorations")) {
  let shown = "normal";
  await client.signalk.subscribe([STATE_PATH], ({ value }) => {
    const style = buttonStyle(value);
    if (style === shown) return;
    shown = style;
    client
      .call("buttons.decorate", { ids: ["internet-status"], style })
      .catch((err) => console.warn("signalk-internet: decorate failed", err));
  });
}
