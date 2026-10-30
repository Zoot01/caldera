// The process-wide faker seed, kept apart from factories.ts so seeders (and the CLI) can set and
// report it without importing faker, an optional dependency. Kept on globalThis: the CLI and the
// app's own code can load two copies of this package, and both must agree on the seed.

interface SeedState {
  seed: number
  listeners: Set<(seed: number) => void>
}

const KEY = Symbol.for('caldera.db.seed')
const registry = globalThis as { [KEY]?: SeedState }
const state = (registry[KEY] ??= { seed: Number(globalThis.process?.env?.CALDERA_SEED) || Math.floor(Math.random() * 2 ** 31), listeners: new Set() })

export function currentSeed(): number {
  return state.seed
}

export function changeSeed(value: number) {
  state.seed = value
  for (const listener of state.listeners) listener(value)
}

export function onSeedChange(listener: (seed: number) => void) {
  state.listeners.add(listener)
}
