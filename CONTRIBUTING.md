# Contributing

## Outside contributions

Cinder is developed by its owner and invited collaborators.

- **Pull requests from people without write access are closed automatically.** To propose a change, open an issue describing the problem and the change you'd make. If it fits, you'll be invited to send it.
- **Issues** for bugs and ideas are welcome. Search first, and include steps to reproduce.
- **Security issues** go through [SECURITY.md](SECURITY.md), never a public issue.
- Every change to `main` goes through a pull request reviewed by the owner ([CODEOWNERS](.github/CODEOWNERS)) and must pass CI. Pull requests from forks run CI on GitHub-hosted runners with no secrets.

## Develop

Needs Node 22+, Go 1.27+, `staticcheck` and `git` (`make check-ts` runs `e2e/git-fsck.test.js`, which checks the git
objects the Worker writes with `git index-pack --strict` and `git fsck --strict`).

```sh
npm ci
make check      # everything CI runs, plus make check-seed
set -a; . ~/.config/cinder/cloudflare.env; set +a   # the token make up saved
make deploy     # build the SPA and deploy the Worker
```

CI runs `make check-ts` as parallel jobs: the Worker suite in three vitest shards (`worker`, shards 1 to 3 of 3), and `web` (Worker and web lint, web tests, the git fsck test, `make check-deps` and the PR guards). The `ts` job needs all of them and fails unless each passed, so `ts` stays the one required check. Run one shard locally with `npm exec -w worker -- vitest run --shard=2/3`.

`make check-seed` builds and tests the seed repos in `seed/repos/` with their own toolchains (Go, Python 3.12 with
pip, Node, Rust, .NET 10); a repo whose toolchain is missing is skipped. CI doesn't run it.

In `web/` tests and the Worker tests that render web pages, `web/src/test-setup.js` drops the GET answers `fetchJson()` keeps after each test and whenever a test
stubs `fetch`. Listeners share one socket per repo, so a test that mounts a live page unmounts it when it finishes
(`onTestFinished`), or the next test's `WebSocket` stub never sees a socket.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Rules for every change: [below](#rules-every-change-follows)

## Rules every change follows

`make check` enforces these, and CI runs the same targets.

- **Tests.** Every acceptance item has a test named after the behaviour, and it fails without the change. Never skip or weaken a test.
- **Checks.** `worker/`, `web/`: `eslint --max-warnings 0`, `vitest run`. Plain JavaScript only: no TypeScript and no JSDoc types used as a type system. `runner/`: `gofmt -l` empty, `go vet`, `staticcheck`, `go test -race`.
- **Dependencies.** A new entry in a `package.json` or `go.mod` fails unless its name is in `deps-allow.txt`.
- **Frontend.** No component kits; see [Frontend rules](#frontend-rules). Styling uses the tokens in `web/src/styles/tokens.css`.
- **Shared files.** A route is one import and one line in `worker/src/routes.js`; a page is one import and one line in `web/src/pages.jsx`; a new API shape goes in `worker/src/api/shapes/<name>.js`; migrations are named by UTC time (`worker/migrations/YYYYMMDDHHMM_<what>.sql`).
- **Security.** Never weaken input validation at a trust boundary, data-loss handling or token handling. Artifacts tokens are never logged or returned to the browser.
- **Docs.** A change that alters what a user or operator sees updates the doc in the same change: `docs/usage/<page>.md`, `docs/ARCHITECTURE-CLOUDFLARE.md` for bindings and resources, `docs/operations/README.md` for operations, the README for deploy and access.

## Frontend rules

`make check` enforces the first three (`scripts/banned-packages.json`, `eslint.config.js`, `scripts/check-frontend.mjs`); the last two are conventions:

- **No component kits or their defaults.** The packages in `scripts/banned-packages.json` (Tailwind, Radix and Base UI, shadcn, lucide and Heroicons, framer-motion, sonner, recharts and similar) can't be dependencies or imports, and there is no `components.json` or `tailwind.config.*`.
- **Icons** come only from `react-icons/pi` (Phosphor, regular weight), imported per icon.
- **CSS:** plain CSS with custom properties. Color literals live only in `web/src/styles/tokens.css`; fonts only through `var(--font-*)`; no `backdrop-filter` and no `background-clip: text`.
- **Native first:** `<dialog>`, the Popover API, `<details>`, container queries and `:has()` before a library. `react-aria` hooks only for widgets the platform lacks (combobox, grid, tree).
- **Copy:** no emoji in UI text.

