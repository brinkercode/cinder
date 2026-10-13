// Vitest globalSetup (Node side): a relay that lets a Workers-runtime test serve the real Go runners. Runners send
// their API calls to the relay; the test long-polls GET /next, answers each through the Worker with POST /reply/:id.
// POST /git runs git under the repos dir; POST /start builds the runners once and starts one with {bin, token}.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The relay runs in Vitest's main process, which also serves every test file's module loads and RPC: a synchronous
// child process here stalls them all, so a git-heavy file timed out hooks in unrelated files.
// A child that exits without reading its input (EPIPE) fails through its exit code, as with execFileSync.
const run = (cmd, args, { input, ...opts }) => new Promise((resolve, reject) => {
  const { stdin } = execFile(cmd, args, { ...opts, encoding: "buffer" }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: err })) : resolve(out)));
  stdin.on("error", () => {}).end(input);
});

export default async function ({ provide }) {
  const root = mkdtempSync(join(tmpdir(), "cinder-runners-"));
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null" };
  // The fake harness: writes the file the check looks for and reports a result as claude -p does.
  writeFileSync(join(root, "claude"), "#!/bin/sh\necho hello > hello.txt\necho '{\"is_error\":false,\"session_id\":\"s1\",\"result\":\"done\"}'\n", { mode: 0o755 });
  const pending = [];
  const replies = new Map();
  const children = [];
  let built;
  let seq = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = raw.toString();
    const send = (status, text = "") => res.writeHead(status, { "content-type": "application/json" }).end(text);
    if (req.url === "/next") return send(pending.length ? 200 : 204, pending.length ? JSON.stringify(pending.shift()) : "");
    if (req.url.startsWith("/reply/")) {
      const { status, text } = JSON.parse(body);
      replies.get(req.url.slice(7))(status, text);
      return send(200);
    }
    if (req.url === "/git") {
      // The body is the args, or {args, input (base64 stdin), env}.
      const call = JSON.parse(body);
      const { args, input, env: extra } = Array.isArray(call) ? { args: call } : call;
      try {
        return send(200, JSON.stringify((await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
          { cwd: root, env: { ...env, ...extra }, input: input && Buffer.from(input, "base64") })).toString()));
      } catch (e) {
        return send(500, JSON.stringify(String(e.stderr ?? e)));
      }
    }
    // git smart HTTP for the bare repos under root. http-backend refuses receive-pack without a user, so a push must send Basic auth.
    if (req.url.startsWith("/smart/")) {
      const [path, query = ""] = req.url.slice("/smart".length).split("?");
      const user = /^Basic (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      const out = await run("git", ["http-backend"], { input: raw, env: { ...env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: path,
        QUERY_STRING: query, REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: user ? atob(user).split(":")[0] : "" } });
      const end = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, end).toString();
      return res.writeHead(Number(/^Status: (\d+)/m.exec(head)?.[1] ?? 200), { "content-type": /^Content-Type: (.*)$/im.exec(head)?.[1] ?? "text/plain" })
        .end(out.subarray(end + 4));
    }
    if (req.url === "/start") {
      await (built ??= run("go", ["build", "-o", root, "./cmd/cinder-agent", "./cmd/cinder-verify"], { cwd: "../runner" }));
      const { bin, token } = JSON.parse(body);
      children.push(spawn(join(root, bin), [], { env: { ...env, CINDER_URL: `http://127.0.0.1:${server.address().port}/runner`, CINDER_RUNNER_TOKEN: token }, stdio: "inherit" }));
      return send(200);
    }
    const id = String(++seq);
    replies.set(id, send);
    pending.push({ id, method: req.method, path: req.url.slice("/runner".length), auth: req.headers.authorization, body });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  provide("runnerRelay", { url: `http://127.0.0.1:${server.address().port}`, root });
  return () => {
    for (const c of children) c.kill();
    server.close();
    // root holds built binaries on tmpfs; left behind, every run leaks ~24 MB until /dev/shm fills and SQLite fails.
    rmSync(root, { recursive: true, force: true });
  };
}
