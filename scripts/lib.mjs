// Shared helpers for the scripts in this folder.
//
// The file locations used to be hardcoded absolute Windows paths. That works
// on the machine the data lives on and nowhere else - and worse, a missing
// file was silently skipped, so `test-parser.mjs` printed "ALL CHECKS PASSED"
// and exited 0 having run no checks at all. Anywhere but that one machine,
// a broken parser looked exactly like a working one.
//
// So: paths come from the command line or the environment, the old paths
// remain as the fallback, and a run that tested nothing now fails loudly.
//
//   node scripts/test-parser.mjs                       # fallback paths
//   node scripts/test-parser.mjs ~/data/*.xlsm         # explicit files
//   node scripts/test-parser.mjs ~/data                # every workbook in a dir
//   QUERY_DATA_DIR=~/data node scripts/test-multifile.mjs
import fs from 'node:fs'
import path from 'node:path'

const WORKBOOK = /\.(xls|xlsx|xlsm|xlsb)$/i

/** Read a file into the minimal File-like shape the browser parser needs. */
export function fileFrom(p) {
  const b = fs.readFileSync(p)
  return {
    name: path.basename(p),
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  }
}

/** Positional CLI args, minus --flags. */
export function args() {
  return process.argv.slice(2).filter((a) => !a.startsWith('--'))
}

/**
 * Folder holding the raw WMS exports: first positional arg, else
 * $QUERY_DATA_DIR, else the fallback. Returns null if it does not exist.
 */
export function dataDir(fallback) {
  const dir = args()[0] ?? process.env.QUERY_DATA_DIR ?? fallback
  return dir && fs.existsSync(dir) ? dir : null
}

/** Every workbook in a folder, sorted. */
export function workbooksIn(dir, ext = WORKBOOK) {
  return fs
    .readdirSync(dir)
    .filter((f) => ext.test(f))
    .sort()
    .map((f) => path.join(dir, f))
}

/**
 * Resolve the workbooks to test. Positional args may be files or folders;
 * with none, falls back to $QUERY_DATA_DIR then the caller's list. Only
 * paths that exist are returned - the caller decides what an empty list means.
 */
export function resolveWorkbooks(fallbackPaths = []) {
  const given = args()
  const candidates = []

  if (given.length > 0) {
    for (const p of given) {
      if (!fs.existsSync(p)) continue
      if (fs.statSync(p).isDirectory()) candidates.push(...workbooksIn(p))
      else candidates.push(p)
    }
    return candidates
  }

  if (process.env.QUERY_DATA_DIR && fs.existsSync(process.env.QUERY_DATA_DIR)) {
    return workbooksIn(process.env.QUERY_DATA_DIR)
  }

  return fallbackPaths.filter((p) => fs.existsSync(p))
}

/** A named file from --master=..., $QUERY_MASTER, or the fallback. */
export function namedFile(flag, envVar, fallback) {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`--${flag}=`))
  const p = arg ? arg.slice(flag.length + 3) : (process.env[envVar] ?? fallback)
  return p && fs.existsSync(p) ? p : null
}

/** Explains where to point a script when it found no data. */
export function noDataMessage(what) {
  return (
    `No ${what} found.\n\n` +
    `Pass a path, or set QUERY_DATA_DIR:\n` +
    `  node ${path.relative(process.cwd(), process.argv[1])} /path/to/folder\n` +
    `  QUERY_DATA_DIR=/path/to/folder node ${path.relative(process.cwd(), process.argv[1])}\n`
  )
}

/** Assertion counter shared by the test scripts. */
export function checker() {
  const state = { passed: 0, failed: 0 }

  function check(label, cond, detail = '') {
    if (cond) state.passed++
    else state.failed++
    console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
  }

  // A run that asserted nothing is a failure, not a pass. This is the whole
  // reason this helper exists rather than a bare counter.
  function report() {
    if (state.passed + state.failed === 0) {
      console.log('\nNO CHECKS RAN - nothing was verified.')
      process.exit(1)
    }
    console.log(
      state.failed === 0
        ? `\nALL ${state.passed} CHECKS PASSED`
        : `\n${state.failed} of ${state.passed + state.failed} CHECK(S) FAILED`
    )
    process.exit(state.failed === 0 ? 0 : 1)
  }

  return { check, report, state }
}
