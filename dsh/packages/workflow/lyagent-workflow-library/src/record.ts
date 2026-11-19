/** Persist settled saved-workflow runs beside the workspace they executed in. */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/** The identities and settled content of one recorded run. */
export interface RunRecord {
  readonly id: string
  readonly version: number
  readonly sha256: string
  readonly content: unknown
}

/** The instant and unique suffix that make one run's file name distinct. */
export interface RunRecordStamp {
  readonly at: Date
  readonly nonce: string
}

const COLONS_AND_DOTS = /[:.]/g

/**
 * Render one run instant as a filesystem-safe component.
 * @param at - the run's completion time.
 * @returns `YYYY-MM-DDTHH-mm-ss-SSSZ`.
 */
function formatStamp(at: Date): string {
  return at.toISOString().replace(COLONS_AND_DOTS, '-')
}

/**
 * Whether `candidate` is a strict descendant of `root`.
 * @param root - canonical workspace directory.
 * @param candidate - canonical candidate path.
 * @returns true when the candidate stays below the root.
 */
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

/**
 * Write one run record under `<cwd>/workflows`. The write stays inside the
 * workspace: the workspace and the record directory are resolved to their
 * canonical paths, so a redirected `workflows` junction or symlink is refused
 * instead of writing outside the authorized directory. The file name carries
 * the run instant and a unique suffix, and the write refuses an existing path,
 * so re-running one saved version never overwrites earlier evidence.
 * @param cwd - workspace directory the run executed in.
 * @param record - saved identity, exact version, script digest and settled content.
 * @param stamp - run instant and unique suffix supplied by the caller.
 * @returns the canonical path written.
 * @throws When the workspace cannot be resolved, the record directory escapes it, or the target exists.
 */
export async function writeRunRecord(cwd: string, record: RunRecord, stamp: RunRecordStamp): Promise<string> {
  const root = await realpath(cwd)
  const directory = join(root, 'workflows')
  await mkdir(directory, { recursive: true })
  const resolved = await realpath(directory)
  if (resolved !== directory || !isWithin(root, resolved)) {
    throw new Error(`the workflows record directory resolves outside the workspace: ${resolved}`)
  }
  const target = join(resolved, `${record.id}-v${record.version}-${formatStamp(stamp.at)}-${stamp.nonce}.json`)
  await writeFile(target, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' })
  return target
}
