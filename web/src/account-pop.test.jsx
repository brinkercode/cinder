import { afterEach, describe, expect, it, vi } from "vitest";
import accounts from "../../worker/src/api/fixtures/account-list.json";
import { all, click, doc, El } from "./fake-dom.js";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { AccountPop } = await import("./shell.jsx");

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const mount = async (fetch) => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", fetch);
  const loads = [];
  const router = createMemoryRouter([{ path: "/", loader: () => loads.push(1), element: <AccountPop id="t-" /> }]);
  const root = doc.body.appendChild(new El("div"));
  await act(async () => createRoot(root).render(<RouterProvider router={router} />));
  await settle();
  return { root, loads };
};
const menu = (root) => all(root).find((n) => n.attrs?.id === "t-acct-menu");
// Each line of the popover: its labels, account rows (with a ✓ on the current one) and footer links.
const lines = (root) => menu(root).childNodes.filter((n) => n.nodeType === 1 && n.nodeName !== "HR")
  .map((n) => n.textContent + (all(n).some((c) => c.attrs?.["aria-label"] === "current account") ? " ✓" : ""));
afterEach(() => vi.unstubAllEnvs());

describe("account popover", () => {
  it("the seeded organization with 3 accounts renders grouped with role, via organization and repo count", async () => {
    const { root } = await mount(async (path) => (path === "/api/me/accounts" ? Response.json(accounts) : new Promise(() => {})));
    expect(lines(root)).toEqual([
      "Nimbus Edge · Organization",
      "NNimbus Edge StagingGit Contributor · 3 repos",
      "NNimbus Edge TeamGit Admin · 7 repos ✓",
      "NNimbus LabsGit Admin · via organization · 12 repos",
      "Outside an organization",
      "CCinderGit Admin · 3 repos",
      "Members",
      "Account settings",
    ]);
    expect(all(root).find((n) => n.attrs?.class === "acct-name").textContent).toBe("Nimbus Edge Team");
  });

  it("a failed switch restores the previous account and shows a toast", async () => {
    let fail;
    const { root, loads } = await mount(async (path, init) => {
      if (path === "/api/me/accounts") return Response.json(accounts);
      if (init?.method === "POST" && path === "/api/me/accounts/acc-labs/switch") return new Promise((_, reject) => { fail = reject; });
      if (init?.method === "POST") return new Response(null, { status: 204 });
      return new Promise(() => {});
    });
    const before = loads.length;
    await act(async () => click(all(menu(root)).find((n) => n.nodeName === "BUTTON" && n.textContent.startsWith("NNimbus Labs"))));
    // The mark moves at once, before the switch answers.
    expect(lines(root).filter((l) => l.endsWith("✓"))).toEqual(["NNimbus LabsGit Admin · via organization · 12 repos ✓"]);
    await act(async () => fail(new Error("offline")));
    await settle();
    expect(lines(root).filter((l) => l.endsWith("✓"))).toEqual(["NNimbus Edge TeamGit Admin · 7 repos ✓"]);
    expect(all(root).find((n) => n.attrs?.class === "toast").textContent).toBe("Couldn't switch to Nimbus Labs");
    expect(loads.length).toBe(before);
    // A switch that lands re-runs the loaders.
    await act(async () => click(all(menu(root)).find((n) => n.nodeName === "BUTTON" && n.textContent.startsWith("CCinder"))));
    await settle();
    expect(loads.length).toBe(before + 1);
  });
});
