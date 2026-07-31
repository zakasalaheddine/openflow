/**
 * Refuses to start on a Node that segfaults.
 *
 * better-sqlite3's darwin-arm64 prebuild crashes with SIGSEGV on some 22.x
 * patch releases — including 22.13.1. The dev server prints "Ready", then dies
 * on the first request that touches the database, with no error at all. A
 * silent crash is the worst failure mode there is, so refuse before it happens.
 */
const REQUIRED = [22, 16, 0]
const actual = process.versions.node.split('.').map(Number)

const compare = actual.findIndex((part, i) => part !== REQUIRED[i])
const tooOld = compare !== -1 && actual[compare] < REQUIRED[compare]

if (tooOld) {
  console.error(
    `\nOpenFlow needs Node >= ${REQUIRED.join('.')}; this is ${process.versions.node}.\n` +
      `better-sqlite3 segfaults on older 22.x builds, and the server dies silently\n` +
      `on the first request that opens the database.\n\n` +
      `  nvm use        # reads .nvmrc\n`,
  )
  process.exit(1)
}
