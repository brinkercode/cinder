import { afterEach, vi } from "vitest";
import { invalidate } from "./client.js";

// fetchJson keeps answers for the page load. A test that stubs fetch stands up a new backend, so it starts with none.
const stub = vi.stubGlobal;
vi.stubGlobal = (name, value) => {
  if (name === "fetch") invalidate();
  return stub(name, value);
};
afterEach(invalidate);
