// Dependency-free so plain Node (e2e/git-fsck.test.js runs git/index.js) can import it; router.js re-exports both.
export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// bytes: a Uint8Array or an ArrayBuffer (a digest or signature).
export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
