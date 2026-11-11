// update-check.ts — self-update is intentionally disabled in pr-goblin.
//
// The upstream project polled the npm registry and offered a curl-pipe
// installer. pr-goblin does neither: it never phones home and is updated the
// same way it was installed. The exports stay so callers keep one code path.

import { readFileSync } from "fs"
import { dirname, resolve } from "path"

export interface UpdateCache {
  latest: string
  current: string
  checkedAt: number
}

export function readUpdateCache(): UpdateCache | null {
  return null
}

export function isUpdateCheckDisabled(): boolean {
  return true
}

export function hasNewerVersion(_current: string, _latest: string): boolean {
  return false
}

export function shouldShowUpdateHint(_runningVersion: string, _cache: UpdateCache | null): boolean {
  return false
}

/** Resolve current package version from package.json. */
export function getCurrentVersion(): string {
  try {
    const pkgPath = resolve(dirname(new URL(import.meta.url).pathname), "../package.json")
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

export async function checkForUpdate(): Promise<void> {}

export function spawnUpdateCheck(): void {}

export function isCacheStale(): boolean {
  return false
}
