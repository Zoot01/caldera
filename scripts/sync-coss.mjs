#!/usr/bin/env node
// `pnpm sync:coss`: refreshes the coss ui components vendored in create-caldera's blank kit.
//
// coss ui (https://coss.com/ui, MIT) is distributed through the shadcn registry. This runs the
// pinned shadcn CLI's `init @coss/style` in a scratch Vite project, then copies the result into
// kits/blank/resources: the components, their utils and hook, and app.css (coss's theme with
// Caldera's changes below). New apps get these files as their own code. Review with `git diff`.
//
// Only the components a kit uses are vendored (with the ones they import): Tailwind generates CSS
// for every class in resources/, so unused components would cost every app ~30KB of CSS. Apps add
// the rest with `npx shadcn add @coss/<name>` (their components.json points at coss's registry).

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHADCN = 'shadcn@4.23.0'
const KITS = new URL('../packages/create-caldera/kits/', import.meta.url).pathname
const KIT = join(KITS, 'blank')
// What each kit's own code imports from components/ui. Each layer goes over the ones before it
// (blank, then starter, then starter-teams), so it only gets components they don't have.
const USES = {
  blank: ['card', 'toggle-group'],
  starter: ['alert', 'alert-dialog', 'avatar', 'breadcrumb', 'button', 'checkbox', 'field', 'input', 'label', 'dialog', 'menu', 'otp-field', 'sidebar', 'spinner'],
  'starter-teams': ['badge'],
}

