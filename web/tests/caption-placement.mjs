import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Exercise the real control visibility events and native subtitle renderer.
export async function checkCaptionPlacement(
  page,
  video,
  { kind, mode, width },
) {
  const bottomText = "Bottom caption placement";
  const topText = "Upper caption placement";
  if (kind === "embedded") {
    await video.evaluate(
      (element, labels) => {
        const track = Array.from(element.textTracks).find(
          (track) => track.mode === "showing",
        );
        // Cover deliberately positioned captions as well as the CEA decoder's
        // own cues. The upper caption must keep its original placement.
        for (const [text, line] of [
          [labels.bottom, 98],
          [labels.top, 20],
        ]) {
          const cue = new VTTCue(0, 60, text);
          cue.snapToLines = false;
          cue.line = line;
          track.addCue(cue);
        }
      },
      { bottom: bottomText, top: topText },
    );
  }
  const position = () =>
    video.evaluate(
      (element, label) => {
        const track = Array.from(element.textTracks).find(
          (track) => track.mode === "showing",
        );
        const cues = Array.from(track?.cues || []);
        const cue = label ? cues.find((cue) => cue.text === label) : cues[0];
        return {
          line: cue?.line,
          upperLine: cues.find((cue) => cue.text === "Upper caption placement")
            ?.line,
        };
      },
      kind === "embedded" ? bottomText : "",
    );

  // Inspect Chromium's actual native cue box, rather than just VTTCue.line:
  // unsupported alignment properties and stale native layout can otherwise
  // make the JS coordinates pass while the caption is still flush to the edge.
  const cdp = await page.context().newCDPSession(page);
  const descendants = (node) => [
    node,
    ...[...(node.children || []), ...(node.shadowRoots || [])].flatMap(
      descendants,
    ),
  ];
  const renderedBox = async () => {
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const cue = descendants(root).find(
      (node) =>
        node.attributes?.includes("cue") &&
        descendants(node).some((child) =>
          child.nodeValue?.includes(
            kind === "embedded" ? bottomText : "Provider subtitle fixture",
          ),
        ),
    );
    if (!cue) return null;
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId: cue.nodeId });
    return {
      bottom: Math.max(...model.border.filter((_, index) => index % 2 === 1)),
      height: model.height,
    };
  };
  const renderedBottom = async () => (await renderedBox())?.bottom ?? null;
  const renderedInset = async () => {
    const bottom = await renderedBottom();
    const box = await video.boundingBox();
    return bottom === null ? 0 : box.y + box.height - bottom;
  };
  await video.evaluate((element) => {
    document.activeElement?.blur();
    return element.play();
  });
  const area = page.locator(".playback-area");
  const bounds = await video.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.move(0, 0);
  await expect(area).toHaveClass(/controls-hidden/);
  await expect(page.locator(".video-controls")).toHaveCSS("opacity", "0");
  await expect.poll(renderedInset).toBeGreaterThanOrEqual(10);
  await expect.poll(renderedInset).toBeLessThanOrEqual(40);
  const hidden = await position();
  if (kind === "embedded") expect(hidden.upperLine).toBe(20);

  const output = fileURLToPath(new URL("../../output/", import.meta.url));
  await mkdir(output, { recursive: true });
  await area.screenshot({
    path: `${output}/caption-padding-${kind}-hidden-${mode}-${width}.png`,
  });
  if (width === 390) {
    // A long line in a larger font must wrap inside the video while retaining
    // the same bottom gap. This also exercises appearance remeasurement.
    const original = await video.evaluate(
      (element, label) => {
        const track = Array.from(element.textTracks).find(
          (t) => t.mode === "showing",
        );
        const cue = Array.from(track.activeCues).find(
          (c) => !label || c.text === label,
        );
        const wrap = element.parentElement;
        const saved = { text: cue.text, style: wrap.style.cssText };
        cue.text +=
          " with a longer sentence that should wrap comfortably on a small screen.";
        wrap.style.setProperty("--subtitle-font-family", "monospace");
        wrap.style.setProperty("--subtitle-font-scale", "1.25");
        return saved;
      },
      kind === "embedded" ? bottomText : "",
    );
    await expect
      .poll(async () => (await renderedBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(40);
    await expect.poll(renderedInset).toBeGreaterThanOrEqual(10);
    await expect.poll(renderedInset).toBeLessThanOrEqual(40);
    await area.screenshot({
      path: `${output}/caption-padding-${kind}-wrapped-${mode}-${width}.png`,
    });
    await video.evaluate((element, saved) => {
      const track = Array.from(element.textTracks).find(
        (t) => t.mode === "showing",
      );
      const cue = Array.from(track.activeCues).find((c) =>
        c.text.startsWith(saved.text),
      );
      cue.text = saved.text;
      element.parentElement.style.cssText = saved.style;
    }, original);
  }
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(area).not.toHaveClass(/controls-hidden/);
  await expect
    .poll(async () => (await position()).line)
    .toBeLessThan(hidden.line);
  const controls = await page.locator(".video-controls").boundingBox();
  await expect.poll(renderedBottom).toBeLessThanOrEqual(controls.y - 6);
  if (kind === "embedded") expect((await position()).upperLine).toBe(20);
  await video.evaluate((element) => element.pause());
  await area.screenshot({
    path: `${output}/caption-padding-${kind}-visible-${mode}-${width}.png`,
  });
  if (kind === "embedded") {
    await video.evaluate(
      (element, labels) => {
        for (const track of element.textTracks)
          for (const cue of Array.from(track.cues || []))
            if (labels.includes(cue.text)) track.removeCue(cue);
      },
      [bottomText, topText],
    );
  }
  await cdp.detach();
}
