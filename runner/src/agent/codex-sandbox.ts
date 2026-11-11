import type { GoblinDaemonConfig } from "../config"
import type { SandboxHandle } from "./backend"

const LINEAR_ENDPOINT = "https://api.linear.app/graphql"

export async function prepareCodexSandbox(
  _workDir: string,
  config: GoblinDaemonConfig,
): Promise<SandboxHandle> {
  const apiKey = config.linear?.apiKey
  if (!apiKey) return {}

  return {
    extraArgs: [
      "-c",
      'mcp_servers.goblin-linear.command="npx"',
      "-c",
      'mcp_servers.goblin-linear.args=["-y","mcp-graphql"]',
      "-c",
      `mcp_servers.goblin-linear.env.ENDPOINT=${JSON.stringify(LINEAR_ENDPOINT)}`,
      "-c",
      'mcp_servers.goblin-linear.env.ALLOW_MUTATIONS="true"',
      "-c",
      `mcp_servers.goblin-linear.env.HEADERS=${JSON.stringify(
        JSON.stringify({ Authorization: apiKey }),
      )}`,
    ],
  }
}
