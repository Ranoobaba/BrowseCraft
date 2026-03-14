# Instructions For Coding Agents Working With This Repo

## Architecture

BrowseCraft is now a hard-cut voxel.exec stack:

- `sim/` is a strict TypeScript package for task generation, execution, grading, collection, curriculum, and export.
- `backend/` is a TypeScript HTTP/WebSocket server that accepts one chat prompt plus a local world snapshot, asks the model for JavaScript once, executes it, and emits `build.apply`.
- `mod/` is a Fabric client that captures a bounded voxel snapshot, submits `/chat`, applies absolute block diffs, and acknowledges `build.result`.

There is no Python simulator path, no FastAPI backend, no multi-turn tool protocol, no `/v1/search`, no `/v1/imagine`, and no overlay or blueprint runtime.

## Project Structure

- `sim/src/world`: authoritative headless voxel world and world setup helpers
- `sim/src/tasks`: build tiers, deterministic RNG port, geometry helpers, creative prompts
- `sim/src/text-qa`: single-turn text QA generation and grading
- `sim/src/execute`: code extraction, DSL prompt, sandbox execution, voxel primitives
- `sim/src/grading`: build metrics, rewards, creative renderer, creative judging
- `sim/src/collect`: provider-agnostic collection and Anthropic adapters
- `sim/src/curriculum`: rolling reward-based curriculum weights
- `sim/src/export`: JSONL IO and stage manifest export
- `sim/scripts`: `collect`, `baseline`, `export`, `analyze`, `generate-tasks`
- `backend/src`: config, sessions, websocket manager, chat orchestration, server
- `mod/src/client/java/dev/browsecraft/mod`: Fabric chat client, backend protocol, snapshot/apply logic

## Preferred Validation Workflow

Run these before considering a change done:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim test
pnpm --filter @browsecraft/backend test
cd ~/BrowseCraft/mod && gradle test
cd ~/BrowseCraft/mod && gradle build
```

If you change TypeScript package boundaries, also run:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim build
pnpm --filter @browsecraft/backend build
```

## Live Iteration

Backend:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/backend dev
```

Client:

```bash
cd ~/BrowseCraft/mod
gradle runClient
```

In game, use:

- `/chat <message>`
- `/session new`
- `/session list`
- `/session switch <id>`

## Backend Runtime

`POST /v1/chat` accepts:

- `clientId`
- `message`
- `worldId?`
- `sessionId?`
- `worldContext`

`worldContext` is the mod-captured player snapshot plus a coord-keyed local voxel snapshot.

The runtime flow is:

1. The mod captures a radius-24 snapshot around the player.
2. The backend builds the DSL system prompt and makes one model call.
3. `executeCode(...)` runs the returned JavaScript against the headless world.
4. The backend emits `build.apply` with absolute block changes.
5. The mod applies those changes with `fill` and `setblock` batches, then sends `build.result`.
6. The backend writes the exchange into the active session and emits `chat.response`.

The only WebSocket events that matter now are:

- server -> client: `chat.delta`, `build.apply`, `chat.response`, `error`
- client -> server: `build.result`

## Sandbox Notes

The voxel DSL lives in `sim/src/execute`.

- `block`
- `box`
- `line`
- `sphere`
- `cylinder`
- `inspect`
- `playerPos`
- `undo`

The runtime executes through `just-bash`'s `js-exec` QuickJS sandbox via `Bash({ javascript: { bootstrap } })`.
The workspace carries a local patch for `just-bash@2.13.0` in `patches/just-bash@2.13.0.patch` because the published bundle points `js-exec` at the wrong worker file.

## Task And Data Workflow

Generate tasks:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim generate-tasks --mode build --seed 45 --count 2 --output sim/runs/build_seed45.jsonl
pnpm --filter @browsecraft/sim generate-tasks --mode text-qa --seed 45 --count 2 --output sim/runs/text_qa_seed45.jsonl
pnpm --filter @browsecraft/sim generate-tasks --mode creative --seed 45 --count 10 --output sim/runs/creative_seed45.jsonl
```

Collect trajectories:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim collect --mode build --model claude-sonnet-4-5 --seed 45 --per-tier 2 --output sim/runs/build.jsonl
pnpm --filter @browsecraft/sim collect --mode text_qa --model claude-sonnet-4-5 --seed 45 --per-tier 2 --output sim/runs/text_qa.jsonl
pnpm --filter @browsecraft/sim collect --mode creative --model claude-sonnet-4-5 --seed 45 --count 10 --output sim/runs/creative.jsonl
```

Baseline summary:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim baseline --model claude-sonnet-4-5 --seed 45 --per-tier 2
```

Analyze collected trajectories:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim analyze --input sim/runs/build.jsonl
```

Export stage manifests for veRL/TRL:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim export --input sim/runs/all_episodes.jsonl --output-dir sim/runs/manifests
```

This emits:

- `spatial-sft.jsonl`
- `spatial-grpo.jsonl`
- `creative-sft.jsonl`
- `creative-grpo.jsonl`

## Seed 45 Convention

`seed=45` is the validation seed for deterministic task generation.

- `sim/test/fixtures/seed45_build_tasks.json`
- `sim/test/fixtures/seed45_text_qa_tasks.json`

If you change deterministic generation logic, regenerate those fixtures only when the change is intentional and verified against the old authoritative behavior.

## Reward And Export Rules

- Build rewards are format-gated by execution success.
- Efficiency is primitive-count based, not tool-count based.
- GRPO exports must use `reward_normalized`, never `reward_binary`.
- Creative trajectories use heuristic prefiltering before vision judging.
- Text QA stays single-turn and produces SFT-only data.
