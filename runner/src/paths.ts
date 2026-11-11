import { isAbsolute, relative, resolve } from "path"

export const GOBLIN_DIR = process.env.GOBLIN_DIR || resolve(process.env.HOME || "/tmp", ".pr-goblin")

export const LOGS_DIR = resolve(GOBLIN_DIR, "logs")

export const TASKS_DIR = resolve(GOBLIN_DIR, "tasks")

export function sanitizeTaskIdentifier(identifier: string): string {
  return identifier
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Root directory for a task: ~/.pr-goblin/tasks/{sanitized-id}/ */
export function taskDir(identifier: string): string {
  return resolve(TASKS_DIR, sanitizeTaskIdentifier(identifier))
}

/** Log dir for an agent: ~/.pr-goblin/tasks/{id}/{agentName}/ */
export function taskLogDir(identifier: string, agentName = "implement"): string {
  return resolve(taskDir(identifier), agentName)
}

