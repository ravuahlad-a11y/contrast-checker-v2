# Contrast Checker (Full Page), v2

A Chrome extension that checks the color contrast of visible text on a whole page, including text inside iframes and open shadow DOM components. It works from the colors the browser actually paints, not from the CSS rules alone.

## Install

1. Unzip the folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped `contrast-checker-v2` folder.
4. Pin the extension from the puzzle-piece icon.

## Use

1. Open the page and click the icon, then **Scan whole page**.
2. Filter by **Failing only**, **Needs review**, **Hidden under other elements**, or **Everything**.
3. Optional: **Outline failures on page**, **Live re-check as page changes** (shows a count badge in the corner), **Copy report**.

## Statuses

- **Fail**: the contrast is below the required ratio, and nothing on the page makes the measurement uncertain.
- **Review**: the number may be wrong, so a person should look. Each item lists the reason. Examples: a translucent overlay on top of the text, a background image or gradient, a blur or filter, a decorative `::before`/`::after` block, a frame under an overlay in the parent page, gradient-filled text, or text partly covered by another element. When a review item would fail on a solid background, the note says so.
- **Pass**: meets the required ratio.
- **Hidden under other elements**: an opaque element sits on top of the text, so a user can't see it. Not checked.

Text that is clipped, off-screen to the side, or set to `opacity: 0` is skipped, and not counted as a failure.

## How the background is found

For each text item, the tool asks the browser which elements are painted at several points in the text's box, top to bottom. It stacks the translucent layers beneath the text and blends them in order. That catches sibling panels, positioned blocks and overlays, which a parent-only check misses.

Two things it checks in addition: anything painted on top of the text (opaque = hidden, translucent = review), and any element beneath the text that could change the color in a way the math can't follow (images, blur, filters, blend modes, decorative pseudo-elements).

## Limits

- **Closed shadow DOM** (`attachShadow({mode: 'closed'})`) cannot be read by any extension. Text inside it is not checked.
- **Content below the fold** is checked for color, but overlays are not checked, because the browser can't hit-test points outside the screen. The note on each item says so. Scrolling the page to that area and scanning again helps.
- **Elements with `pointer-events: none`** don't show up in the browser's hit test, so an overlay with that setting is not detected.
- **Text in SVG, `<canvas>`, or images** is not checked.
- **Opacity** is approximated. Text is faded by its ancestors' opacity; the backgrounds behind a faded element are not faded in full detail.
- **Frames nested inside frames** use the context of their immediate parent only.
- **Non-text contrast** (borders, icons, focus rings) is not checked.
- **Keyboard, focus order, labels, and headings** are not checked. This is color contrast only.
- **Iframe context** adds a `data-cc-id` attribute to each iframe on the page when you scan. It is used to match frames and does not change how the page looks.
- The popup warns when a frame Chrome knows about could not be scanned. It uses the `webNavigation` permission to find those frames.

## Tests

The `test/` folder runs the scanner in real Chromium against known answers (18 cases):

```
npm install playwright
node test/run-test.js
node test/live-test.js
```
