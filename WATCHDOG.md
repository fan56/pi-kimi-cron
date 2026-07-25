# Cron Watchdog Patterns for Pi Agents

> A **watchdog** is a continuously-firing cron job that monitors agent health, project state, or external systems, and intervenes when something goes wrong.

This document is for **Pi agents** (the LLM), not human operators. If you're a human, you probably want `README.md` instead.

## When to use a watchdog

Reach for a watchdog cron when you're running:

- **Long-running multi-hour tasks** — too long to watch every step yourself
- **Autonomous agent runs** — no human in the loop, you need a safety net
- **Multi-agent pipelines** — one stuck sub-agent can block the whole pipeline
- **Production-like monitoring** — reliability matters more than cleverness

Skip watchdogs for:

- **One-shot scheduled tasks** — use a plain cron, not a watchdog
- **Human-facing reminders** — just send the user a message
- **Tasks that already have a natural progress signal** — don't duplicate signals

## Default mode: sub-agent

All patterns below default to **sub-agent mode** (`--sub-agent` flag in `/cron create`, or `executionMode: "sub-agent"` in `CronCreate`). Why:

- The watchdog's job is to **observe and decide**, not to chat
- Running in main would pollute the main session's context with periodic noise
- Sub-agent can call `CronReport` (which still injects a summary into main if needed)

If the watchdog's RESULT is itself the user-facing summary (e.g. "here's the daily standup"), switch to **main mode** (`--main`).

---

## Pattern 1 — Context window guard ⭐ most important

**Catches:** Context overflow, gradual quality degradation, eventual silent truncation.

**Frequency:** Every 5–10 minutes.

**Cron:** `*/5 * * * *`

**Prompt (sub-agent):**
```
Check the current session's context usage. You can read /proc/<pid>/status or any
tool that exposes token counts; if not available, estimate by summing message lengths.

If > 60% of the model's context limit: send a steer message to main session —
  "Context at NN%. Consider /compact before continuing."
If > 80%: send a more urgent steer —
  "Context critical at NN%. Compact now or split into sub-task."
If > 95%: send —
  "Context overflow imminent. Pause work, compact immediately, then continue."

Always CronReport with status=completed and a 1-line summary.
```

**Tip:** Adapt the thresholds to your actual model. Pi's context size depends on the model (`ctx.model.contextWindow` is accessible in extension context).

---

## Pattern 2 — Stuck / loop detection

**Catches:** Agent calling the same tool with the same arguments repeatedly, recursive logic loops.

**Frequency:** Every 2–3 minutes (faster than context monitor because loops waste tokens fast).

**Cron:** `*/2 * * * *`

**Prompt (sub-agent):**
```
Inspect the last 10 assistant turns in the main session (use session-manager API or
read the conversation transcript).

Count tool calls. If the SAME tool with IDENTICAL arguments appears 3+ times in the
last 5 calls, the agent is looping.

If looping detected, send a steer to main:
  "You just called <tool> <N> times with the same args. Looks like a loop.
   Stop and reconsider your approach. Try a different angle."

Also check for repeated near-identical LLM responses (high semantic similarity, no
new tool calls, no new information) — that suggests "thinking in circles".

Always CronReport when done.
```

**Why this matters:** This is the #1 reported agent failure mode in production (Cursor forum, OpenClaw incidents, n8n heartbeat posts). Most loops trace to "no explicit definition of done".

---

## Pattern 3 — Token burn rate monitor

**Catches:** Runaway cost from infinite loops or context bloat.

**Frequency:** Every 5–10 minutes.

**Cron:** `*/5 * * * *`

**Prompt (sub-agent):**
```
Compute the current session's token burn rate:
  rate = total_tokens_used / minutes_since_session_start

If rate > 1000 tok/min: send steer — "Token burn rate is N/min. Slow down or compact."
If cumulative cost this session > $5: send steer — "Session cost exceeded $5. Pause and review."
If you can hit the LLM provider's usage API (Anthropic / OpenAI dashboard), use ground-truth
numbers instead of estimating.

Always CronReport.
```

**Real-world precedent:** A Medium post titled "The $12,000 Infinite Loop" documented an agent that recursively spun up Kubernetes clusters to fix a syntax error, charging $50/min until budget alarm fired.

---

## Pattern 4 — Build / test heartbeat

**Catches:** Silent build breaks mid-task, test regressions you didn't notice.

**Frequency:** Every 5–15 minutes.

**Cron:** `*/5 * * * *`

