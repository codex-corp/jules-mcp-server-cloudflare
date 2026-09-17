# Jules MCP Server for Cloudflare Workers

A small, stateless remote MCP server for the Google Jules API.

It runs on Cloudflare Workers, exposes Streamable HTTP at `/mcp`, and uses Cloudflare Access Managed OAuth for authentication. The Jules API key stays in Cloudflare Secrets and is never sent to the MCP client.

![Jules MCP connected in MCP Inspector](docs/assets/mcp-inspector.jpg)

> This is an independent open-source project. It is not created, maintained, or endorsed by Google.

## What it provides

- Remote MCP over Streamable HTTP
- Cloudflare Workers deployment
- Cloudflare Access Managed OAuth
- Stateless request handling; no database or Durable Objects
- Jules sessions, activities, sources, plan approval, and messaging
- Optional repository allowlist
- Local stdio server remains available for existing workflows

Remote Worker tools:

| Area | Tools |
| --- | --- |
| Create | `create_coding_task`, `create_repoless_task` |
| Sessions | `list_sessions`, `get_session_status`, `manage_session`, `delete_session` |
| Activities | `list_activities`, `get_activity`, `get_activities_since` |
| Sources | `list_sources`, `get_source_details` |

The remote Worker intentionally does not expose the local scheduler or polling/wait tools.

## Prerequisites

You need:

- A Cloudflare account with Workers and Zero Trust Access
- Node.js 22+ recommended
- npm 11.19.1 recommended
- A Jules API key from <https://jules.google.com/settings>
- Git
- GitHub repositories connected to Jules if you want to create repository-backed tasks

The project is tested in CI with Node 22. npm 10.9.8 hit an Arborist dependency-resolution bug while regenerating this project's lockfile, so npm 11.19.1 is the validated version.

## Install

```bash
git clone https://github.com/codex-corp/jules-mcp-server-cloudflare.git
cd jules-mcp-server-cloudflare

npm install --global npm@11.19.1
npm ci

npm run worker:typecheck
npm test
```

## Login / Auth

Login to Cloudflare with Wrangler:

```bash
npm run worker:login
```

Verify which Cloudflare account Wrangler is using:

```bash
npm run worker:auth
```

These commands are aliases for `wrangler login` and `wrangler whoami`.

## Deploy the Worker

Store the Jules API key as a Cloudflare secret:

```bash
npx wrangler secret put JULES_API_KEY
```

Optional but recommended: restrict task creation to specific repositories.

```bash
npx wrangler secret put JULES_ALLOWED_REPOS
```

Example value:

```text
my-org/api,my-org/web-app
```

Deploy:

```bash
npm run worker:deploy
```

Wrangler will return a URL similar to:

```text
https://<worker-name>.<account-subdomain>.workers.dev
```

At this point `/health` is available, while `/mcp` will remain unauthorized until Cloudflare Access is configured.

## Protect `/mcp` with Cloudflare Access

The recommended setup is a Cloudflare Access application in front of the Worker. Do not put a custom OAuth server inside this Worker.

### 1. Create the Access application

In Cloudflare Zero Trust:

1. Go to **Access controls → Applications**.
2. Select **Create new application**.
3. Create a **Self-hosted** application.
4. Add the Worker hostname as the public destination.
5. Set the path to `mcp` so only `/mcp` is protected.
6. Add an **Allow** policy for the users or groups that should be able to use the MCP server.

Use generic values like:

```text
Hostname: <worker-name>.<account-subdomain>.workers.dev
Path:     mcp
```

Keep `/health` outside the Access application so it remains a simple public health check.

### 2. Enable Managed OAuth

Edit the Access application and open **Additional / Advanced settings**.

Enable **Managed OAuth**.

For local MCP Inspector testing, you can also enable localhost and loopback redirect clients. Keep redirect rules as narrow as possible for production clients.

Cloudflare documentation: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>

### 3. Get the two Access values

From your Zero Trust configuration, get:

```text
TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
POLICY_AUD=<application-audience-tag>
```

`POLICY_AUD` must be the application's **Audience (AUD) Tag**. It is not the Access Policy ID.

### 4. Bind Access to the Worker

Store both values in Worker secrets:

```bash
npx wrangler secret put TEAM_DOMAIN
npx wrangler secret put POLICY_AUD
```

Deploy again:

```bash
npm run worker:deploy
```

There is no separate application ID to hardcode in the project. The link between Access and the Worker is:

```text
MCP client
  → Cloudflare Access / Managed OAuth
  → protected Worker hostname + /mcp
  → Cf-Access-Jwt-Assertion
  → Worker validates TEAM_DOMAIN + POLICY_AUD
  → Jules API using JULES_API_KEY
```

The Worker does not store an OAuth client secret.

## Endpoints

```text
GET  /health   public health check
POST /mcp      protected MCP Streamable HTTP endpoint
```

Example:

```text
https://<worker-name>.<account-subdomain>.workers.dev/mcp
```

## Verify the deployment

Health check:

```bash
curl -i https://<worker-name>.<account-subdomain>.workers.dev/health
```

Then test the protected MCP endpoint with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector \
  --server-url https://<worker-name>.<account-subdomain>.workers.dev/mcp \
  --transport http
```

On WSL, if automatic browser opening is inconvenient:

```bash
MCP_AUTO_OPEN_ENABLED=false npx @modelcontextprotocol/inspector \
  --server-url https://<worker-name>.<account-subdomain>.workers.dev/mcp \
  --transport http
```

Open the localhost URL printed by Inspector in your Windows browser, complete the Cloudflare Access login, then verify:

1. MCP connects successfully.
2. `tools/list` returns the remote Jules tools.
3. `list_sources` or `list_sessions` returns a successful Jules API response.

## Security

- `JULES_API_KEY` is read from Cloudflare Secrets only in the Worker deployment.
- `/mcp` requires a valid Cloudflare Access JWT.
- The Worker validates both the Access issuer (`TEAM_DOMAIN`) and application audience (`POLICY_AUD`).
- Prompts and messages that look like secrets are rejected before they reach Jules.
- `JULES_ALLOWED_REPOS` can limit which repositories may receive new coding tasks.
- The Worker keeps no session state, token database, queue, or local schedule storage.

## Development checks

```bash
npm ci
npm run typecheck
npm run worker:typecheck
npm test
npx wrangler deploy --dry-run
```

For local Worker development:

```bash
npm run worker:dev
```

See [Cloudflare remote MCP notes](docs/CLOUDFLARE_REMOTE_MCP.md) for additional implementation and deployment details.

## References

- Jules API: <https://developers.google.com/jules/api>
- Jules: <https://jules.google>
- Cloudflare Access Managed OAuth: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>
- Cloudflare Access for Workers: <https://developers.cloudflare.com/workers/configuration/cloudflare-access/>
- Model Context Protocol: <https://modelcontextprotocol.io/>

## License

MIT
