# Jules MCP Contract Guide

## Purpose

Use this reference to choose the smallest correct tool and to avoid accidental token-heavy or lossy workflows.

## Tool roles

| Tool | Primary role | Keep in repeated polling loop? |
| --- | --- | --- |
| `create_coding_task` | Start repository-backed work | No |
| `create_repoless_task` | Start work without repository context | No |
| `list_sessions` | Browse compact session summaries | No |
| `get_session_status` | Cheap lifecycle polling | Yes |
| `get_session_details` | Bounded task/config/PR context | No |
| `manage_session` | Approve a plan or send a message | No |
| `delete_session` | Destructive cancellation/deletion | No |
| `list_activities` | Compact activity discovery | Sometimes |
| `get_activities_since` | Incremental activity discovery | Yes, when useful |
| `get_activity` | Bounded detail for one activity | No |
| `get_activity_content` | Full textual content in bounded chunks | Only when content is needed |
| `get_activity_artifacts` | Artifact metadata/previews | No |
| `get_activity_patch` | Raw patch chunks | No |
| `list_sources` | Compact connected-source discovery | No |
| `get_source_details` | Resolved repository/source details | No |

Tool availability and schemas can evolve. Inspect the actual runtime schema when a field or limit matters.

## Session vs activity authority

Use session state for lifecycle. Use activities for event/result content.

Do not derive a synthetic `has_final_result` flag unless the upstream/runtime contract explicitly provides one.

An agent message can occur before terminal state. A terminal state can coexist with useful activities that are not present in session details.

## Bounded-output invariant

Keep these bounded by design:
- session lists;
- status polling;
- activity lists;
- normal activity detail;
- artifact previews.

Use explicit opt-in tools for potentially large data:
- activity full text → `get_activity_content`;
- patch text → `get_activity_patch`.

This separation is intentional. Do not “fix” truncation by making list/poll endpoints huge.

## Activity textual content

The full-content path should return the normalized user-visible text for the selected activity. Typical mappings are:

| Activity concept | Content type |
| --- | --- |
| Jules reply | `agent_message` |
| Generated plan | `plan` |
| User/session message | `user_message` |
| Progress update | `progress_message` |
| Completion text | `completion_message` |
| Session failure | `failure_reason` |
| Fallback human-readable text | `description` |

Agent message sanitation occurs before content retrieval. Internal-looking traces such as `闸thought` / `闸analysis` must not be exposed; an explicit `闸final` section may be retained as user-visible text.

## Chunk continuation

Follow server-returned continuation fields exactly:

```text
offset = 0
→ contentChunk
→ nextOffset
→ if hasMore: offset = nextOffset
```

Do not calculate the next offset from transport bytes. The reference remote MCP uses Unicode/code-point continuation for activity text.

Current reference deployment historically used 10,000-character defaults and 20,000-character maxima for content and patch chunks, but always inspect the active tool schema instead of hard-coding these values into orchestration logic.

## Source identity

A Jules source resource name is opaque. It can change shape independently of GitHub owner/repository identity.

Bad:

```text
parse "sources/..." and authorize based on substrings
```

Good:

```text
source name → Jules get source → github owner/repo → allowlist check
```

Use exact source names returned by Jules for later tool calls.

## Messaging semantics

A successful `send_message` call proves that the MCP accepted/forwarded the operation. It does not prove that Jules already generated a reply.

After sending a message:
1. record the operation time/current newest activity;
2. poll status cheaply;
3. discover later activities;
4. retrieve the new response explicitly.

Do not reject messaging solely because the prior observed session state was `COMPLETED`; runtime behavior may still accept and process it. Verify actual activity evidence.

## Error contract

Preserve useful error classes when available:
- `AUTH_ERROR`
- `NOT_FOUND`
- `RATE_LIMITED`
- `UPSTREAM_TIMEOUT`
- `JULES_UPSTREAM_ERROR`
- `RESPONSE_VALIDATION_ERROR`

Use `retryable` and upstream status/code fields when provided. Do not retry authorization or not-found errors blindly.
