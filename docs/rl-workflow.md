# BrowseCraft RL Workflow

BrowseCraft RL data now comes from a single-turn voxel.exec pipeline.
The model writes JavaScript once, the code runs against the headless voxel world, and the result is graded into JSONL manifests for downstream Python trainers.

## 1. Deterministic Task Generation

Use `seed=45` when validating generation changes.

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim generate-tasks --mode build --seed 45 --count 2 --output sim/runs/build_seed45.jsonl
pnpm --filter @browsecraft/sim generate-tasks --mode text-qa --seed 45 --count 2 --output sim/runs/text_qa_seed45.jsonl
pnpm --filter @browsecraft/sim generate-tasks --mode creative --seed 45 --count 10 --output sim/runs/creative_seed45.jsonl
```

## 2. Baselines

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim baseline --model claude-sonnet-4-5 --seed 45 --per-tier 2
```

## 3. Trajectory Collection

Spatial build tasks:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim collect --mode build --model claude-sonnet-4-5 --seed 45 --per-tier 2 --output sim/runs/build.jsonl
```

Text QA:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim collect --mode text_qa --model claude-sonnet-4-5 --seed 45 --per-tier 2 --output sim/runs/text_qa.jsonl
```

Creative building:

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim collect --mode creative --model claude-sonnet-4-5 --seed 45 --count 10 --output sim/runs/creative.jsonl
```

## 4. Analyze Trajectories

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim analyze --input sim/runs/build.jsonl
```

## 5. Export Stage Manifests

```bash
cd ~/BrowseCraft
pnpm --filter @browsecraft/sim export --input sim/runs/all_episodes.jsonl --output-dir sim/runs/manifests
```

Stage outputs:

- `spatial-sft.jsonl`
- `spatial-grpo.jsonl`
- `creative-sft.jsonl`
- `creative-grpo.jsonl`

## 6. Reward Rules

- Build rewards are format-gated by execution success.
- Efficiency uses primitive count.
- GRPO always consumes `reward_normalized`.
- Creative builds use heuristic prefiltering before the vision judge call.
