import { describe, expect, it } from 'vitest';

import { normalizeJulesActivity } from '../api/jules-activity-normalizer.js';

describe('Jules activity sanitation', () => {
  it('omits internal-looking thought traces from agent messages', () => {
    const activity = normalizeJulesActivity({
      name: 'sessions/session-1/activities/activity-1',
      createTime: '2026-09-15T02:28:15.994061Z',
      agentMessaged: {
        agentMessage: '闸thought\nLet\'s inspect the repository before replying.',
      },
    });

    expect(activity.type).toBe('AGENT_MESSAGED');
    expect(activity.agentMessaged).toBeUndefined();
  });

  it('preserves only explicit final-channel text when a trace contains one', () => {
    const activity = normalizeJulesActivity({
      name: 'sessions/session-1/activities/activity-2',
      createTime: '2026-09-15T02:30:00Z',
      agentMessaged: {
        agentMessage:
          '闸thought\nInternal reasoning that should not be exposed.\n闸final\nThe migration is complete and tests pass.',
      },
    });

    expect(activity.agentMessaged?.message).toBe(
      'The migration is complete and tests pass.'
    );
  });

  it('leaves ordinary user-facing agent messages unchanged', () => {
    const message = 'I finished the requested audit and found two stale paths.';
    const activity = normalizeJulesActivity({
      name: 'sessions/session-1/activities/activity-3',
      agentMessaged: { agentMessage: message },
    });

    expect(activity.agentMessaged?.message).toBe(message);
  });

  it('does not treat ordinary prose beginning with Thought as an internal trace', () => {
    const message = 'Thought leadership notes are ready for review.';
    const activity = normalizeJulesActivity({
      name: 'sessions/session-1/activities/activity-4',
      agentMessaged: { agentMessage: message },
    });

    expect(activity.agentMessaged?.message).toBe(message);
  });
});
