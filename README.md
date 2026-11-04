# @aiwayds/pi-kimi-cron

Cron scheduling extension for the [Pi](https://github.com/earendil-works/pi) coding agent. Schedule prompts to be injected into the conversation on a recurring schedule using standard 5-field cron expressions.

## Acknowledgments

This extension is inspired by and based on the cron scheduling feature from
[Kimi Code](https://github.com/MoonshotAI/kimi-code) by MoonshotAI.

We thank the Kimi Code team for open-sourcing their implementation, which made
this Pi adaptation possible. The original architecture, including the tick-loop
scheduler, deterministic jitter, and prompt injection mechanism, was ported from
Kimi Code's `packages/agent-core/src/tools/cron/` module.

## Usage

### For Agents (Primary Use Case)

This extension is designed for **agent-first** usage. The LLM calls the tools directly:

- `CronCreate` — Schedule a task with a cron expression
- `CronDelete` — Remove a scheduled task
- `CronList` — List all scheduled tasks

### For Humans (Natural Language)

Human users interact via **natural language**. The LLM translates your intent into
cron expressions:

- "每周一早上9点生成周报" → `CronCreate({cron: "0 9 * * 1", prompt: "生成周报"})`
- "every day at 6pm check build status" → `CronCreate({cron: "0 18 * * *", prompt: "check build status"})`
- "list my scheduled tasks" → `CronList({})`

## Installation

```bash
npm install @aiwayds/pi-kimi-cron
```

Then register the extension with Pi (add to your Pi extension configuration):

```ts
import cronSchedulerExtension from '@aiwayds/pi-kimi-cron';

export default cronSchedulerExtension;
```

`@earendil-works/pi-coding-agent` and `typebox` are peer dependencies — Pi provides both at runtime.

## Tools

| Tool | Description |
| ------ | ------------- |
| `CronCreate` | Create a scheduled task with a cron expression and prompt |
| `CronDelete` | Delete a task by its 8-char hex id |
| `CronList` | List all tasks with next fire times |

### CronCreate parameters

| Parameter | Type | Description |
| ----------- | ------ | ------------- |
| `cron` | string | 5-field cron expression, e.g. `"*/5 * * * *"` |
| `prompt` | string | Prompt text injected when the task fires |
| `recurring` | boolean (optional) | Repeat after firing (default `true`); `false` = one-shot |

## Cron Syntax

Standard 5-field cron: `minute hour day-of-month month day-of-week`

```
*/5 * * * *     every 5 minutes
0 * * * *       every hour
0 9 * * 1-5     weekdays at 9:00 AM
0 18 * * *      daily at 6:00 PM
0 0 1 * *       monthly on the 1st
```

Supported field syntax: `*`, lists (`1,3,5`), ranges (`1-5`), steps (`*/2`), and month/day names (`jan`, `mon`).

## Examples

```
CronCreate({ cron: "*/5 * * * *", prompt: "check the build status" })
CronCreate({ cron: "0 9 * * 1", prompt: "生成周报" })
CronCreate({ cron: "0 0 1 * *", prompt: "summarize last month", recurring: false })
CronList({})
CronDelete({ id: "a1b2c3d4" })
```

## Configuration (Environment Variables)

| Variable | Description |
| ---------- | ------------- |
| `PI_CRON_DEBUG=1` | Enable verbose scheduler logging to stderr |
| `PI_CRON_NO_JITTER=1` | Disable deterministic per-task jitter |
| `PI_CRON_CLOCK=fixed` | Use fixed clock (testing, requires `PI_CRON_CLOCK_FIXED_MS`) |
| `PI_CRON_CLOCK=offset` | Use offset clock (testing, requires `PI_CRON_CLOCK_OFFSET_MS`) |

## Persistence

Tasks are stored as JSON files at:

```
~/.pi/agent/cron/<session-id>/<8-hex-id>.json
```

## Limitations

**Tasks only fire while Pi is running.** The scheduler uses an in-process `setInterval` tick loop (15s interval). When Pi exits, no tasks fire. On restart, tasks are rehydrated from disk and resume from their last fire time — missed fires are coalesced, not replayed.

## Architecture

```
src/
  index.ts               Extension entry point (tools + lifecycle hooks)
  types.ts               CronTask interface
  cron-expr.ts           5-field cron parser + next-fire calculator
  jitter.ts              Deterministic per-task jitter
  cron-fire-xml.ts       XML envelope renderer for fire injection
  session-store.ts       In-memory task map
  clock.ts               Clock sources (system / fixed / offset)
  per-id-json-store.ts   Generic per-id JSON file store with atomic writes
  persist.ts             Cron task persistence wrapper
  scheduler.ts           Tick-loop engine (15s interval)
```

## License

[Apache-2.0](./LICENSE)
