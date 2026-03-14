/** Rolling reward summaries and curriculum weighting. */

type RewardRow = {
  tier: string;
  taskId: string;
  rewardNormalized?: number;
  rewardBinary?: number;
  reward?: number;
  category?: string;
};

/** Convert stored reward fields to one scalar. */
export function rowReward(row: RewardRow): number {
  if (typeof row.reward === "number") {
    return row.reward;
  }
  if (typeof row.rewardNormalized === "number") {
    return row.rewardNormalized;
  }
  if (typeof row.rewardBinary === "number") {
    return row.rewardBinary;
  }
  throw new Error("row is missing reward, rewardNormalized, and rewardBinary");
}

/** Treat rewards above threshold as successes. */
export function rewardToSuccess(reward: number, threshold = 0.8): boolean {
  return reward >= threshold;
}

/** Compute rolling success rates keyed by any string selector. */
export function rollingSuccessRates(
  rows: readonly RewardRow[],
  keyFn: (row: RewardRow) => string,
  windowSize = 100,
  threshold = 0.8,
  selectedKeys: readonly string[] = [],
): Record<string, number> {
  const grouped = new Map<string, boolean[]>();

  for (const row of rows) {
    const key = keyFn(row);
    if (selectedKeys.length > 0 && !selectedKeys.includes(key)) {
      continue;
    }
    const current = grouped.get(key) ?? [];
    current.push(rewardToSuccess(rowReward(row), threshold));
    grouped.set(key, current);
  }

  const results: Record<string, number> = {};
  for (const [key, values] of grouped) {
    const recent = values.slice(-windowSize);
    results[key] = recent.filter(Boolean).length / recent.length;
  }
  return results;
}

/** Compute rolling mean rewards keyed by any string selector. */
export function rollingMeanRewards(
  rows: readonly RewardRow[],
  keyFn: (row: RewardRow) => string,
  windowSize = 100,
  selectedKeys: readonly string[] = [],
): Record<string, number> {
  const grouped = new Map<string, number[]>();

  for (const row of rows) {
    const key = keyFn(row);
    if (selectedKeys.length > 0 && !selectedKeys.includes(key)) {
      continue;
    }
    const current = grouped.get(key) ?? [];
    current.push(rowReward(row));
    grouped.set(key, current);
  }

  const results: Record<string, number> = {};
  for (const [key, values] of grouped) {
    const recent = values.slice(-windowSize);
    results[key] = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  }
  return results;
}

/** Extract tier:family keys from task ids. */
export function taskFamilyKey(taskId: string): string {
  const [tier, family] = taskId.split(":", 3);
  return `${tier}:${family}`;
}

/** Promote mid-performing tiers or categories so RL keeps training where learning is active. */
export function curriculumWeights(rewardLevels: Record<string, number>, low = 0.2, high = 0.7): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const [key, rewardLevel] of Object.entries(rewardLevels)) {
    weights[key] = rewardLevel >= low && rewardLevel <= high ? 2 : 1;
  }
  return weights;
}

/** Split a total count across weighted keys. */
export function weightedTaskCounts(totalTasks: number, keys: readonly string[], weights: Record<string, number>): Record<string, number> {
  if (totalTasks <= 0) {
    throw new Error("totalTasks must be > 0");
  }
  if (keys.length === 0) {
    throw new Error("keys must not be empty");
  }

  const activeWeights = Object.fromEntries(keys.map((key) => [key, weights[key] ?? 1]));
  const totalWeight = Object.values(activeWeights).reduce((sum, value) => sum + value, 0);
  const counts = Object.fromEntries(keys.map((key) => [key, Math.floor((totalTasks * (activeWeights[key] ?? 1)) / totalWeight)])) as Record<string, number>;
  const allocated = Object.values(counts).reduce((sum, value) => sum + value, 0);

  for (const key of keys.slice(0, Math.max(0, totalTasks - allocated))) {
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}
