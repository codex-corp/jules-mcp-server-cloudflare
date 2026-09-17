# Phase 1B Diagnostic Note

Status after live regression testing:

- `list_activities`: PASS
- `get_activity`: PASS
- `get_activities_since`: FAIL

The current implementation constructs the incremental request with both `pageSize` and `createTime`, e.g.:

```text
/sessions/<session-id>/activities?pageSize=5&createTime=2026-09-15T12%3A00%3A00Z
```

The existing activity failure logger records only the base endpoint, so `wrangler tail` cannot currently prove the final query string. No behavioral change should be made until the upstream request is isolated with a direct A/B request or a diagnostic-only request-path log.

Also track a later P2 sanitation concern: some `AGENT_MESSAGED` summaries may expose internal-looking reasoning text. This is not a Phase 1B blocker.
