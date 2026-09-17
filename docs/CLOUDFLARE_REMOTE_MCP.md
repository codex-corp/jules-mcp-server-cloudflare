# Cloudflare Remote MCP

This deployment keeps the existing Node/stdio server intact and adds a separate stateless Cloudflare Worker entrypoint at `src/worker.ts`.

The Worker exposes only Jules-backed operations. Local scheduling, persistent schedule storage, and polling are intentionally not part of the remote Worker.

## Architecture

```text
MCP client / ChatGPT
        |
        | OAuth 2.0 via Cloudflare Access Managed OAuth
        v
Cloudflare Access
        |
        | Cf-Access-Jwt-Assertion
        v
Cloudflare Worker
  GET /health
  POST /mcp
        |
        | x-goog-api-key: <JULES_API_KEY secret>
        v
Google Jules REST API
```

`/mcp` is handled with Cloudflare Agents `createMcpHandler()` and MCP SDK v2. The handler is stateless. A fresh MCP server is created per request.

## Remote tools

The Worker preserves the existing Jules-oriented tool names where they already exist and adds read/list tools that were previously represented mainly as MCP resources:

- `create_coding_task`
- `create_repoless_task`
- `list_sessions`
- `get_session_status`
- `manage_session` (`approve_plan`, `send_message`, `reject_plan`)
- `delete_session`
- `list_activities`
- `get_activity`
- `get_activities_since`
- `list_sources`
- `get_source_details`

The remote Worker does not expose `wait_for_session`, schedules, or schedule storage because this deployment is intentionally stateless and does not poll Jules.

## Install and validate

```bash
npm install
npm run typecheck
npm run worker:typecheck
npm test
```

The existing local/stdio mode remains:

```bash
npm run build
npm run mcp:smoke
```

## Local Worker development

Create a local-only `.dev.vars` file. Never commit it.

```dotenv
JULES_API_KEY=your_jules_api_key
LOCAL_DEV_BYPASS_AUTH=true
```

The bypass is accepted only when the request hostname is `localhost` or `127.0.0.1`. It cannot bypass authentication on a deployed hostname.

Run Wrangler:

```bash
npm run worker:dev
```

Test health:

```bash
curl http://127.0.0.1:8787/health
```

Expected shape:

```json
{"ok":true,"service":"jules-mcp-server-cloudflare","version":"1.0.0"}
```

For local MCP discovery, run MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

Connect Inspector to:

```text
http://127.0.0.1:8787/mcp
```

Then use **List tools** and call a safe read tool such as `list_sources` or `list_sessions`.

To verify the Worker-side authentication guard locally, remove `LOCAL_DEV_BYPASS_AUTH=true`, restart Wrangler, and call `/mcp`. It must return HTTP `401`.

## Wrangler authentication

If Wrangler is not already authenticated:

```bash
npx wrangler login
```

## Configure the Jules secret

`JULES_API_KEY` is read only from the Worker binding and is never returned by `/health` or tool results.

```bash
npx wrangler secret put JULES_API_KEY
```

Optional Jules client tuning can be configured as Worker environment variables or secrets:

```text
JULES_API_TIMEOUT_MS
JULES_API_MAX_RETRIES
JULES_ALLOWED_REPOS
```

`JULES_ALLOWED_REPOS` uses comma-separated `owner/repo` values and restricts `create_coding_task` when set.

## Deploy

```bash
npm run worker:deploy
```

Wrangler prints the deployed hostname. The endpoint shapes are:

```text
https://<worker-host>/health
https://<worker-host>/mcp
```

Do not connect ChatGPT before `/mcp` is protected with Cloudflare Access.

## Cloudflare Access Managed OAuth

Cloudflare Access Managed OAuth is the production authentication layer. It gives standards-based OAuth to MCP clients without adding an OAuth server, token database, KV, or Durable Object to this project.

1. In Cloudflare Zero Trust, go to **Access controls > Applications**.
2. Create or edit an application protecting the deployed MCP URL/hostname. Scope the protected application to the MCP route so `/health` can remain public if desired.
3. Add the Access policy for the user(s) or small workspace allowed to use this MCP server.
4. In **Advanced settings**, enable **Managed OAuth**.
5. Enable localhost/loopback redirect URIs if you want MCP Inspector OAuth testing.
6. Copy the Access application **AUD tag** and your team domain (`https://<team>.cloudflareaccess.com`).
7. Configure both in the Worker. They are not Jules credentials, but keeping deployment-specific values out of source avoids committing account configuration:

```bash
npx wrangler secret put TEAM_DOMAIN
npx wrangler secret put POLICY_AUD
```

8. Deploy again after setting the bindings:

```bash
npm run worker:deploy
```

The Worker validates `Cf-Access-Jwt-Assertion` against the Access signing keys, issuer, and application audience before invoking MCP.

No OAuth client secret is stored in this Worker when using Access Managed OAuth; Cloudflare Access owns the OAuth flow.

## Production MCP verification

With Access configured, connect MCP Inspector to:

```text
https://<worker-host>/mcp
```

Use **Quick OAuth Flow** in Inspector. After authenticating through Access:

1. List tools.
2. Call `list_sources` or `list_sessions`.
3. Confirm the result is structured Jules JSON.
4. Open a private/incognito request or use curl without an Access session/token and confirm privileged `/mcp` access is rejected.
5. Confirm `/health` contains only non-sensitive service status.

## Connect to ChatGPT

After the production Inspector test succeeds, add the remote MCP endpoint in ChatGPT's custom MCP/app connection flow:

```text
https://<worker-host>/mcp
```

ChatGPT should discover the OAuth metadata exposed by Cloudflare Access Managed OAuth, open the Access login flow, and then discover the MCP tools.

This repository change does not claim that the ChatGPT UI connection itself has been tested until that final interactive step is performed from the target ChatGPT workspace.

## Secrets and logging

Do not put `JULES_API_KEY` in `wrangler.jsonc`, source files, tool inputs, health output, or logs.

The Worker deliberately returns generic tool errors so upstream Jules error bodies and credentials are not exposed to MCP clients.