**Prompt (sub-agent):**
```
Run the project's build/test command. Look in package.json scripts, pom.xml phases,
Makefile, or Cargo.toml.

If exit code != 0: send steer to main —
  "Build/test broken since last check. Last error: <first 10 lines of stderr>."
If exit code = 0 but warning count increased by > 10 since last check:
  send steer — "Build succeeded but N new warnings. Worth reviewing."
If tests passed but coverage dropped: send steer — "Coverage dropped by N%."

CronReport when done.
```

**Tip:** Cache the last exit code / warning count locally so you can diff.

---

## Pattern 5 — Disk / memory pressure

**Catches:** Build cache fills disk, OOM during heavy tasks.

**Frequency:** Every 30 minutes.

**Cron:** `*/30 * * * *`

**Prompt (sub-agent):**
```
Run `df -h .` (current working dir's filesystem).
Run `free -h` (memory).

If any mount > 85%: send steer — "Disk usage at NN%. Consider cleaning build cache, tmp/, node_modules/."
If any mount > 95%: send steer — "Disk critical. Stop writes immediately."
If memory > 90% of total: send steer — "Memory at NN%. Watch for OOM."

CronReport when done.
```

---

## Pattern 6 — Background process watchdog

**Catches:** A long-running process (compile, deploy, migration) you started has hung or crashed silently.

**Frequency:** Every 1–5 minutes WHILE the process is running.

**Cron:** `*/1 * * * *`

**Prompt (sub-agent):**
```
Check if process <pid> or <process_name> is still running.

If process exited: send steer —
  "Background process <name> finished. Exit code: <code>. Output tail: <last 5 lines>."
If still running but no new stdout for > N minutes: send steer —
  "Process <name> silent for N min. May be hung. Consider kill -9 + restart."

CronReport when done.
```

**Tip:** Use `--once` if the watchdog should auto-archive after the process finishes.

---

## Pattern 7 — External API rate limit

**Catches:** Hitting GitHub/npm/Docker Hub rate limits mid-task and silently failing.

**Frequency:** Every 10 minutes.

**Cron:** `*/10 * * * *`

**Prompt (sub-agent):**
```
If you're hitting an external API, check `X-RateLimit-Remaining` headers on the
last response (or curl -I <endpoint>).

If remaining < 10% of limit: send steer —
  "Rate limit at N%. Slow down or wait <X-RateLimit-Reset> seconds."
If remaining == 0: send steer —
  "Rate-limited. Pause work until reset."

CronReport when done.
```

---

## Combining watchdogs — suggested starter kit

You can run multiple watchdogs in parallel. They share the cron store and fire independently.

```bash
/cron create "*/5 * * * *" "Context guard: check token usage, alert if > 60%" --sub-agent
/cron create "*/2 * * * *" "Stuck detection: check last 10 tool calls for repeats" --sub-agent
/cron create "*/5 * * * *" "Token burn: estimate rate, alert if > 1000 tok/min" --sub-agent
/cron create "*/15 * * * *" "Build heartbeat: run tests, alert on regression" --sub-agent
/cron create "*/30 * * * *" "Disk pressure: df -h, alert if > 85%" --sub-agent
```

For most projects, this 5-watchdog kit catches the common failure modes without overwhelming the scheduler (max 1 cron fire every ~2 min on average).

---

## Anti-patterns

❌ **Don't use sub-agent mode for human-readable summaries.**
   If the user's gonna READ the output (daily standup, weekly report), use `--main`. Sub-agent is for monitoring-and-decide.

❌ **Don't fire faster than 2 min.**
   Cron tick is every 15s, but firing every minute = 1440 fires/day per watchdog. Five watchdogs × 1440 = ~7000 fires/day. Each fire spawns a sub-agent. That's expensive.

❌ **Don't watch something you can't act on.**
   If a watchdog can only alert and no remediation is possible, it's noise.

❌ **Don't forget to clean up.**
   When a long task finishes, delete its watchdogs (`/cron delete <id>`). Or use `--once` for fire-once watchdogs that self-archive.

❌ **Don't create overlapping watchdogs.**
   "Context overflow" and "token burn rate" overlap. Pick one, not both, unless you have a reason.

❌ **Don't make watchdogs in main mode.**
   A 5-min-fire main-mode watchdog will drown the user's conversation in periodic alerts. Always sub-agent unless the output IS the deliverable.

---

## See also

- `README.md` — general overview and user-facing usage
- The `CronReport` tool — required to call after every watchdog fire (for audit trail)
- `/cron history` and `/cron fires <id>` — review past watchdog behavior
</content>
</invoke>