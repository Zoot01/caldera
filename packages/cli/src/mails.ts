import { exportsOfKind, mailFiles, type Project } from './project.js'

interface MailLike {
  name: string
  preview: unknown
  options: { subject: unknown }
}

/** Every mail exported from src/mail, with its export name and file. */
export async function loadMails(project: Project): Promise<{ file: string; exportName: string; mail: MailLike }[]> {
  const found = []
  for (const file of mailFiles(project)) {
    for (const { exportName, value } of exportsOfKind<MailLike>(await project.load(file), 'caldera.mail')) found.push({ file, exportName, mail: value })
  }
  return found
}
