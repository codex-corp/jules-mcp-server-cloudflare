# Jules MCP Validation Guide

## Evidence hierarchy

Prefer, in order:

1. Live runtime behavior through the deployed MCP.
2. Deployed tool discovery/schema.
3. Repository tests and CI.
4. Source-code inspection.
5. Assumption or inference.

Do not let a lower level override contradictory higher-level runtime evidence without investigation.

## Lossless activity-content gate

PASS requires all relevant items:

- a real long `AGENT_MESSAGED` or equivalent activity;
- `get_activity_content` returns content rather than a bounded summary;
- multi-chunk retrieval completes with `hasMore=false`;
- each continuation uses the prior `nextOffset`;
- concatenated text shows no missing or duplicated characters;
- an independent boundary probe agrees with the assembled boundary;
- if the whole content fits in one allowed read, the one-shot text matches the assembled text;
- list/status endpoints remain compact.

Describe this as lossless user-visible Unicode/code-point retrieval unless a byte-level source hash is independently available.

## Polling-safety gate

Verify `get_session_status` contains only small lifecycle fields needed for polling. It should not reintroduce full prompts, full source metadata, PR lists, or activity payloads.

## Activity-discovery gate

Verify `list_activities` stays compact. Long messages may be summarized/truncated there by design.

A summary truncation is not a bug if `get_activity_content` can retrieve the complete content explicitly.

## Artifact gate

Verify:
- activity list/detail do not leak raw patch/full command output/media bytes;
- artifact metadata is bounded;
- raw patch retrieval is explicit and chunked;
- embedded media bytes are not exposed.

## Source gate

Verify:
- opaque source names are accepted according to the active schema;
- source detail exposes resolved repository identity when Jules provides it;
- any repository allowlist checks resolved owner/repo rather than source-name text.

## Messaging gate

For follow-up messaging:
- `success:true` means operation acceptance, not immediate agent reply;
- confirm an actual later activity before claiming Jules responded;
- do not declare a completed session immutable without runtime evidence.

## Final validation report

Use this structure:

```text
Phase/feature: <name>
Status: PASS | FAIL | BLOCKED

Repository/CI evidence:
- <exact checks that actually ran>

Runtime evidence:
- session <id>, state <state>
- activity <id/type>
- retrieval <chunks/totalChars/result>

Remaining caveat:
- <none or precise limitation>
```

Never claim lint, smoke, deployment, or runtime verification merely because a neighboring CI step passed.