const scratch = mkdtempSync(join(tmpdir(), 'caldera-coss-'))
const run = (command, args) => execFileSync(command, args, { cwd: scratch, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
try {
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'coss-sync',
      private: true,
      type: 'module',
      dependencies: { react: '^19.3.1', 'react-dom': '^19.3.1' },
      devDependencies: { vite: '^8.3.5', '@vitejs/plugin-react': '^6.1.2', tailwindcss: '^4.3.3', '@tailwindcss/vite': '^4.3.3', typescript: '^5.9.3', '@types/react': '^19.3.0' },
    }),
  )
  writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] }, jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'bundler', strict: true } }))
  writeFileSync(join(scratch, 'vite.config.ts'), "import tailwindcss from '@tailwindcss/vite'\nimport react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [react(), tailwindcss()] })\n")
  mkdirSync(join(scratch, 'src'))
  writeFileSync(join(scratch, 'src/index.css'), '@import "tailwindcss";\n')
  writeFileSync(join(scratch, 'src/main.tsx'), '')
  console.log(`Installing a scratch project in ${scratch}…`)
  run('pnpm', ['install', '--silent'])
  console.log(`Running ${SHADCN} init @coss/style…`)
  run('npx', ['-y', SHADCN, 'init', '@coss/style', '-y', '--no-monorepo', '--silent'])

  // Components: replaced wholesale, so ones coss removed or a kit stopped using disappear too.
  const source = (name) => readFileSync(join(scratch, 'src/components/ui', `${name}.tsx`), 'utf8')
  const copied = {}
  const vendored = new Set()
  for (const [kit, uses] of Object.entries(USES)) {
    const ui = join(KITS, kit, 'resources/components/ui')
    rmSync(ui, { recursive: true, force: true })
    const names = closure(uses, source).filter((name) => !vendored.has(name))
    if (!names.length) continue
    mkdirSync(ui, { recursive: true })
    for (const name of names) {
      writeFileSync(join(ui, `${name}.tsx`), clean(source(name)))
      vendored.add(name)
    }
    copied[kit] = names
  }
  // The helpers components import (cn, and the sidebar's media query), kept with the blank kit.
  for (const file of ['lib/utils.ts', 'hooks/use-media-query.ts']) {
    mkdirSync(join(KIT, 'resources', file, '..'), { recursive: true })
    writeFileSync(join(KIT, 'resources', file), clean(readFileSync(join(scratch, 'src', file), 'utf8')))
  }
  writeFileSync(join(KIT, 'resources/app.css'), appCss(readFileSync(join(scratch, 'src/index.css'), 'utf8')))

  // Dependencies the components need, compared with the kit's.
  const added = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'))
  // An app gets the base template's and the kit's.
  const app = [join(KIT, 'package.json'), join(KIT, '../../template/package.json')].map((file) => JSON.parse(readFileSync(file, 'utf8')))
  const has = (name) => app.some((manifest) => manifest.dependencies?.[name] || manifest.devDependencies?.[name])
  // `geist` is replaced by Fontsource and Inter by Instrument Sans (appCss()); `cn` is an unrelated
  // package coss's registry lists by mistake (lib/utils.ts defines cn); tw-animate-css isn't used by any component.
  const ignored = new Set(['cn', 'geist', '@fontsource-variable/inter', 'tw-animate-css'])
  const missing = Object.keys({ ...added.dependencies, ...added.devDependencies }).filter((name) => !ignored.has(name) && !has(name))
  for (const [kit, names] of Object.entries(copied)) console.log(`kits/${kit}: ${names.join(', ')}`)
  console.log('Also lib/utils.ts, hooks/use-media-query.ts and app.css (kits/blank).')
  if (missing.length) console.log(`Possibly missing from the kits' package.json: ${missing.join(', ')} (needed only if a vendored component imports it)`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

/** The components `names` need: themselves and every `@/components/ui/…` they import, recursively. */
function closure(names, source) {
  const seen = new Set()
  const visit = (name) => {
    if (seen.has(name)) return
    seen.add(name)
    for (const [, dep] of source(name).matchAll(/from ["']@\/components\/ui\/([\w-]+)["']/g)) visit(dep)
  }
  names.forEach(visit)
  return [...seen].sort()
}

/** Vite apps have no React Server Components: the directive only makes Rollup warn. */
function clean(source) {
  return source.replace(/^["']use client["'];?\n+/, '')
}

/**
 * coss's theme as app.css, adjusted for Vite (coss assumes Next.js): fonts from Fontsource instead
 * of `geist` (a next/font package) with their family names, `html` in the sans font (coss applies
 * both font-sans and font-mono, so the mono one wins), Instrument Sans for text, the kit's look
 * over coss's tokens (scripts/coss-theme.css), and the root setup Base UI's portals need.
 * Each edit must find its text: a changed theme fails here instead of shipping half-edited.
 */
function appCss(css) {
  const edits = [
    ['@import "@fontsource-variable/inter";', '@import "@fontsource-variable/instrument-sans";'],
    ['@import "geist";', '@import "@fontsource-variable/geist-mono";'],
    ["--font-heading: 'Inter', sans-serif;", "--font-heading: 'Instrument Sans Variable', sans-serif;"],
    ["--font-mono: 'Geist Mono', monospace;", "--font-mono: 'Geist Mono Variable', monospace;"],
    ["--font-sans: 'Inter', sans-serif;", "--font-sans: 'Instrument Sans Variable', sans-serif;"],
    [/(html \{\s*@apply font-sans) font-mono;/, '$1;'],
  ]
  for (const [pattern, replacement] of edits) {
    const found = typeof pattern === 'string' ? css.includes(pattern) : pattern.test(css)
    if (!found) throw new Error(`coss's CSS changed: can't find ${pattern}. Update appCss() in scripts/sync-coss.mjs.`)
    css = css.replace(pattern, replacement)
  }
  return `/* Tailwind CSS v4 and the coss ui theme (light in :root, dark in .dark). Colors, radius and fonts
   are CSS variables: change them here. Refreshed in Caldera with \`pnpm sync:coss\`. */
${css.trimEnd()}

${readFileSync(new URL('./coss-theme.css', import.meta.url), 'utf8').trimEnd()}

/* Base UI renders dialogs, menus and toasts at the end of <body>: isolating the app keeps them
   above it, and \`relative\` on body is for iOS Safari 26. */
body {
  position: relative;
}

#app {
  isolation: isolate;
  position: relative;
  display: flex;
  min-height: 100svh;
  flex-direction: column;
}
`
}
