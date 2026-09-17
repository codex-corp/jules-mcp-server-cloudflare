---
name: jules-mcp
description: Operate, orchestrate, validate, and troubleshoot Google Jules through a remote MCP integration. Use when an agent needs to create repository-backed or repoless Jules sessions, poll status cheaply, inspect activities, retrieve full long-form Jules messages without truncation, read plans, artifacts, and patches, approve plans, send follow-up messages, validate source identity, or diagnose Jules MCP contract/runtime problems. Prefer activity-first, bounded, lossless retrieval and evidence-backed PASS/FAIL/BLOCKED conclusions.
---

# Jules MCP

Use Jules as a delegated engineering agent while keeping the caller in control of orchestration, context, and validation.

## Core operating model

Treat the MCP surface as three layers:

1. **Dispatch** — create a Jules session with the correct source, branch, and constraints.
2. **Monitor** — poll cheap session state and discover new activities without repeatedly pulling large metadata.
3. **Retrieve** — explicitly fetch the exact activity content, artifacts, or patch only when needed.

Do not blur these layers. Cheap polling is a design requirement, not an optimization afterthought.

## First actions

1. Inspect the available Jules tools and their current schemas before relying on remembered limits or names.
2. Use `list_sources` when the repository source is unknown, then pass the exact returned source resource name to task creation.
3. Use `create_coding_task` for repository work and `create_repoless_task` only when repository context is unnecessary.
4. Record the returned session ID immediately; use it as the stable orchestration handle.
5. Use `get_session_status` for repeated polling. Do not poll with `get_session_details`.

Read [references/contracts.md](references/contracts.md) when choosing among tools or interpreting fields.

## Orchestration workflow

### 1. Dispatch deliberately

Preserve the user's actual authority boundary in the Jules prompt.

For read-only investigation, state explicitly:
- inspect/analyze only;
- do not edit files;
- do not commit;
- do not create a pull request;
- return findings, evidence, and a proposed plan only.

Set `auto_create_pr=false` when a PR must not be created. Use plan approval only when the user actually wants a human/agent gate before implementation.

Keep the prompt focused. Prefer repository-derived context over pasting large code or logs unless that context is unavailable to Jules.

### 2. Poll cheaply

Use `get_session_status(session_id)` as the normal loop.

Interpret session state as lifecycle state. Do not infer lifecycle from one activity alone. In particular:
- an `AGENT_MESSAGED` activity may appear while the session remains `IN_PROGRESS`;
- a message from Jules is not automatically a final result;
- terminal session state does not mean every useful result is present in session metadata.

Use `get_activities_since` for incremental observation when available. Treat its cursor as opaque and continue while `hasMore=true`.

### 3. Discover activities

Use `list_activities` for compact discovery only. Expect summaries to be bounded and possibly truncated.

Use `get_activity` for bounded metadata/detail about one selected activity. Do not assume its `summary` is the complete Jules message.

Select activities by type and purpose, typically:
- `AGENT_MESSAGED` for Jules analysis or replies;
- `PLAN_GENERATED` for a plan;
- `SESSION_COMPLETED` for completion metadata;
- `SESSION_FAILED` for failure information.

### 4. Retrieve full text losslessly

For any activity whose full textual content matters, use `get_activity_content`.

Start with:

```text
session_id = <session>
activity_id = <activity>
offset = 0
max_chars = a bounded value supported by the runtime schema
```

If `hasMore=true`, call again with `offset=nextOffset`. Continue until `hasMore=false`.

Concatenate `contentChunk` values in order. Never infer missing text from the summary.

Treat offsets as the MCP contract's continuation unit. Do not convert them into byte offsets or invent alternate cursor math.

If `get_activity_content` is unavailable but the activity summary is visibly truncated, report **BLOCKED: full result retrieval unavailable** rather than claiming the summary is complete.

### 5. Retrieve artifacts explicitly

Use `get_activity_artifacts` for bounded artifact metadata and previews.

Use `get_activity_patch` only when raw patch text is needed. Follow `nextOffset` while `hasMore=true` just as with activity content.

Do not expect `list_activities` or `get_activity` to carry full patches, full command output, or embedded media bytes.

### 6. Handle plans

Do not invent a separate upstream “final plan” concept.

