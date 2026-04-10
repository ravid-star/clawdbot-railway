# Hermes Supervision Guide

This guide shows how to attach an external supervisor agent (such as
[Hermes Agent by Nous Research](https://hermes-agent.nousresearch.com/))
to a `clawdbot-railway` deployment so that the OpenClaw gateway is
monitored and auto-repaired when it breaks.

> **TL;DR** — OpenClaw keeps running on Railway inside this container.
> Hermes runs on a small VPS (or any other persistent host). It talks
> to the wrapper over HTTPS using a bearer token, watches `/healthz`
> and optional webhooks, and repairs problems via the existing
> `/setup/api/*` endpoints without ever needing SSH into Railway.

---

## 1. Architecture

```
[you] ──SSH──> [small VPS running Hermes Agent]
                        │  HTTPS (Bearer HERMES_API_TOKEN)
                        ▼
                [Railway: clawdbot-railway]
                   ├── /healthz               (public, extended)
                   ├── /setup/api/health      (Hermes auth)
                   ├── /setup/api/metrics     (Hermes auth)
                   ├── /setup/api/logs/tail   (Hermes auth)
                   ├── /setup/api/console/run (existing Basic auth)
                   ├── /setup/api/config/raw  (existing Basic auth)
                   ├── /setup/api/reset       (existing Basic auth)
                   └── HERMES_WEBHOOK_URL     → [POST on crash]
```

The supervisor host and OpenClaw are fully separated. If the wrapper
crashes, Railway auto-restarts it. If the gateway subprocess crashes
without restarting, Hermes notices via `/healthz` (or the webhook)
and drives the recovery playbook.

---

## 2. Enable the supervision API

Set these Railway Variables on the `clawdbot-railway` service:

| Variable              | Required | Purpose |
|-----------------------|----------|---------|
| `SETUP_PASSWORD`      | yes      | Human admin password (unchanged) |
| `HERMES_API_TOKEN`    | **new**  | Long random bearer token Hermes uses for read/monitor endpoints |
| `HERMES_WEBHOOK_URL`  | optional | If set, the wrapper POSTs a JSON crash event to this URL when the gateway exits |

Generate a strong token locally:

```bash
openssl rand -hex 32
```

Paste the output into `HERMES_API_TOKEN`. Redeploy.

> **Least privilege note.** Endpoints that mutate state (`/setup/api/run`,
> `/setup/api/config/raw`, `/setup/api/reset`, `/setup/import`,
> `/setup/api/console/run`) continue to require `SETUP_PASSWORD` Basic
> auth. The new Hermes endpoints are read-oriented (health, metrics,
> logs). Give Hermes both tokens only if you want it to perform
> write-side repairs as well.

---

## 3. New endpoints added for supervisors

All endpoints accept **either** `Authorization: Bearer <HERMES_API_TOKEN>`
**or** the existing `Authorization: Basic <SETUP_PASSWORD>` header.

### `GET /healthz` (public, extended)

Now includes supervision-friendly fields. No auth required.

```json
{
  "ok": true,
  "wrapper": {
    "configured": true,
    "uptimeSec": 3821,
    "startedAt": "2026-04-10T08:12:40.000Z"
  },
  "gateway": {
    "reachable": true,
    "running": true,
    "pid": 42,
    "uptimeSec": 3810,
    "startCount": 1,
    "crashCount": 0,
    "lastHealthyAt": "2026-04-10T09:16:01.000Z",
    "secondsSinceHealthy": 0,
    "lastError": null,
    "lastExit": null
  }
}
```

Hermes should treat **any** of these as signs to investigate:
- `gateway.reachable: false`
- `gateway.secondsSinceHealthy > 120`
- `gateway.crashCount` increases between polls
- `gateway.lastError` is non-null

### `GET /setup/api/health` (Hermes auth)

Same data as `/healthz` plus Node.js process memory (RSS / heap).

### `GET /setup/api/metrics` (Hermes auth)

Raw JSON metrics — CPU micros, memory bytes, start/crash counters,
`secondsSinceHealthy`. Poll every 30–60 seconds and store a rolling
window to detect trends.

### `GET /setup/api/logs/tail?n=200&level=error` (Hermes auth)

Wraps `openclaw logs --tail N`, auto-redacts secrets, and optionally
filters to `level=error` or `level=warn`. Returns parsed lines:

```json
{
  "ok": true,
  "requested": 200,
  "returned": 12,
  "level": "error",
  "lines": ["[gateway] error: ...", "..."]
}
```

### `POST <HERMES_WEBHOOK_URL>` (outbound, wrapper → Hermes)

Fire-and-forget JSON payloads posted by the wrapper. Events:

| `event`                   | When |
|---------------------------|------|
| `gateway.crashed`         | Gateway subprocess exited with a crash-like code/signal |
| `gateway.stopped`         | Wrapper-initiated clean SIGTERM stop |
| `gateway.spawn_error`     | `child_process.spawn` failed entirely |

Crash payload example:

```json
{
  "event": "gateway.crashed",
  "at": "2026-04-10T09:18:21.412Z",
  "wrapper": { "uptimeSec": 3821, "stateDir": "/data/.openclaw" },
  "code": 1,
  "signal": null,
  "uptimeSec": 12,
  "startCount": 3,
  "crashCount": 2
}
```

Serve `HERMES_WEBHOOK_URL` from your Hermes host (e.g. a small webhook
listener skill). On receipt, Hermes should run its supervisor skill
immediately instead of waiting for the next poll.

---

## 4. Existing endpoints Hermes can reuse for repair

These already existed; they now interop cleanly with the Hermes flow.
They still require `SETUP_PASSWORD` Basic auth (write operations).

| Endpoint | Purpose |
|---|---|
| `POST /setup/api/console/run` with `cmd=gateway.restart`     | Soft restart |
| `POST /setup/api/console/run` with `cmd=openclaw.doctor`     | Diagnosis |
| `POST /setup/api/console/run` with `cmd=openclaw.doctor --fix` (future) | Auto-fix |
| `GET /setup/api/config/raw`                                  | Read config for LLM diagnosis |
| `POST /setup/api/config/raw`                                 | Write a fixed config (auto-backup) |
| `POST /setup/api/reset`                                      | Last resort — clears config so onboarding can rerun |
| `GET /setup/export`                                          | Pull a backup before any risky repair |
| `POST /setup/import`                                         | Restore from a backup if repair goes sideways |

---

## 5. Example Hermes skill (supervision playbook)

Save this as `~/.hermes/skills/clawdbot-supervisor/SKILL.md` on the
Hermes host. Wire it to a cron every 1–5 minutes and to an inbound
webhook listener bound to `HERMES_WEBHOOK_URL`.

```markdown
---
name: clawdbot-supervisor
description: Monitor and auto-heal the clawdbot-railway deployment on Railway.
  Trigger on schedule (every 2 min), on inbound gateway.crashed webhook,
  or when the user mentions openclaw being down.
---

# ClawdBot Supervisor

You are the supervisor for a clawdbot-railway deployment at
$CLAWDBOT_URL (Railway). Your goal: keep the OpenClaw gateway healthy
and recover automatically when it isn't.

## Environment
- $CLAWDBOT_URL            — e.g. https://clawdbot.yourdomain.com
- $HERMES_API_TOKEN        — bearer token for read endpoints
- $SETUP_PASSWORD          — basic auth password for write endpoints

## Checks (run in order, stop at first failure)
1. GET $CLAWDBOT_URL/healthz
   - Expect ok=true AND gateway.reachable=true AND
     gateway.secondsSinceHealthy < 120.
2. GET $CLAWDBOT_URL/setup/api/health (Bearer $HERMES_API_TOKEN)
   - Confirm wrapper memory rssMB < 900 (Railway small plan cap).
3. GET $CLAWDBOT_URL/setup/api/logs/tail?n=200&level=error
     (Bearer $HERMES_API_TOKEN)
   - Capture for context if unhealthy.

## Repair strategy (escalating; 60s wait between steps)
1. POST $CLAWDBOT_URL/setup/api/console/run
   body: {"cmd":"gateway.restart"}
   auth: Basic $SETUP_PASSWORD
2. POST /setup/api/console/run with cmd=openclaw.doctor.
   Feed the output back into yourself. If the LLM proposes a config
   change, run the Nightwire verification loop BEFORE writing to
   /setup/api/config/raw (and always keep the returned backup path).
3. GET /setup/export → save timestamped tarball on Hermes host
   (gold copy before any destructive action).
4. POST /setup/api/reset as last resort. Then call the onboarding
   endpoint /setup/api/run with the stored onboarding payload.
5. If still unhealthy after the above, write an incident report to
   ~/hermes-incidents/ and stop retrying.

## Rules
- NEVER remove HERMES_API_TOKEN, SETUP_PASSWORD, or any security env var.
- NEVER POST to /setup/import unless the user explicitly approves.
- Keep an audit log at ~/hermes-incidents/clawdbot-audit.log with one
  JSON line per action.
- If crashCount delta > 5 within 10 minutes, stop auto-repair and
  escalate — something upstream is broken.
```

Cron registration on the Hermes host:

```bash
hermes cron add \
  --name clawdbot-health \
  --schedule "*/2 * * * *" \
  --prompt "Run the clawdbot-supervisor skill and report status briefly."
```

---

## 6. Quick manual test (after you deploy this PR)

From any machine with curl:

```bash
export TOKEN="paste HERMES_API_TOKEN here"
export URL="https://your-clawdbot.up.railway.app"

# Extended public health (no auth)
curl -s $URL/healthz | jq

# Detailed health
curl -s -H "Authorization: Bearer $TOKEN" $URL/setup/api/health | jq

# Metrics
curl -s -H "Authorization: Bearer $TOKEN" $URL/setup/api/metrics | jq

# Error-only log tail
curl -s -H "Authorization: Bearer $TOKEN" \
  "$URL/setup/api/logs/tail?n=300&level=error" | jq
```

Expected: all return `ok: true` on a healthy deployment.

---

## 7. Security summary

- No new endpoint exposes secrets or config content.
- `/healthz` remains public but only exposes counters, timestamps, and
  `lastError` strings (which are already logged by Railway).
- `HERMES_API_TOKEN` is a **read-mostly** credential. Rotate it by
  updating the Railway variable — no code change required.
- Write-side endpoints (config edit, reset, import, onboarding) still
  require `SETUP_PASSWORD` Basic auth; nothing has been loosened.
- Webhooks are outbound-only (wrapper → Hermes) and best-effort with a
  5-second timeout, so a slow or failing webhook never blocks the
  gateway lifecycle.
