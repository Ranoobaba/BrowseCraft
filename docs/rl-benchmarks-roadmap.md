# RL Benchmark Roadmap (Deferred)

External benchmarks stay deferred until the voxel.exec data pipeline is stable.

## Deferred Benchmarks

- SpartQA
- StepGame
- FloorplanQA
- MineBench transfer evals

## Entry Criteria

Start benchmark integration only after all conditions are true:

- Build and text-QA task generation are deterministic and covered by tests.
- `seed=45` fixtures remain stable unless intentionally updated.
- The baseline and collection scripts run end to end against the TypeScript simulator.
- Stage manifest export is validated for `spatial-sft`, `spatial-grpo`, `creative-sft`, and `creative-grpo`.
- The live backend and mod are stable on the `build.apply` / `build.result` protocol.

## Planned Integration Sequence

1. Add one benchmark adapter at a time, starting with MineBench-style evals.
2. Reuse the voxel.exec execution path instead of adding another simulator.
3. Export benchmark reports as JSONL plus summary stats.
4. Compare base, SFT, and RL checkpoints with the same manifest tooling.
