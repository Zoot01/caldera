import { exportsOfKind, listenerFiles, type Project } from './project.js'

interface ListenerLike {
  name: string
  event: { name: string }
  queued?: { job: { name: string } }
}

/** Every listener exported from src/listeners, with its export name and file. */
export async function loadListeners(project: Project): Promise<{ file: string; exportName: string; listener: ListenerLike }[]> {
  const found = []
  for (const file of listenerFiles(project)) {
    for (const { exportName, value } of exportsOfKind<ListenerLike>(await project.load(file), 'caldera.listener')) found.push({ file, exportName, listener: value })
  }
  return found
}
