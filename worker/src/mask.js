// Backstop for secrets we were not told about: an Artifacts token (its secret precedes "?expires="), OpenAI-style sk-
// keys, GitHub tokens and AWS access key ids.
export const SHAPES = /[\w-]+\?expires=\d+|\bsk-[\w-]{16,}|\bgh[pousr]_\w{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

const b64 = (v) => btoa(String.fromCharCode(...new TextEncoder().encode(v))).replace(/=+$/, "");

// mask replaces every known secret value, and its base64, base64url, URL and JSON-escaped forms (as runner/internal/mask
// does), then every token-shaped string, with "***" before a log or report is stored. Values under 8 characters are left
// alone, as in the runner's mask package (the keystore refuses them): masking them would mangle ordinary output.
export function mask(text, values) {
  for (const v of values) {
    if (typeof v !== "string" || v.length < 8) continue;
    for (const f of [v, b64(v), b64(v).replaceAll("+", "-").replaceAll("/", "_"), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]) text = text.replaceAll(f, "***");
  }
  return text.replace(SHAPES, "***");
}
