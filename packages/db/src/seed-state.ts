// The process-wide faker seed, kept apart from factories.ts so seeders (and the CLI) can set and
// report it without importing faker, an optional dependency.

let seed = Number(globalThis.process?.env?.CALDERA_SEED) || Math.floor(Math.random() * 2 ** 31)
const listeners = new Set<(seed: number) => void>()

export function currentSeed(): number {
  return seed
}

export function changeSeed(value: number) {
  seed = value
  for (const listener of listeners) listener(value)
}

export function onSeedChange(listener: (seed: number) => void) {
  listeners.add(listener)
}
