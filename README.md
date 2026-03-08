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
│   └── mcp-server/
│       ├── index.ts          # Entry point — handles HTTP and routes to MCP
│       ├── server.ts         # MCP server definition and tool registration
│       ├── tools/
│       │   ├── index.ts      # Re-exports all tools
│       │   ├── query.ts      # Example: database query tool
│       │   └── storage.ts    # Example: storage tool
│       ├── auth.ts           # Authentication helpers
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
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "./cors.ts";
import { authenticate } from "./auth.ts";
import { createMcpServer } from "./server.ts";

serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Authenticate every request
    const user = await authenticate(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Route to MCP handler
    const server = createMcpServer(user);
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

### `auth.ts` — Supabase JWT Validation

```typescript
import { createClient } from "npm:@supabase/supabase-js";
import type { AuthUser } from "./types.ts";

export async function authenticate(req: Request): Promise<AuthUser | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.split(" ")[1];

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!
  );

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) return null;

  return {
    id: user.id,
    email: user.email!,
    role: user.role ?? "user",
  };
}
```

### Authorization Patterns

**1. Always scope database queries to the authenticated user:**
```typescript
supabase.from("projects").select("*").eq("user_id", user.id)
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
  if (user.role !== "admin") {
    return {
      content: [{ type: "text", text: "Access denied: admin role required." }],
      isError: true,
    };
  }
  // ... admin logic
});
```

**4. API key authentication (for non-Supabase clients):**

If your MCP is called by external systems rather than Supabase users, validate a shared secret:

```typescript
export async function authenticateApiKey(req: Request): Promise<boolean> {
  const key = req.headers.get("x-api-key");
  const validKey = Deno.env.get("MCP_API_KEY");
  return key === validKey;
}
```

---

## 7. Environment Variables & Secrets

### Required Variables

```bash
# Always available automatically in Supabase Edge Functions
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_DB_URL

# Your custom secrets
MCP_API_KEY=your-secret-key
EXTERNAL_SERVICE_API_KEY=...
```

### Setting Secrets

```bash
# Set secrets for production
supabase secrets set MCP_API_KEY=your-secret-key
supabase secrets set EXTERNAL_API_KEY=abc123

# List all secrets (values hidden)
supabase secrets list
```

### Local Development

Create `supabase/.env.local` (never commit this file):

```
MCP_API_KEY=local-dev-key
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
# Deploy a single function
supabase functions deploy mcp-server

# Deploy all functions
supabase functions deploy
```

### Set Production Secrets

```bash
supabase secrets set MCP_API_KEY=prod-secret-key
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
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "npm:@supabase/supabase-js";
import { z } from "npm:zod";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://claude.ai",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth
  const token = req.headers.get("Authorization")?.split(" ")[1];
  if (!token) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!
  );

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

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
        .eq("user_id", user.id)
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

