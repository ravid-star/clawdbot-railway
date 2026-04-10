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
