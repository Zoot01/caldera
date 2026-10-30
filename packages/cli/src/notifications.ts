import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CalderaError } from '@caldera/core'
import { dialectOf, resolveStub } from './make.js'
import { exportsOfKind, notificationFiles, type Project } from './project.js'

interface NotificationLike {
  name: string
  channels: Record<string, unknown>
  via: unknown
  queue: { queue?: string } | null
}

/** Every notification exported from src/notifications, with its export name and file. */
export async function loadNotifications(project: Project): Promise<{ file: string; exportName: string; notification: NotificationLike }[]> {
  const found = []
  for (const file of notificationFiles(project)) {
    for (const { exportName, value } of exportsOfKind<NotificationLike>(await project.load(file), 'caldera.notification')) found.push({ file, exportName, notification: value })
  }
  return found
}

export const NOTIFICATIONS_TABLE_FILE = 'src/db/tables/caldera-notifications.ts'

/** `caldera notifications:table`: writes the database channel's table for this app's dialect; your migrations create it. */
export function notificationsTable(project: Project, options: { force?: boolean } = {}) {
  if (existsSync(project.path(NOTIFICATIONS_TABLE_FILE)) && !options.force) {
    throw new CalderaError('file_exists', `Refusing to overwrite ${NOTIFICATIONS_TABLE_FILE}. Pass --force to replace.`, { files: [NOTIFICATIONS_TABLE_FILE] })
  }
  const stub = dialectOf(project) === 'sqlite' ? 'notifications-table-sqlite' : 'notifications-table'
  mkdirSync(dirname(project.path(NOTIFICATIONS_TABLE_FILE)), { recursive: true })
  writeFileSync(project.path(NOTIFICATIONS_TABLE_FILE), resolveStub(project, stub).template)
  return {
    schemaVersion: 1 as const,
    created: [NOTIFICATIONS_TABLE_FILE],
    hints: [
      'Create it with `caldera db:generate` then `caldera db:migrate` (or `caldera db:push` in development).',
      "Pass `channels: [databaseChannel()]` (from '@caldera/notifications/database') to notificationsProvider().",
    ],
  }
}
