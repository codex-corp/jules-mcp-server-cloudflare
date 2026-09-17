# Jules MCP Workflows

## 1. Read-only repository investigation

Use when the caller wants diagnosis, audit, planning, or evidence without edits.

1. Resolve the repository with `list_sources` / `get_source_details` if needed.
2. Create `create_coding_task` with:
   - exact source name;
   - correct branch;
   - `auto_create_pr=false`;
   - prompt explicitly forbidding edits, commits, and PR creation.
3. Save session ID.
4. Poll with `get_session_status`.
5. Discover activities with `get_activities_since` or `list_activities`.
6. For relevant `AGENT_MESSAGED`, fetch full text with `get_activity_content`.
7. Continue chunks until `hasMore=false`.
8. Report findings with session/activity evidence.

Never treat a truncated activity summary as the completed investigation.

## 2. Investigation → critique loop

Use when one Jules result should be challenged before implementation.

1. Complete the first read-only investigation.
2. Retrieve its full activity content.
3. Create a second bounded critique session or send a follow-up message with:
   - exact findings to challenge;
   - the proposed direction;
   - explicit request to identify counterexamples, unnecessary changes, and smaller fixes.
4. Retrieve the critique's full response.
5. Compare the two results yourself. Do not ask Jules to decide authority or ownership.
6. Produce the converged plan only after disagreements are resolved or clearly documented.

## 3. Plan-gated implementation

1. Create a repository task with plan approval required when supported and desired.
2. Poll session status cheaply.
3. Discover the generated-plan activity.
4. Retrieve the full plan via `get_activity_content` if the plan exceeds bounded metadata.
5. Review the plan against user constraints.
6. Approve only with explicit authority.
7. Continue monitoring.
8. Retrieve implementation result, artifacts, and patch only as needed.
9. Validate repository/CI/runtime evidence independently of Jules' self-report.

## 4. Long result retrieval

1. Identify the target activity from the compact activity list.
2. Call `get_activity_content` at offset 0.
3. Append the returned chunk.
4. If `hasMore=true`, call again with `offset=nextOffset`.
5. Stop only at `hasMore=false`.
6. Preserve chunk order.
7. For important validation, make an independent boundary probe near a continuation point.
8. If a larger one-shot read fits the total size, compare it against the assembled text.

Do not use overlapping guessed offsets in normal retrieval. Independent overlaps are only for validation probes.

## 5. Patch inspection

1. Call `get_activity_artifacts` first.
2. Choose the specific change set by index.
3. Call `get_activity_patch` with a bounded size.
4. Follow `nextOffset` until complete if the full patch is needed.
5. Avoid pulling patch text when changed-file metadata is sufficient for the current decision.

## 6. Follow-up message after a result

1. Send the follow-up through `manage_session(action="send_message")`.
2. Do not expect the tool response to contain Jules' reply.
3. Record the newest known activity/time.
4. Poll status with `get_session_status`.
5. Discover activities newer than the previous point.
6. Retrieve the new response with `get_activity_content`.

If no activity appears immediately, do not conclude the send failed merely because the session state did not change instantly.

## 7. Deployment/runtime validation

Use when a Jules MCP implementation was changed or redeployed.

1. Refresh/reconnect the client if tool metadata may be cached.
2. Inspect tool discovery/schema first.
3. Verify cheap status remains compact.
4. Verify list activities remains compact.
5. Verify the newly changed focused tool on a real activity.
6. For long-result retrieval, use a real result larger than one chunk.
7. Exercise continuation and boundary integrity.
8. Verify structured errors using a harmless nonexistent ID if appropriate.
9. Separate CI evidence from live runtime evidence in the final report.
