import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Mid } from "./ui.jsx";

const parts = (text) => {
  const html = renderToStaticMarkup(<Mid text={text} />);
  const [, head, tail] = html.match(/class="h">([^<]*)<\/span><span class="t">([^<]*)</);
  return { html, head, tail };
};

describe("Mid", () => {
  it("a name under 23 characters renders whole", () => {
    const { html, head, tail } = parts("feature/short-names-22");
    expect([head, tail]).toEqual(["feature/short-names-22", ""]);
    expect(html).toContain('title="feature/short-names-22"');
  });

  it("release/2026.10-dunning-retry-window-backport keeps its head and the tail dunning-retry-window-backport's last 12 characters, with the full name in title and aria-label", () => {
    const name = "release/2026.10-dunning-retry-window-backport";
    const { html, head, tail } = parts(name);
    expect(tail).toBe("dow-backport");
    expect(head + tail).toBe(name);
    expect(html).toContain(`title="${name}" aria-label="${name}"`);
  });

  it("a last segment of 14 characters or fewer is the whole tail", () => {
    const { head, tail } = parts("release/2026.10-dunning-retry/hotfix-1.2.3");
    expect([head, tail]).toEqual(["release/2026.10-dunning-retry/", "hotfix-1.2.3"]);
  });
});
