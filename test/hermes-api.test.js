import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression guards for the Hermes supervision API surface.
// We match against the source rather than booting the server to keep
// these tests zero-cost (no openclaw build required).
const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("server declares Hermes env vars", () => {
  assert.match(src, /HERMES_API_TOKEN/);
  assert.match(src, /HERMES_WEBHOOK_URL/);
});

test("server exposes /setup/api/health endpoint behind Hermes auth", () => {
  assert.match(src, /app\.get\("\/setup\/api\/health", requireHermesAuth/);
});

test("server exposes /setup/api/metrics endpoint behind Hermes auth", () => {
  assert.match(src, /app\.get\("\/setup\/api\/metrics", requireHermesAuth/);
});

test("server exposes /setup/api/logs/tail endpoint behind Hermes auth", () => {
  assert.match(src, /app\.get\("\/setup\/api\/logs\/tail", requireHermesAuth/);
});

test("server exposes /setup/api/doctor endpoint behind Hermes auth", () => {
  assert.match(src, /app\.get\("\/setup\/api\/doctor", requireHermesAuth/);
});

test("server exposes /setup/api/conversations/stats endpoint behind Hermes auth", () => {
  assert.match(src, /app\.get\("\/setup\/api\/conversations\/stats", requireHermesAuth/);
});

test("server exposes POST /setup/api/gateway/restart endpoint behind Hermes auth", () => {
  assert.match(src, /app\.post\("\/setup\/api\/gateway\/restart", requireHermesAuth/);
});

test("requireHermesAuth accepts Bearer token and falls back to Basic", () => {
  assert.match(src, /function requireHermesAuth/);
  assert.match(src, /scheme === "Bearer"/);
  assert.match(src, /Basic realm="OpenClaw Hermes API"/);
});

test("gateway start/crash counters are tracked", () => {
  assert.match(src, /gatewayStartCount \+= 1/);
  assert.match(src, /gatewayCrashCount \+= 1/);
});

test("crash exit fires hermes webhook", () => {
  assert.match(src, /fireHermesWebhook\("gateway\.crashed"/);
});

test("/healthz reports uptime and crashCount", () => {
  // The extended healthz response should include these new top-level fields.
  assert.match(src, /uptimeSec: wrapperUptimeSec/);
  assert.match(src, /crashCount: gatewayCrashCount/);
});

test("respondJson is declared at function scope so catch can use it", () => {
  // Regression guard for a pre-existing bug where `respondJson` was declared
  // inside the try block of /setup/api/run. Any throw in the try body then
  // caused a secondary "ReferenceError: respondJson is not defined" in catch,
  // masking the real error (e.g., gateway OOM).
  const routeStart = src.indexOf('app.post("/setup/api/run"');
  assert.ok(routeStart > 0, "could not locate /setup/api/run route");
  const routeSlice = src.slice(routeStart, routeStart + 2000);
  const tryIdx = routeSlice.indexOf("try {");
  const declIdx = routeSlice.indexOf("const respondJson");
  assert.ok(declIdx > 0, "respondJson declaration missing");
  assert.ok(tryIdx > 0, "try block missing");
  assert.ok(
    declIdx < tryIdx,
    "respondJson must be declared BEFORE the try block, not inside it",
  );
});

test("gateway spawn injects --max-old-space-size to avoid OOM", () => {
  // The gateway child process needs a raised V8 heap limit because OpenClaw's
  // gateway binary crashes around Node's ~500 MB default on Railway Hobby.
  assert.match(src, /GATEWAY_MAX_OLD_SPACE_MB/);
  assert.match(src, /--max-old-space-size=/);
  assert.match(src, /NODE_OPTIONS: gatewayNodeOptions/);
});
