# Runners

A runner is a machine that claims jobs from your cinder Worker and runs them. Each runner has two services, both
running as your user:

- `cinder-agent` runs `develop` jobs
- `cinder-verify` runs `verify` jobs

## Install on a fresh machine

You need Go, git, systemd, and the URL and owner token of your cinder Worker. Run these from the repo root.

1. Build the binaries and install them to `~/.local/bin`:

   ```sh
   make runners
   install -D -t ~/.local/bin bin/cinder-agent bin/cinder-verify
   ```

2. Register one runner for each service. Each command prints `{"id": ..., "token": ...}`. Keep the tokens for step 3:

   ```sh
   export CINDER_URL=https://<your-worker> CINDER_TOKEN=<owner token>
   (cd runner && go run ./cmd/cinder runner register "$(hostname)-agent" --kinds develop)
   (cd runner && go run ./cmd/cinder runner register "$(hostname)-verify" --kinds verify)
   ```

3. Create one env file for each service from the template. Set `CINDER_URL` and that runner's `CINDER_RUNNER_TOKEN`:

   ```sh
   mkdir -p ~/.config/cinder
   install -m 600 runner/deploy/runner.env.example ~/.config/cinder/agent.env
   install -m 600 runner/deploy/runner.env.example ~/.config/cinder/verify.env
   $EDITOR ~/.config/cinder/agent.env ~/.config/cinder/verify.env
   ```

4. Install the user units and start them:

   ```sh
   install -D -m 644 -t ~/.config/systemd/user runner/deploy/cinder-agent.service runner/deploy/cinder-verify.service
   systemctl --user daemon-reload
   systemctl --user enable --now cinder-agent cinder-verify
   loginctl enable-linger "$USER"   # keep the runners up after you log out
   ```

5. Watch the services claim jobs:

   ```sh
   journalctl --user -fu cinder-agent -u cinder-verify
   ```

   Each service logs a `job reported` line for every job it claims. Runner tokens never appear in the logs.

## Build an image in a flow

The full image (`runner/Dockerfile.full`, the `standard-2` pools) bakes `buildah`, which builds OCI images with no Docker
daemon and no privileged mode. The image sets `STORAGE_DRIVER=vfs` and `BUILDAH_ISOLATION=chroot`, so a flow step only runs:

```sh
buildah bud --storage-driver vfs --isolation chroot -t <name> .
```

The flags repeat the image's defaults and are needed on a runner you bring yourself. The image stays in the worker's
local storage and is not pushed.
