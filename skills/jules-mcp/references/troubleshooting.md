# Jules MCP Troubleshooting

## “Jules produced an answer but I can only see ~500 characters”

Likely cause: using compact activity summary/detail instead of the explicit full-content path.

Action:
1. identify the activity ID;
2. call `get_activity_content`;
3. follow `nextOffset` while `hasMore=true`.

If that tool does not exist, report a full-result retrieval capability gap instead of reconstructing or guessing the missing text.

## “I deployed a new tool but ChatGPT/agent cannot see it”

Likely cause: client/plugin tool metadata cache.

Action:
1. inspect currently discovered tools;
2. refresh/reconnect the integration when supported;
3. inspect again;
4. only then investigate Worker deployment/schema if still absent.

## “send_message returned success but nothing happened”

Do not equate operation response with agent reply.

Action:
1. note the newest known activity;
2. poll session status cheaply;
3. discover later activities;
4. retrieve any new agent message fully.

A prior `COMPLETED` state does not by itself prove messaging is impossible; tested runtime behavior has processed a follow-up after completion.

## “AGENT_MESSAGED exists but session is still IN_PROGRESS”

This is not inherently inconsistent. Treat activity as an event/result and session state as lifecycle. Continue monitoring unless the user only needed that message and stopping is otherwise safe.

## “We can approve a plan but cannot find get_plan”

Do not assume a dedicated plan endpoint is required. Find `PLAN_GENERATED`, inspect the activity, and retrieve full textual content through `get_activity_content` when available.

## “Repository source name looks like owner/repo; can I parse it?”

No. Treat the source name as opaque. Use `get_source_details` for repository identity.

## “The patch is missing from get_activity”

Expected by design. Use `get_activity_artifacts`, then `get_activity_patch` for the chosen change set.

## “Should we add get_session_result?”

Only if a clear selection policy exists. Sessions can contain multiple agent messages, and a message can appear before terminal state. Prefer the explicit activity primitive rather than inventing a potentially wrong definition of “final message.”

## “Should we make list_activities return full text?”

No. Keep discovery compact. Large data must remain explicit to protect token/context usage and polling efficiency.

## “Can I trust a session summary as the full result?”

Only when the contract explicitly says it is complete and the text is not truncated. Otherwise retrieve the selected activity's full content.

## “The MCP says success but I need proof”

Use runtime evidence. Record session ID, activity ID, lifecycle state, total content length, chunk continuation, and any independent boundary check needed for the claim.