Find the relevant `PLAN_GENERATED` activity and retrieve its full text through the activity content path when needed. Use `manage_session(action="approve_plan")` only after the intended plan has been inspected and approval is authorized.

### 7. Send follow-up messages carefully

Use `manage_session(action="send_message")` for follow-up instructions.

Treat `success:true` as acceptance of the operation, not proof that Jules has already produced a reply. Observe later activities to confirm the response.

Do not assume a completed session can or cannot accept a new message based only on its prior state. Runtime behavior has accepted such messages in some cases. Verify by watching for a new activity.

## Decision rules

- Need current state repeatedly? → `get_session_status`.
- Need original task/config/PR metadata? → `get_session_details` once, not as a poller.
- Need to discover what Jules did? → `list_activities` or `get_activities_since`.
- Need one activity's metadata? → `get_activity`.
- Need the full textual answer/plan/message? → `get_activity_content`.
- Need artifact inventory/previews? → `get_activity_artifacts`.
- Need raw patch text? → `get_activity_patch`.
- Need repository identity/branches? → `get_source_details`.
- Need to approve or continue conversation? → `manage_session`.
- Need to cancel/delete? → `delete_session`; treat as destructive and require clear user authorization.

## Source safety

Treat Jules source names as opaque resource identifiers, not trusted GitHub identity strings.

Use the exact source name returned by Jules. When repository identity matters, rely on source details returned by Jules (`owner`, `repo`, privacy/default branch/branches when present), not string parsing of `sources/...`.

When an allowlist is enforced, authorization must be based on the resolved repository identity, not on text embedded in the source resource name.

## Result integrity

For long activity text:
- prefer a single read when the runtime limit can contain the result;
- otherwise follow `nextOffset` exactly;
- optionally probe a chunk boundary during validation to prove no gap or overlap;
- describe the guarantee as lossless user-visible Unicode/code-point content unless an independent byte-level hash is available.

A content hash can be useful as a future integrity feature, but do not require it for normal orchestration.

## Failure and troubleshooting behavior

Never hide an integration gap behind a confident summary.

If a tool is missing after a new deployment, consider stale client/plugin tool metadata before concluding the Worker lacks the tool. Refresh or reconnect the Jules integration when possible, then inspect tools again.

If the runtime returns an upstream error, preserve the distinction between authentication, not found, rate limit, timeout, and generic upstream failure. Do not collapse everything into “Jules failed.”

If a session produces a long answer but only a bounded summary is available, mark the orchestration handoff as blocked until the full content path is available.

Read [references/troubleshooting.md](references/troubleshooting.md) for known failure patterns and validation checks.

## Validation gate

When validating the MCP itself, prove behavior through runtime evidence, not only repository tests.

For a lossless retrieval check:
1. Select a real Jules message longer than one chunk.
2. Retrieve it in at least two chunks.
3. Reassemble using returned offsets.
4. Probe around one boundary independently.
5. If possible, retrieve the same content in one larger read and compare the user-visible text.
6. Confirm compact list/status calls remain compact.

Report the outcome as:
- **PASS** — required behavior is demonstrated end to end;
- **FAIL** — observed behavior violates the contract;
- **BLOCKED** — evidence cannot be obtained with the available tools/access.

Read [references/validation.md](references/validation.md) when testing a deployment or MCP change.

## Reporting style

Lead with state and evidence. Keep orchestration reports compact unless the user asks for detail.

A useful default is:

```text
Status: PASS | FAIL | BLOCKED
Session: <id>
State: <state>
Relevant activity: <id/type>
Retrieval: <single read or N chunks, totalChars>
Finding: <one concise statement>
Next action: <only if needed>
```

Distinguish:
- observed runtime evidence;
- repository/test evidence;
- inference or recommendation.

Do not claim a CI step ran unless it actually ran.

## Detailed references

- Tool roles, data boundaries, and compatibility assumptions: [references/contracts.md](references/contracts.md)
- End-to-end patterns for investigation, critique, implementation, and follow-up: [references/workflows.md](references/workflows.md)
- Runtime validation gates and evidence standards: [references/validation.md](references/validation.md)
- Known integration pitfalls and recovery actions: [references/troubleshooting.md](references/troubleshooting.md)
