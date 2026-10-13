import { expect, it } from "vitest";
import { mask } from "../src/mask.js";

it("one mask covers raw, base64, URL and JSON forms", () => {
  const v = 'pa$$/w+rd "q"?';
  const b64 = btoa(v).replace(/=+$/, "");
  const forms = [v, b64, b64.replaceAll("+", "-").replaceAll("/", "_"), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)];
  const out = mask(forms.join(" | "), [v]);
  for (const f of forms) expect(out).not.toContain(f);
  expect(mask("token ghp_abcdefghijklmnopqrstuvwxyz0123", [])).toBe("token ***");
  expect(mask("short abc stays", ["abc"])).toBe("short abc stays");
});
