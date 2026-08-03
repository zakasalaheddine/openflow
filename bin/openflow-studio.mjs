#!/usr/bin/env node
/**
 * `npm run studio` — the whole install, from a clone.
 *
 * Boots the server, creates the database on first request, opens a browser, and
 * asks for a fal key if there isn't one. Everything it can do without asking, it
 * does; the one question it asks is the one nobody else can answer.
 *
 * It was `npx openflow-studio` until the cold-boot test was actually run. A Next
 * app cannot be built from inside a `node_modules` directory, and shipping a
 * prebuilt `.next` does not save it either — Turbopack satisfies native externals
 * with symlinks under `.next/node_modules/`, and `npm pack` strips those. See
 * `docs/phases/phase-3-video-export-ship.md`. Hence no `bin`, no `files`, and a
 * clone-only README.
 *
 * Plain ESM, no TypeScript and no dependencies beyond Node itself.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.env.PORT ?? '3000'
const url = `http://localhost:${PORT}`

const run = (command, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
  })

// Same gate as the npm scripts. A silent segfault is the worst failure mode
// there is, and this is the one install path where nobody has run npm first.
//
// A file URL, not a bare path: dynamic import() rejects absolute filesystem
// paths, so the version check silently never ran and the launcher booted happily
// onto the Node that segfaults.
await import(pathToFileURL(path.join(root, 'scripts/check-node.mjs')).href)

// The same `.env` Next will read once it boots — `root`, not `process.cwd()`,
// because the server is spawned with its cwd pinned there. Read here too so a
// key already sitting in the file does not produce a prompt asking for it.
// Like Next, an exported variable still wins; a missing file is the norm.
try {
  process.loadEnvFile(path.join(root, '.env'))
} catch {}

/**
 * A key is only needed to generate. Asking for one before the canvas has even
 * opened turns a 30-second install into a signup, so an empty answer is a valid
 * answer — the canvas loads, and Run says what is missing when it is missing.
 */
async function askForKey() {
  if (process.env.FAL_KEY || process.env.DEMO === '1') return {}

  if (!process.stdin.isTTY) {
    console.log('\nNo FAL_KEY set. The canvas will open; set FAL_KEY before rendering.\n')
    return {}
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nOpenFlow renders through fal.ai with your own key — you pay fal directly, at cost.')
  console.log('Get one at https://fal.ai/dashboard/keys, or press Enter to look around first.\n')
  const key = (await rl.question('FAL_KEY: ')).trim()
  rl.close()

  if (!key) {
    console.log('\nNo key. The canvas opens read-only; Run will ask again.\n')
    return {}
  }
  // Passed to the child, never written to disk. A tool that quietly drops a
  // secret into a file in your project is a tool you find out about later.
  console.log('\nUsing that key for this session. Export FAL_KEY to skip this prompt.\n')
  return { FAL_KEY: key }
}

function openBrowser(target) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  // Best effort: a headless box has no browser, and that is not an error.
  spawn(command, [target], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    .on('error', () => {})
    .unref()
}

const env = await askForKey()

// A fresh clone has no `.next`. Build once rather than failing with a stack
// trace about a missing production build.
if (!existsSync(path.join(root, '.next'))) {
  console.log('First run — building. This happens once.\n')
  await run('npx', ['next', 'build'])
}

console.log(`OpenFlow starting on ${url}`)
setTimeout(() => openBrowser(url), 1500)

await run('npx', ['next', 'start', '-p', PORT], env)
