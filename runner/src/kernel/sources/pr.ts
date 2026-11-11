// sources/pr.ts — shared PR detection for sources whose code lives on GitHub.

import { spawnPath } from "../../utils/path"

/** Return the URL of the PR for the branch checked out in `codeDir`, if any. */
export async function detectPrUrlInWorktree(codeDir: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["gh", "pr", "view", "--json", "url", "--jq", ".url"], {
      cwd: codeDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: spawnPath() },
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) return undefined
    const trimmed = (await new Response(proc.stdout).text()).trim()
    return trimmed || undefined
  } catch {
    return undefined
  }
}
