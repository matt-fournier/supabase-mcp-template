# MCP on Supabase Edge Functions — Best Practices Guide

> A scaffolding reference for building Model Context Protocol (MCP) servers deployed as Supabase Edge Functions. Intended as a living document — fork it, extend it, and adapt it to your stack.

---

## Table of Contents

1. [What This Guide Covers](#1-what-this-guide-covers)
2. [Core Concepts](#2-core-concepts)
3. [Project Structure](#3-project-structure)
4. [The MCP Server Template](#4-the-mcp-server-template)
5. [Defining Tools](#5-defining-tools)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [Environment Variables & Secrets](#7-environment-variables--secrets)
8. [Error Handling](#8-error-handling)
9. [Connecting to Supabase Services](#9-connecting-to-supabase-services)
10. [Transport Layer (SSE vs Streamable HTTP)](#10-transport-layer-sse-vs-streamable-http)
11. [CORS Configuration](#11-cors-configuration)
12. [Testing Locally](#12-testing-locally)
13. [Deployment](#13-deployment)
14. [Connecting to Claude.ai](#14-connecting-to-claudeai)
15. [Security Checklist](#15-security-checklist)
16. [Performance & Limits](#16-performance--limits)
17. [Common Pitfalls](#17-common-pitfalls)
18. [Full Working Example](#18-full-working-example)

---

## 1. What This Guide Covers

This guide walks you through the architecture and best practices for building an MCP (Model Context Protocol) server that runs as a **Supabase Edge Function**. This pattern is ideal when you want to:

- Expose your Supabase database, storage, or third-party APIs to an LLM via MCP
- Keep your server **serverless** with no infrastructure to manage
- Leverage **Supabase Auth** to authenticate MCP clients
- Deploy globally at the edge with minimal latency

**MCP** is an open protocol (by Anthropic) that standardizes how AI models interact with external tools and data sources. Think of it as a USB-C standard for AI integrations.

**Supabase Edge Functions** run on Deno, deployed globally via Cloudflare's network. They natively support streaming responses, which is essential for MCP's SSE transport.

---

## 2. Core Concepts

### MCP Primitives

| Primitive | Description |
|-----------|-------------|
| **Tools** | Functions the LLM can call (e.g., query database, send email) |
| **Resources** | Data the LLM can read (e.g., documents, schema definitions) |
| **Prompts** | Reusable prompt templates the LLM can invoke |

For most edge function use cases, you will primarily implement **Tools**.

### Request/Response Flow

```
LLM (Claude) → MCP Client → HTTPS POST → Supabase Edge Function → Your Logic → Response
```

The edge function acts as a **stateless MCP server**. Each request is fully self-contained.

---

## 3. Project Structure

```
supabase/
├── functions/
│   ├── deno.json             # Import map: @shared/ → ./_shared/
│   ├── _shared/
│   │   └── mcp-auth/
│   │       ├── mod.ts        # Entry point — authenticate(req)
│   │       ├── api-key.ts    # Strategy: API key (mcp_sk_...)
│   │       ├── supabase-jwt.ts # Strategy: Supabase JWT (getClaims/getUser)
│   │       └── types.ts      # AuthIdentity, AuthResult
│   └── mcp-server/
│       ├── index.ts          # Entry point — handles HTTP and routes to MCP
│       ├── server.ts         # MCP server definition and tool registration
│       ├── tools/
│       │   ├── index.ts      # Re-exports all tools
│       │   ├── query.ts      # Example: database query tool
│       │   └── storage.ts    # Example: storage tool
│       ├── auth.ts           # Re-export from @shared/mcp-auth
│       ├── cors.ts           # CORS headers
│       └── types.ts          # Shared types
├── .env.local                # Local secrets (never commit)
└── config.toml               # Supabase project config
```

> **Convention:** Keep each tool in its own file. It makes testing, documentation, and code review far easier as your MCP grows.

---

## 4. The MCP Server Template

### `index.ts` — Entry Point

```typescript
import { corsHeaders, handleCors } from "./cors.ts";
import { authenticate } from "./auth.ts";
import { createMcpServer } from "./server.ts";

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Authenticate every request (see Section 6)
    const result = await authenticate(req);
    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: result.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Route to MCP handler
    const server = createMcpServer(result.identity);
    return await server.handle(req);

  } catch (error) {
    console.error("[MCP] Unhandled error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

### `server.ts` — MCP Server Definition

```typescript
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/streamableHttp.js";
import { allTools } from "./tools/index.ts";

export function createMcpServer(user: AuthUser) {
  const server = new McpServer({
    name: "my-mcp-server",
    version: "1.0.0",
  });

  // Register all tools, passing user context
  allTools.forEach((tool) => tool.register(server, user));

  return {
    async handle(req: Request): Promise<Response> {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless — no session needed
      });

      const response = await transport.handleRequest(req, async () => {
        await server.connect(transport);
      });

      return response;
    },
  };
}
```

---

## 5. Defining Tools

### Tool Interface Pattern

Define a consistent interface for all your tools:

```typescript
// types.ts
export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

export interface McpTool {
  register(server: McpServer, user: AuthUser): void;
}
```

### Example Tool — Database Query

```typescript
// tools/query.ts
import { z } from "npm:zod";
import { createClient } from "npm:@supabase/supabase-js";
import type { McpTool, AuthUser } from "../types.ts";

export const queryTool: McpTool = {
  register(server, user) {
    server.tool(
      // Tool name — use snake_case, descriptive, action-oriented
      "query_records",

      // Human-readable description — critical for LLM to know when to use it
      "Query records from the database. Returns matching rows as JSON. " +
      "Use this when you need to look up data, filter records, or retrieve information.",

      // Input schema using Zod
      {
        table: z.string().describe("The table name to query"),
        filters: z.record(z.string()).optional().describe(
          "Optional key-value pairs to filter results. Example: { status: 'active' }"
        ),
        limit: z.number().min(1).max(100).default(20).describe(
          "Maximum number of records to return (default: 20, max: 100)"
        ),
      },

      // Handler — receives validated inputs
      async ({ table, filters, limit }) => {
        try {
          const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
          );

          // Always scope queries to the authenticated user
          let query = supabase
            .from(table)
            .select("*")
            .eq("user_id", user.id) // Row-level scoping
            .limit(limit);

          if (filters) {
            Object.entries(filters).forEach(([key, value]) => {
              query = query.eq(key, value);
            });
          }

          const { data, error } = await query;

          if (error) throw error;

          return {
            content: [{
              type: "text",
              text: JSON.stringify(data, null, 2),
            }],
          };

        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Error querying ${table}: ${error.message}`,
            }],
            isError: true,
          };
        }
      }
    );
  },
};
```

### Tool Registration Index

```typescript
// tools/index.ts
import { queryTool } from "./query.ts";
import { storageTool } from "./storage.ts";

export const allTools = [queryTool, storageTool];
```

### Tool Naming Best Practices

| ✅ Good | ❌ Avoid |
|---------|---------|
| `query_records` | `getData` |
| `create_invoice` | `doInvoice` |
| `send_notification` | `notify` |
| `list_projects` | `projects` |

**Rules:**
- Use `verb_noun` format
- Be specific — LLMs use the name AND description to decide which tool to call
- Keep names unique across your server
- Never use reserved names like `list_tools`, `call_tool`

### Writing Good Tool Descriptions

The description is the most important part of a tool. Write it as if you're explaining the tool to a junior developer who needs to know exactly when and how to use it.

```typescript
// ❌ Weak description
"Get project data"

// ✅ Strong description  
"Retrieve a list of projects for the current user. Returns project name, status, " +
"start date, and team members. Use this when the user asks about their projects, " +
"wants to see what's in progress, or needs project details. " +
"Does NOT return archived projects — use list_archived_projects for those."
```

---

## 6. Authentication & Authorization

### Architecture overview

Authentication is centralized in a shared module (`_shared/mcp-auth/`) imported by all MCP functions. The Supabase gateway does **not** verify JWTs (`verify_jwt = false`) — validation is handled entirely inside the function code. This is required because Supabase's gateway JWT verification is incompatible with the new asymmetric signing keys (post-2025).

**References:**
- [Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)
- [JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys)
- [Deploy MCP Servers](https://supabase.com/docs/guides/getting-started/byo-mcp)

### File structure

```
supabase/functions/
├── deno.json                  # Import map: @shared/ → ./_shared/
├── _shared/
│   └── mcp-auth/
│       ├── mod.ts             # Entry point — authenticate(req)
│       ├── api-key.ts         # Strategy: API key (mcp_sk_...)
│       ├── supabase-jwt.ts    # Strategy: Supabase JWT (getClaims/getUser)
│       └── types.ts           # AuthIdentity, AuthResult
├── mcp-server/
│   ├── auth.ts                # Re-export from @shared/mcp-auth
│   └── ...
```

### Import map (`deno.json`)

The `_shared/` folder is not automatically resolved by the Supabase bundler at deploy time. An alias in `supabase/functions/deno.json` solves this:

```json
{
  "imports": {
    "@shared/": "./_shared/"
  }
}
```

### Authentication flow

```
Incoming HTTP request
        │
        ▼
┌─ SKIP_AUTH=true ? ──────────────────────── Yes ─── Return DEV_IDENTITY (local dev)
│       │
│      No
│       │
│       ▼
│  Authorization header present?
│       │
│      No ───────────────────────────────── 401 "Missing Authorization header"
│       │
│      Yes
│       │
│       ▼
│  Extract Bearer token
│       │
│       ▼
│  Token starts with mcp_sk_ ?
│       │
│      Yes ──── validateApiKey() ─────────── Check against MCP_API_KEYS
│       │                                         │
│      No                                   Found? ── Yes ── AuthIdentity (method: api_key)
│       │                                         │
│       │                                        No ── 401 "Invalid API key"
│       ▼
│  validateSupabaseJwt()
│       │
│       ▼
│  getClaims(token) available?
│       │
│      Yes ──── Try getClaims() ──── Success? ── AuthIdentity (method: supabase_jwt)
│       │                                │
│       │                              Fail ── Fallback to getUser()
│      No
│       │
│       ▼
│  getUser(token) ────────────────────── Success? ── AuthIdentity (method: supabase_jwt)
│                                            │
│                                          Fail ── 401 "Invalid or expired JWT"
```

### Types

```typescript
/** Authenticated identity returned by the middleware. */
export interface AuthIdentity {
  id: string;
  email: string;
  role: string;
  method: "api_key" | "supabase_jwt" | "skip_auth";
}

/** Result of an authentication attempt. */
export type AuthResult =
  | { success: true; identity: AuthIdentity }
  | { success: false; error: string; status: number };
```

### Method 1 — SKIP_AUTH (local development only)

For rapid local development without any authentication:

```bash
# .env.local
SKIP_AUTH=true
```

Returns a fixed dev identity. The code emits a `console.warn` to flag that auth is disabled. **Never enable in production.**

### Method 2 — API Key (machine-to-machine)

For Claude Desktop, Cowork, server scripts, backend integrations — any client that cannot interactively refresh a JWT.

**Token format:** `mcp_sk_` followed by a random string (recommended: 64 hex characters).

```
Authorization: Bearer mcp_sk_a1b2c3d4e5f6...
```

**Secret configuration:** The `MCP_API_KEYS` secret contains comma-separated `name:key` pairs:

```
MCP_API_KEYS="claude-desktop:mcp_sk_abc123,backend-app:mcp_sk_xyz789"
```

The name identifies which client made the request (useful for logs and per-key revocation).

**Generate a key:**

```bash
openssl rand -hex 32
# Result: a1b2c3d4e5f6...
# Full key: mcp_sk_a1b2c3d4e5f6...
```

**Key rotation** (zero-downtime):
1. Generate a new key
2. Add the new key to `MCP_API_KEYS` (keep the old one temporarily)
3. Update the client to use the new key
4. Remove the old key from `MCP_API_KEYS`

### Method 3 — Supabase JWT (web users)

For web applications where users log in via Supabase Auth (email/password, OAuth, Magic Link, etc.).

```
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

**Required secrets:**

| Secret | Description | Auto-injected? |
|---|---|---|
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SB_PUBLISHABLE_KEY` | New publishable key (post-May 2025 projects) | No — must be set manually |
| `SUPABASE_ANON_KEY` | Legacy anon key | Yes |

**Validation strategy (cascade):**

1. **`getClaims(token)`** — New method (Supabase JS v2+). Verifies the JWT locally with asymmetric keys. Fast, rarely needs the network.
2. **`getUser(token)`** — Legacy fallback. Makes a network call to the Auth server. Slower but compatible with all projects.

### Integrating in a new MCP function

**1. Create `auth.ts` in your function folder (re-export):**

```typescript
export { authenticate } from "@shared/mcp-auth/mod.ts";
export type { AuthIdentity, AuthResult } from "@shared/mcp-auth/mod.ts";
```

**2. Call `authenticate(req)` in `index.ts`:**

```typescript
import { authenticate } from "./auth.ts";

Deno.serve(async (req: Request) => {
  const result = await authenticate(req);
  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const identity = result.identity;
  // ... MCP logic with identity
});
```

**3. Set `verify_jwt = false` in `config.toml`:**

```toml
[functions.mcp-server]
verify_jwt = false
```

**4. Deploy with `--no-verify-jwt`:**

```bash
supabase functions deploy mcp-server --no-verify-jwt
```

### Production deployment — step by step

Concrete recipe for deploying authentication to production on a new MCP function:

**Step 1 — Generate an API key:**

```bash
openssl rand -hex 32
# Result: a1b2c3d4e5f6...
# Full key: mcp_sk_a1b2c3d4e5f6...
```

The `mcp_sk_` prefix allows the auth module to distinguish an API key from a Supabase JWT and route to the correct validation strategy.

**Step 2 — Register the key in Supabase secrets:**

```bash
supabase secrets set MCP_API_KEYS="claude-desktop:mcp_sk_a1b2c3d4e5f6..."
```

The `name:key` format identifies each client in logs and allows per-key revocation. Multiple keys are comma-separated.

**Step 3 — Disable `verify_jwt` at the gateway:**

In `supabase/config.toml`:

```toml
[functions.mcp-server]
verify_jwt = false
```

The Supabase gateway is incompatible with the new asymmetric signing keys (post-2025). Authentication is handled entirely inside the function code, following the [pattern recommended by Supabase](https://supabase.com/docs/guides/functions/auth).

**Step 4 — Configure the import map for `_shared`:**

The Supabase bundler does not automatically resolve paths to `_shared/` at deploy time. Create `supabase/functions/deno.json`:

```json
{
  "imports": {
    "@shared/": "./_shared/"
  }
}
```

All imports then use `@shared/mcp-auth/mod.ts` instead of relative paths.

**Step 5 — Deploy:**

```bash
supabase functions deploy mcp-server --no-verify-jwt
```

**Step 6 — Validate:**

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/mcp-server \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mcp_sk_YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A successful response returns the list of available tools, confirming that API key authentication works in production.

**Step 7 — Configure clients:**

For Claude Desktop, use `npx mcp-remote` as a proxy since Claude Desktop does not natively support remote HTTP MCP servers. For Cowork, the MCP connects directly via the built-in connector. For web applications, pass the Supabase `session.access_token` as a Bearer token.

### Authorization Patterns

**1. Always scope database queries to the authenticated user:**
```typescript
supabase.from("projects").select("*").eq("user_id", identity.id)
```

**2. Use Supabase Row Level Security (RLS) as a safety net:**
Even if your tool code is correct, RLS prevents data leaks if something goes wrong. Enable RLS on every table and define policies.

```sql
-- Example RLS policy
CREATE POLICY "Users can only access their own records"
  ON projects FOR ALL
  USING (auth.uid() = user_id);
```

**3. Role-based tool access:**
```typescript
server.tool("admin_export_all", "...", {}, async () => {
  if (identity.role !== "admin") {
    return {
      content: [{ type: "text", text: "Access denied: admin role required." }],
      isError: true,
    };
  }
  // ... admin logic
});
```

### Client configuration examples

**Claude Desktop / Cowork:**

```json
{
  "mcpServers": {
    "my-mcp": {
      "type": "http",
      "url": "https://<project-ref>.supabase.co/functions/v1/mcp-server",
      "headers": {
        "Authorization": "Bearer mcp_sk_YOUR_KEY"
      }
    }
  }
}
```

**Web application (Supabase Auth):**

```typescript
const { data: { session } } = await supabase.auth.getSession();

const response = await fetch(
  "https://<project-ref>.supabase.co/functions/v1/mcp-server",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_my_projects", arguments: {} },
    }),
  }
);
```

**Server script (curl):**

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/mcp-server \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mcp_sk_YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Troubleshooting

| Symptom | Likely cause | Solution |
|---|---|---|
| `401 "Missing or malformed Authorization header"` | No `Authorization: Bearer ...` header | Add the header with the correct token |
| `401 "Invalid API key"` | `mcp_sk_...` key not found in `MCP_API_KEYS` | Check the secret with `supabase secrets list` |
| `401 "Invalid or expired JWT"` | Expired or invalid Supabase JWT | Refresh the token client-side |
| `500 "API key authentication is not configured"` | `MCP_API_KEYS` secret missing | `supabase secrets set MCP_API_KEYS=...` |
| `500 "Supabase JWT authentication is not configured"` | Missing `SB_PUBLISHABLE_KEY` and `SUPABASE_ANON_KEY` | Expose the publishable key as a secret |
| `{"msg":"Missing authorization header"}` (before function) | `verify_jwt` still enabled at gateway | Redeploy with `--no-verify-jwt` |

### Security rules

- **Never enable `SKIP_AUTH` in production.**
- **Never expose `mcp_sk_...` keys client-side** (browser, public source code).
- **Always deploy with `--no-verify-jwt`** — the Supabase gateway is incompatible with the new key model and the MCP pattern.
- **Use HTTPS** for all production communication (Supabase provides it by default).

---

## 7. Environment Variables & Secrets

### Required Variables

```bash
# Always available automatically in Supabase Edge Functions
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_DB_URL

# Auth — API keys for machine-to-machine clients (see Section 6)
MCP_API_KEYS=claude-desktop:mcp_sk_XXXX,cowork:mcp_sk_YYYY

# Auth — Supabase publishable key for JWT validation (post-May 2025 projects)
SB_PUBLISHABLE_KEY=sb_publishable_XXXX

# Your custom secrets
EXTERNAL_SERVICE_API_KEY=...
```

### Setting Secrets

```bash
# API keys for machine-to-machine clients
supabase secrets set MCP_API_KEYS="claude-desktop:mcp_sk_XXXX,cowork:mcp_sk_YYYY"

# Supabase publishable key (for JWT validation with new asymmetric keys)
supabase secrets set SB_PUBLISHABLE_KEY=sb_publishable_XXXX

# Your custom secrets
supabase secrets set EXTERNAL_API_KEY=abc123

# List all secrets (values hidden)
supabase secrets list
```

### Local Development

Create `supabase/.env.local` (never commit this file):

```
# Skip auth entirely for local dev (never use in production)
SKIP_AUTH=true

# Or test with API key auth:
# SKIP_AUTH=false
# MCP_API_KEYS=dev-test:mcp_sk_test123

EXTERNAL_API_KEY=test-key
```

Add to `.gitignore`:
```
supabase/.env.local
```

### Accessing Secrets in Code

```typescript
// Always use Deno.env.get — never hardcode secrets
const apiKey = Deno.env.get("EXTERNAL_API_KEY");
if (!apiKey) throw new Error("EXTERNAL_API_KEY is not configured");
```

---

## 8. Error Handling

### The Three Error Levels

**Level 1 — Tool errors** (expected failures, return to LLM):
```typescript
return {
  content: [{ type: "text", text: "Record not found: id 123 does not exist." }],
  isError: true,
};
```

**Level 2 — Server errors** (unexpected failures, log and return HTTP 500):
```typescript
try {
  // ... tool logic
} catch (error) {
  console.error("[tool:query_records] Unexpected error:", error);
  return {
    content: [{ type: "text", text: "An unexpected error occurred. Please try again." }],
    isError: true,
  };
}
```

**Level 3 — Auth/validation errors** (return HTTP 401/400 before MCP layer):
```typescript
if (!user) {
  return new Response("Unauthorized", { status: 401 });
}
```

### Error Message Guidelines

- **Be specific enough** that the LLM can self-correct or inform the user meaningfully
- **Don't leak** internal details (stack traces, SQL errors, internal IDs) in production
- **Do log** full error details server-side using `console.error`

```typescript
// ❌ Too vague
return { content: [{ type: "text", text: "Error" }], isError: true };

// ❌ Too much information (leaks internals)
return { content: [{ type: "text", text: error.stack }], isError: true };

// ✅ Actionable, safe
return {
  content: [{
    type: "text",
    text: `Failed to create invoice: the project "${projectName}" does not exist or you don't have access to it.`,
  }],
  isError: true,
};
```

---

## 9. Connecting to Supabase Services

### Database (with service role — bypass RLS)

Use only for trusted server-side operations. Always prefer scoped queries.

```typescript
import { createClient } from "npm:@supabase/supabase-js";

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
```

### Database (with user token — RLS enforced)

Preferred pattern. RLS policies apply automatically.

```typescript
const userClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!,
  { global: { headers: { Authorization: `Bearer ${userToken}` } } }
);
```

### Storage

```typescript
const { data, error } = await supabase.storage
  .from("documents")
  .download(`${user.id}/report.pdf`);
```

### Edge Functions calling other Edge Functions

```typescript
const response = await fetch(
  `${Deno.env.get("SUPABASE_URL")}/functions/v1/other-function`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload }),
  }
);
```

---

## 10. Transport Layer (SSE vs Streamable HTTP)

MCP supports two transport modes. Choose based on your client:

### Streamable HTTP (Recommended for Edge Functions)

- Single endpoint, stateless, works with any HTTP client
- Best fit for Supabase Edge Functions (no persistent connections)
- Supported by Claude.ai remote MCP connections

```typescript
import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/streamableHttp.js";

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless mode
});
```

### SSE (Legacy — avoid for new projects)

- Requires a persistent connection — problematic with edge function timeouts
- Still supported for backwards compatibility with older MCP clients
- If you must support it, implement a session store (e.g., Supabase Realtime or KV)

---

## 11. CORS Configuration

### `cors.ts`

```typescript
// Adjust allowed origins for your environment
const ALLOWED_ORIGINS = [
  "https://claude.ai",
  "http://localhost:3000",
  "http://localhost:5173",
];

export const corsHeaders = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function handleCors(req: Request): Response | null {
  const origin = req.headers.get("Origin") ?? "";

  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0]; // Default fallback

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Origin": allowedOrigin,
      },
    });
  }

  return null; // Not a preflight — let the request proceed
}
```

> **Security note:** Avoid `Access-Control-Allow-Origin: *` in production. Enumerate exactly which origins you trust.

---

## 12. Testing Locally

### Start Supabase and Serve Functions

```bash
# Start local Supabase
supabase start

# Serve your edge function locally with environment variables
supabase functions serve mcp-server --env-file supabase/.env.local
```

Your function is now available at:  
`http://localhost:54321/functions/v1/mcp-server`

### Test with MCP Inspector

The official MCP Inspector is the fastest way to test tools interactively:

```bash
npx @modelcontextprotocol/inspector
```

Point it at `http://localhost:54321/functions/v1/mcp-server` and add your Authorization header.

### Test with curl

```bash
# List available tools
curl -X POST http://localhost:54321/functions/v1/mcp-server \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'

# Call a specific tool
curl -X POST http://localhost:54321/functions/v1/mcp-server \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "query_records",
      "arguments": {
        "table": "projects",
        "limit": 5
      }
    }
  }'
```

### Automated Tests

```typescript
// tests/query_tool_test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

Deno.test("query_records returns data for valid user", async () => {
  const response = await fetch("http://localhost:54321/functions/v1/mcp-server", {
    method: "POST",
    headers: {
      "Authorization": "Bearer TEST_TOKEN",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query_records", arguments: { table: "projects" } },
    }),
  });

  const data = await response.json();
  assertEquals(response.status, 200);
  assertEquals(data.result?.content?.[0]?.type, "text");
});
```

---

## 13. Deployment

### Deploy the Function

```bash
# Deploy a single function (--no-verify-jwt is required for MCP auth — see Section 6)
supabase functions deploy mcp-server --no-verify-jwt

# Deploy all functions
supabase functions deploy
```

### Set Production Secrets

```bash
# Auth secrets (see Section 6)
supabase secrets set MCP_API_KEYS="claude-desktop:mcp_sk_XXXX,cowork:mcp_sk_YYYY"
supabase secrets set SB_PUBLISHABLE_KEY=sb_publishable_XXXX

# Your custom secrets
supabase secrets set EXTERNAL_API_KEY=prod-api-key
```

### Verify Deployment

```bash
# Check function logs
supabase functions logs mcp-server --tail

# Test production endpoint
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/mcp-server \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### CI/CD (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy MCP Server

on:
  push:
    branches: [main]
    paths:
      - "supabase/functions/mcp-server/**"

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Deploy Edge Function
        run: supabase functions deploy mcp-server --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```

---

## 14. Connecting to Claude.ai

Once deployed, connect your MCP server as a remote integration in Claude.ai:

1. Open **Claude.ai → Settings → Integrations**
2. Add a new integration with:
   - **URL:** `https://YOUR_PROJECT.supabase.co/functions/v1/mcp-server`
   - **Authentication:** Bearer token (your Supabase JWT or API key)
3. Claude will call `tools/list` to discover your tools automatically

### Generating a Supabase JWT for Testing

```typescript
// Generate a test JWT using the Supabase client
const { data } = await supabase.auth.signInWithPassword({
  email: "test@example.com",
  password: "your-password",
});
console.log(data.session?.access_token);
```

---

## 15. Security Checklist

Before going to production, verify:

- [ ] **Authentication is enforced on every request** — no tool is accessible without a valid token
- [ ] **`SKIP_AUTH` is disabled** in production (never set `SKIP_AUTH=true` outside local dev)
- [ ] **`verify_jwt = false`** is set in `config.toml` and deployed with `--no-verify-jwt`
- [ ] **API keys (`mcp_sk_...`) are never exposed client-side** — only used by server/desktop clients
- [ ] **RLS is enabled** on every Supabase table touched by your tools
- [ ] **Service role key is never exposed** to the client — only used server-side
- [ ] **Input validation** is done via Zod schemas on all tool arguments
- [ ] **Allowed origins** are explicitly listed in CORS config (no wildcard `*`)
- [ ] **Secrets are stored** in Supabase Vault / secrets, not in code or environment files
- [ ] **Sensitive errors are not returned** to the LLM — only generic messages
- [ ] **Logs do not contain** PII, API keys, or tokens
- [ ] **Rate limiting** is considered for expensive tools (use Supabase's built-in rate limiting or a custom counter in Redis/KV)
- [ ] **Tool scope is minimal** — each tool does exactly one thing, with the narrowest possible database permissions

---

## 16. Performance & Limits

### Supabase Edge Function Limits

| Limit | Value |
|-------|-------|
| Max execution time | 150 seconds (400s for paid plans) |
| Max request body | 6 MB |
| Max response body | 6 MB |
| Cold start | ~300ms (first invocation) |
| Concurrency | Unlimited (auto-scaled) |

### Best Practices for Performance

**Keep tools fast:**
- Target < 5 seconds per tool call for a good user experience
- Use `Promise.all` for parallel database queries
- Add database indexes on columns used in tool filters

**Minimize cold starts:**
- Keep your function bundle lean — import only what you need
- Avoid heavy initialization at module load time

**Paginate large results:**
```typescript
// Don't return unbounded result sets
.limit(Math.min(limit, 100)) // Always cap the limit
```

**Cache static data** (tool schemas, configuration) at module level:
```typescript
// This runs once at cold start, then is reused
const toolConfig = JSON.parse(Deno.env.get("TOOL_CONFIG") ?? "{}");
```

---

## 17. Common Pitfalls

### ❌ Registering tools inside the request handler

Every request creates a new server — registering tools once per server is correct. Registering inside the transport handler creates duplication.

```typescript
// ❌ Wrong
async handle(req) {
  server.tool("my_tool", ...); // Called on every request
  return transport.handleRequest(req, ...);
}

// ✅ Correct — register once at server creation
export function createMcpServer(user) {
  const server = new McpServer({ name: "...", version: "..." });
  allTools.forEach(tool => tool.register(server, user)); // Once
  return { handle: async (req) => ... };
}
```

### ❌ Forgetting to handle CORS preflight

Claude.ai and browsers send an `OPTIONS` preflight before the actual POST. Without it, the request fails silently.

### ❌ Using service role key in user-scoped operations

The service role bypasses RLS. If you use it for user-facing queries, one user could potentially access another's data through a bug in your filter logic. Use RLS-enforced queries as the default.

### ❌ Returning raw database errors

Database errors often contain table names, column names, or query fragments. Always catch and rephrase before returning to the LLM.

### ❌ Not validating input types

Without Zod schemas, `limit = "hello"` could reach your database query and cause confusing failures.

### ❌ Blocking the event loop

Supabase Edge Functions are single-threaded (Deno). Long synchronous operations block all requests. Always use async I/O.

---

## 18. Full Working Example

A minimal but complete MCP server with one tool:

```typescript
// supabase/functions/mcp-server/index.ts
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "npm:@supabase/supabase-js";
import { z } from "npm:zod";
import { authenticate } from "./auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://claude.ai",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth (supports API keys, Supabase JWT, and SKIP_AUTH for local dev)
  const result = await authenticate(req);
  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: result.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const identity = result.identity;

  // MCP Server
  const server = new McpServer({ name: "minimal-mcp", version: "1.0.0" });

  server.tool(
    "list_my_projects",
    "List all projects belonging to the current user. Returns id, name, and status.",
    { limit: z.number().min(1).max(50).default(10) },
    async ({ limit }) => {
      const adminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      const { data, error } = await adminClient
        .from("projects")
        .select("id, name, status")
        .eq("user_id", identity.id)
        .limit(limit);

      if (error) {
        return {
          content: [{ type: "text", text: `Failed to load projects: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  const response = await transport.handleRequest(req, async () => {
    await server.connect(transport);
  });

  // Inject CORS headers into MCP response
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
});
```

---

## References

- [MCP Protocol Specification](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)

---

