// Shared test helpers. Kept out of node:test so every test file can import them.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// os.tmpdir() follows TMPDIR, which the sandbox gives each worker. When that
// directory is not writable (a read-only /tmp, a full one, a permission wall)
// fall back to another writable place outside the repository.
function scratch(): string {
  const candidates = [process.env.MICROMANAGER_TEST_TMPDIR, "/dev/shm"]
  for (const dir of candidates) {
    if (!dir) continue
    try {
      return mkdtempSync(join(dir, "mm-test-"))
    } catch {
      // try the next candidate
    }
  }
  return mkdtempSync(join(tmpdir(), "mm-test-"))
}

export function tempDir(prefix = "mm-"): string {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    return scratch()
  }
}
