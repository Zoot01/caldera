import { CalderaError, createManager, defineProvider, type DriverDefinition, type Manager, type RegisterContext } from '@caldera-js/core'
import { createDisk, type Disk } from './disk.js'
import { setDefaultStorage } from './files.js'
import { setUploadSecret } from './uploads.js'
import type { StorageCapabilities, StorageDriver } from './driver.js'
import { memoryStorage, memoryStorageDriver } from './memory.js'
import { r2StorageDriver } from './r2.js'

export interface StorageConfig<N extends string = string> {
  default: NoInfer<N>
  /** Optional entries are allowed, for disks that only exist when their env is set. */
  disks: { [K in N]?: { driver: string; [option: string]: unknown } | undefined }
  /** Signs direct-upload tokens and the refs they complete with (`uploadRoutes`, `zupload`). Use APP_KEY. */
  uploadSecret?: string
}

export interface FakeDisk extends Disk {
  assertExists(key: string): Promise<void>
  assertMissing(key: string): Promise<void>
  assertCount(prefix: string, count: number): Promise<void>
  /** Puts the real disk back. */
  restore(): void
}

/** `c.var.storage`: the default disk, plus `disk(name)` for the others. */
export type StorageService<N extends string = string> = Disk & {
  disk(name: N): Disk
  /** Swaps a disk (default: the default one) for a real in-memory disk, with assertions. */
  fake(name?: N): FakeDisk
  readonly manager: Manager<StorageDriver, StorageCapabilities, N>
}

/** Built in. Drivers with their own dependencies ship as subpaths, so edge bundles never see them. */
export const STORAGE_DRIVERS: readonly DriverDefinition<StorageDriver, StorageCapabilities>[] = [memoryStorageDriver, r2StorageDriver]

const HINTS = {
  local: "It's in '@caldera-js/storage/local': import { localStorageDriver } from it and pass `drivers: [localStorageDriver]`.",
  s3: "It's in '@caldera-js/storage/s3': import { s3StorageDriver } from it and pass `drivers: [s3StorageDriver]`.",
}

export function createStorage<const N extends string>(
  config: StorageConfig<N>,
  options: { drivers?: readonly DriverDefinition<StorageDriver, StorageCapabilities>[] } = {},
): StorageService<N> {
  const manager = createManager({ kind: 'storage', drivers: [...STORAGE_DRIVERS, ...(options.drivers ?? [])], config: { default: config.default, instances: config.disks }, hints: HINTS })
  const disks = new Map<string, Disk>()
  const fakes = new Map<string, FakeDisk>()
  const disk = (name: N): Disk => {
    const fake = fakes.get(name)
    if (fake) return fake
    let found = disks.get(name)
    if (!found) {
      found = createDisk(name, manager.use(name), manager.capabilities(name))
      disks.set(name, found)
    }
    return found
  }
  const fake = (name: N = config.default): FakeDisk => {
    // A real disk in memory, with the real disk's capabilities and links: those are made from its
    // config without touching its files, so a page shows the same URL under a fake, and the local
    // disk's signed links (served by storageRoutes through this service) reach the fake's files.
    const real = manager.use(name)
    const links = Object.fromEntries((['url', 'signedUrl', 'signedUpload', 'verifySignature'] as const).flatMap((m) => (real[m] ? [[m, real[m].bind(real)]] : [])))
    const memory = createDisk(name, { ...memoryStorage(), ...links }, manager.capabilities(name))
    const fail = (message: string) => {
      throw new CalderaError('assertion_failed', message)
    }
    const faked: FakeDisk = Object.assign({}, memory, {
      async assertExists(key: string) {
        if (!(await memory.exists(key))) fail(`Expected "${key}" to exist on the "${name}" disk.`)
      },
      async assertMissing(key: string) {
        if (await memory.exists(key)) fail(`Expected "${key}" not to exist on the "${name}" disk.`)
      },
      async assertCount(prefix: string, count: number) {
        let found = 0
        for await (const _ of memory.listAll(prefix)) found++
        if (found !== count) fail(`Expected ${count} file(s) under "${prefix}" on the "${name}" disk; found ${found}.`)
      },
      restore() {
        if (fakes.get(name) === faked) fakes.delete(name)
      },
    })
    fakes.set(name, faked)
    return faked
  }
  return new Proxy({} as StorageService<N>, {
    get(_target, key) {
      if (key === 'disk') return disk
      if (key === 'fake') return fake
      if (key === 'manager') return manager
      const value = disk(config.default)[key as keyof Disk]
      return typeof value === 'function' ? (value as Function).bind(disk(config.default)) : value
    },
  })
}

/**
 * Registers `storage` from your config: `storageProvider((app) => app.config.storage, { drivers: [localStorageDriver] })`.
 * Disks are validated at boot and connect on first use.
 */
export function storageProvider<const N extends string>(
  resolve: (app: RegisterContext<unknown>) => StorageConfig<N>,
  options: { drivers?: readonly DriverDefinition<StorageDriver, StorageCapabilities>[] } = {},
) {
  return defineProvider({
    name: 'storage',
    register: (app) => {
      const config = resolve(app)
      const storage = createStorage(config, options)
      setDefaultStorage(storage)
      setUploadSecret(config.uploadSecret)
      return { storage }
    },
    shutdown: async ({ services }) => {
      await services.storage.manager.purge()
    },
  })
}
