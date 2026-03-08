import type { AuthIdentity, AuthResult } from "./types.ts";
import { validateApiKey } from "./api-key.ts";
import { validateSupabaseJwt } from "./supabase-jwt.ts";

export type { AuthIdentity, AuthResult };

const API_KEY_PREFIX = "mcp_sk_";

const DEV_IDENTITY: AuthIdentity = {
  id: "dev-local-user",
  email: "dev@localhost",
  role: "admin",
  method: "skip_auth",
};

/**
 * Authenticate an incoming request.
 *
 * Strategies (in order):
 * 1. SKIP_AUTH=true → returns a dev identity (local dev only)
 * 2. Bearer token starting with mcp_sk_ → API key validation
 * 3. Any other Bearer token → Supabase JWT validation
 */
export async function authenticate(req: Request): Promise<AuthResult> {
  // 1. Skip auth for local development
  if (Deno.env.get("SKIP_AUTH") === "true") {
    console.warn("[AUTH] SKIP_AUTH is enabled — returning dev identity");
    return { success: true, identity: DEV_IDENTITY };
  }

  // 2. Extract Authorization header
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      success: false,
      error: "Missing or malformed Authorization header",
      status: 401,
    };
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  if (!token) {
    return {
      success: false,
      error: "Missing or malformed Authorization header",
      status: 401,
    };
  }

  // 3. Route to the appropriate strategy
  if (token.startsWith(API_KEY_PREFIX)) {
    return validateApiKey(token);
  }

  return await validateSupabaseJwt(token);
}
