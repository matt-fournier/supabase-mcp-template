import type { AuthResult } from "./types.ts";

/**
 * Validate an API key token against the MCP_API_KEYS secret.
 *
 * MCP_API_KEYS format: "name1:mcp_sk_xxx,name2:mcp_sk_yyy"
 */
export function validateApiKey(token: string): AuthResult {
  const raw = Deno.env.get("MCP_API_KEYS");

  if (!raw) {
    console.error("[AUTH:API_KEY] MCP_API_KEYS secret is not configured");
    return {
      success: false,
      error: "API key authentication is not configured",
      status: 500,
    };
  }

  const entries = raw.split(",").map((entry) => {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex === -1) return null;
    return {
      name: entry.slice(0, separatorIndex).trim(),
      key: entry.slice(separatorIndex + 1).trim(),
    };
  }).filter(Boolean) as { name: string; key: string }[];

  const match = entries.find((entry) => entry.key === token);

  if (!match) {
    return {
      success: false,
      error: "Invalid API key",
      status: 401,
    };
  }

  console.log(`[AUTH:API_KEY] Authenticated client "${match.name}"`);

  return {
    success: true,
    identity: {
      id: `apikey:${match.name}`,
      email: `${match.name}@mcp.local`,
      role: "service",
      method: "api_key",
    },
  };
}
