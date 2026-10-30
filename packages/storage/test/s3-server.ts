import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwsClient } from 'aws4fetch'

const IMAGE = 'chrislusf/seaweedfs:latest'
export const S3_CREDENTIALS = { accessKeyId: 'caldera', secretAccessKey: 'caldera-secret-key-0123456789' }

/** A real S3 API (SeaweedFS) needs Docker; the S3 tests skip without it. */
export const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/**
 * SeaweedFS's S3 gateway in Docker, with SigV4 credentials enforced (a wrong secret is refused), and
 * one bucket. MinIO no longer publishes free images, so SeaweedFS stands in as the real S3 server.
 */
export async function startS3(bucket: string): Promise<{ endpoint: string; stop(): Promise<void> }> {
  const config = mkdtempSync(join(tmpdir(), 'caldera-s3-'))
  writeFileSync(join(config, 's3.json'), JSON.stringify({ identities: [{ name: 'caldera', credentials: [{ accessKey: S3_CREDENTIALS.accessKeyId, secretKey: S3_CREDENTIALS.secretAccessKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }))
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) spawnSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' })
  for (let attempt = 1; ; attempt++) {
    const port = await freePort()
    // The config is copied in rather than mounted: Docker Desktop doesn't share macOS temp folders.
    const create = spawnSync('docker', ['create', '--rm', '-p', `127.0.0.1:${port}:8333`, IMAGE, 'server', '-dir=/data', '-s3', '-s3.config=/etc/s3.json', '-ip.bind=0.0.0.0'], { encoding: 'utf8' })
    const id = create.stdout.trim()
    const copied = id && spawnSync('docker', ['cp', join(config, 's3.json'), `${id}:/etc/s3.json`]).status === 0
    const started = copied && spawnSync('docker', ['start', id], { encoding: 'utf8' }).status === 0
    if (!started) {
      if (id) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
      if (attempt < 5) continue
      throw new Error(`SeaweedFS didn't start: ${create.stderr}`)
    }
    const endpoint = `http://127.0.0.1:${port}`
    const client = new AwsClient({ ...S3_CREDENTIALS, region: 'us-east-1', service: 's3' })
    // Ready once the bucket can be created (the S3 gateway starts after the master and volume server).
    for (let i = 0; i < 120; i++) {
      const created = await client.fetch(`${endpoint}/${bucket}`, { method: 'PUT' }).catch(() => undefined)
      if (created && (created.ok || created.status === 409)) {
        // The first write allocates a storage volume (~15s); do it now so tests get normal latency.
        await client.fetch(`${endpoint}/${bucket}/.warmup`, { method: 'PUT', body: 'ok' })
        await client.fetch(`${endpoint}/${bucket}/.warmup`, { method: 'DELETE' })
        return {
          endpoint,
          async stop() {
            spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
            rmSync(config, { recursive: true, force: true })
          },
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
    throw new Error('SeaweedFS started but its S3 gateway never answered.')
  }
}
