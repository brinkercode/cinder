.PHONY: down seed smoke check check-ts check-go check-image check-deps check-seed build runners deploy up pulse-publish e2e-live

check: check-deps check-ts check-go check-seed

check-deps:
	scripts/check-deps.sh

check-ts:
	npm run check
	node --test e2e/git-fsck.test.js

# The seed repos (seed/repos/*) are separate projects: each builds and tests with its own toolchain, skipped when absent.
check-seed:
	node --test seed/repos.test.js

check-go:
	cd runner && test -z "$$(gofmt -l .)" || { gofmt -l .; exit 1; }
	cd runner && go vet ./... && staticcheck ./... && GIT_CONFIG_GLOBAL=/dev/null go test -race ./...

# Builds the slim runner image (docker or podman): minutes cold, so check-go skips it and CI runs it on Dockerfile changes.
check-image:
	cd runner && CINDER_IMAGE_TEST=1 go test -run '^TestImage_' ./cmd/cinder-verify -v -timeout 15m

# The Playwright specs in e2e/ against a deploy: E2E_BASE_URL, CINDER_TOKEN and, behind Access, CINDER_ACCESS_CLIENT_ID/SECRET.
# SPECS narrows the run to some spec files; browsers come from PLAYWRIGHT_BROWSERS_PATH.
e2e-live:
	@test -n "$$E2E_BASE_URL" -a -n "$$CINDER_TOKEN" || { echo "e2e-live: set E2E_BASE_URL and CINDER_TOKEN" >&2; exit 1; }
	npx playwright test -c e2e $(SPECS)

build:
	npm run build -w web
	cd runner && go build -o ../bin/ ./cmd/...

runners:
	cd runner && go build -o ../bin/ ./cmd/cinder-agent ./cmd/cinder-verify

deploy: build
	npm run deploy -w worker

# One command on your Cloudflare account: approve a token, deploy, get the URL. CINDER_ACCESS=0 skips Access sign-in.
# Then waits for the Worker's health and the container apps. It deploys only: make seed fills it, make smoke checks it.
up:
	deploy/install.sh
	deploy/after-deploy.sh

# Seeds a deployed cinder (--full) and warms its pages. CINDER_DEMO=1 also runs the demo scenario.
seed:
	deploy/seed.sh

# Deletes everything make up created on the account (asks for the account id; CINDER_YES=1 skips, DRY=--dry-run lists only).
down:
	deploy/teardown.sh $(DRY)

# PASS/FAIL checks of a deployed cinder, from ~/.config/cinder/live.env.
smoke:
	scripts/smoke.sh

# Publish demo/pulse to its own repo's main; the first publish also creates develop from main.
PULSE_REMOTE ?= git@github.com:brinkercode/pulse.git
pulse-publish:
	sha=$$(git subtree split --prefix demo/pulse) && git push $(PULSE_REMOTE) $$sha:refs/heads/main && \
	{ git ls-remote --exit-code --heads $(PULSE_REMOTE) develop >/dev/null || git push $(PULSE_REMOTE) $$sha:refs/heads/develop; }
