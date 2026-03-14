/** Python-compatible Random implementation for exact seed-45 task regeneration. */

type SeedInput = number | string | bigint;

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** PythonRandom reproduces the subset of CPython's random.Random used by the old pipeline. */
export class PythonRandom {
  #mt = new Uint32Array(N);
  #index = N + 1;

  constructor(seed: SeedInput) {
    this.seed(seed);
  }

  /** Seed the generator with Python's arbitrary-size integer seeding rules. */
  seed(value: SeedInput): void {
    const absolute = normalizeSeedValue(value);
    const words = bigIntToSeedWords(absolute);
    this.initByArray(words);
  }

  /** Return a Python-style float in [0, 1). */
  random(): number {
    const a = this.genrandInt32() >>> 5;
    const b = this.genrandInt32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** Return an integer in the inclusive range [min, max]. */
  randint(min: number, max: number): number {
    return min + this.randBelow(max - min + 1);
  }

  /** Choose one element with Python's randbelow semantics. */
  choice<T>(sequence: readonly T[]): T {
    return sequence[this.randBelow(sequence.length)]!;
  }

  /** Shuffle a list in place with Python's index sampling order. */
  shuffle<T>(sequence: T[]): void {
    for (let index = sequence.length - 1; index > 0; index -= 1) {
      const selected = this.randBelow(index + 1);
      [sequence[index], sequence[selected]] = [sequence[selected]!, sequence[index]!];
    }
  }

  /** Weighted sampling used by the old curriculum sampler. */
  choices<T>(population: readonly T[], weights: readonly number[], k = 1): T[] {
    const cumulative: number[] = [];
    let total = 0;

    for (const weight of weights) {
      total += weight;
      cumulative.push(total);
    }

    const results: T[] = [];
    for (let count = 0; count < k; count += 1) {
      const target = this.random() * total;
      let low = 0;
      let high = population.length - 1;

      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (target < cumulative[middle]!) {
          high = middle;
        } else {
          low = middle + 1;
        }
      }

      results.push(population[low]!);
    }

    return results;
  }

  /** Python's getrandbits backing for randbelow. */
  getrandbits(k: number): bigint {
    if (k <= 0) {
      return 0n;
    }

    let bitsRemaining = k;
    let result = 0n;
    let shift = 0n;

    while (bitsRemaining >= 32) {
      result |= BigInt(this.genrandInt32()) << shift;
      shift += 32n;
      bitsRemaining -= 32;
    }

    if (bitsRemaining > 0) {
      result |= BigInt(this.genrandInt32() >>> (32 - bitsRemaining)) << shift;
    }

    return result;
  }

  /** Python's randrange helper used for exact integer sampling. */
  randBelow(limit: number): number {
    if (limit <= 0) {
      throw new Error("limit must be > 0");
    }

    const bitLength = limit.toString(2).length;
    while (true) {
      const value = Number(this.getrandbits(bitLength));
      if (value < limit) {
        return value;
      }
    }
  }

  private initGenrand(seed: number): void {
    this.#mt[0] = seed >>> 0;
    for (let index = 1; index < N; index += 1) {
      const previous = this.#mt[index - 1]!;
      this.#mt[index] = (multiply32(previous ^ (previous >>> 30), 1812433253) + index) >>> 0;
    }
    this.#index = N;
  }

  private initByArray(key: Uint32Array): void {
    this.initGenrand(19650218);

    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);

    for (; k > 0; k -= 1) {
      const previous = this.#mt[i - 1]!;
      this.#mt[i] = (
        (this.#mt[i]! ^ multiply32(previous ^ (previous >>> 30), 1664525))
        + key[j]!
        + j
      ) >>> 0;

      i += 1;
      j += 1;

      if (i >= N) {
        this.#mt[0] = this.#mt[N - 1]!;
        i = 1;
      }

      if (j >= key.length) {
        j = 0;
      }
    }

    for (k = N - 1; k > 0; k -= 1) {
      const previous = this.#mt[i - 1]!;
      this.#mt[i] = (
        (this.#mt[i]! ^ multiply32(previous ^ (previous >>> 30), 1566083941))
        - i
      ) >>> 0;

      i += 1;
      if (i >= N) {
        this.#mt[0] = this.#mt[N - 1]!;
        i = 1;
      }
    }

    this.#mt[0] = 0x80000000;
  }

  private genrandInt32(): number {
    let value: number;
    const mag01 = [0x0, MATRIX_A];

    if (this.#index >= N) {
      if (this.#index === N + 1) {
        this.initGenrand(5489);
      }

      let kk = 0;
      for (; kk < N - M; kk += 1) {
        value = (this.#mt[kk]! & UPPER_MASK) | (this.#mt[kk + 1]! & LOWER_MASK);
        this.#mt[kk] = this.#mt[kk + M]! ^ (value >>> 1) ^ mag01[value & 0x1]!;
      }

      for (; kk < N - 1; kk += 1) {
        value = (this.#mt[kk]! & UPPER_MASK) | (this.#mt[kk + 1]! & LOWER_MASK);
        this.#mt[kk] = this.#mt[kk + (M - N)]! ^ (value >>> 1) ^ mag01[value & 0x1]!;
      }

      value = (this.#mt[N - 1]! & UPPER_MASK) | (this.#mt[0]! & LOWER_MASK);
      this.#mt[N - 1] = this.#mt[M - 1]! ^ (value >>> 1) ^ mag01[value & 0x1]!;
      this.#index = 0;
    }

    value = this.#mt[this.#index]!;
    this.#index += 1;

    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;

    return value >>> 0;
  }
}

function normalizeSeedValue(seed: SeedInput): bigint {
  if (typeof seed === "bigint") {
    return seed < 0n ? -seed : seed;
  }

  if (typeof seed === "number") {
    return BigInt(Math.abs(seed));
  }

  const parsed = BigInt(seed);
  return parsed < 0n ? -parsed : parsed;
}

function bigIntToSeedWords(seed: bigint): Uint32Array {
  if (seed === 0n) {
    return new Uint32Array([0]);
  }

  const words: number[] = [];
  let value = seed;
  const mask = 0xffff_ffffn;

  while (value > 0n) {
    words.push(Number(value & mask));
    value >>= 32n;
  }

  return new Uint32Array(words);
}

function multiply32(left: number, right: number): number {
  return Math.imul(left >>> 0, right >>> 0) >>> 0;
}
