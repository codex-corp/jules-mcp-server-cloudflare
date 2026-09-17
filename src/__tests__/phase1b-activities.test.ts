import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JulesClient } from '../api/jules-client.js';

describe('Phase 1B Jules activity compatibility', () => {
  let client: JulesClient;

  beforeEach(() => {
    vi.stubEnv('JULES_API_KEY', 'test-key');
    vi.stubEnv('JULES_API_MAX_RETRIES', '0');
    client = new JulesClient();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function mockJson(data: unknown) {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue(data),
      text: vi.fn().mockResolvedValue(JSON.stringify(data)),
    });
  }

  it('normalizes the current Jules planGenerated activity DTO', async () => {
    mockJson({
      activities: [
        {
          name: 'sessions/123/activities/act1',
          id: 'act1',
          originator: 'agent',
          description: 'Plan generated',
          createTime: '2026-09-17T10:00:00Z',
          planGenerated: {
            plan: {
              id: 'plan1',
              steps: [
                {
                  id: 'step1',
                  index: 0,
                  title: 'Inspect code',
                  description: 'Review the existing implementation',
                },
                {
                  id: 'step2',
                  index: 1,
                  title: 'Apply fix',
                  description: 'Update the activity adapter',
                },
              ],
            },
          },
        },
      ],
    });

    const result = await client.listActivities('123', 20);

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toEqual(
      expect.objectContaining({
        name: 'sessions/123/activities/act1',
        type: 'PLAN_GENERATED',
        timestamp: '2026-09-17T10:00:00Z',
      })
    );
    expect(result.activities[0].planGenerated?.plan).toContain(
      'Inspect code: Review the existing implementation'
    );
  });

  it('normalizes current agent messages and failed session activities', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({
          name: 'sessions/123/activities/agent1',
          createTime: '2026-09-17T10:01:00Z',
          agentMessaged: { agentMessage: 'I need clarification.' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({
          name: 'sessions/123/activities/fail1',
          createTime: '2026-09-17T10:02:00Z',
          sessionFailed: { reason: 'Dependency installation failed' },
        }),
      });

    const message = await client.getActivity('123', 'agent1');
    expect(message.type).toBe('AGENT_MESSAGED');
    expect(message.agentMessaged?.message).toBe('I need clarification.');

    const failed = await client.getActivity('123', 'fail1');
    expect(failed.type).toBe('SESSION_FAILED');
    expect(failed.progressUpdated?.message).toBe(
      'Dependency installation failed'
    );
  });

  it('filters incremental activities client-side using supported pagination', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({
          activities: [
            {
              name: 'sessions/123/activities/old',
              createTime: '2026-09-15T11:59:59Z',
              progressUpdated: { description: 'Old update' },
            },
            {
              name: 'sessions/123/activities/newer',
              createTime: '2026-09-15T12:05:00Z',
              progressUpdated: { description: 'Later update' },
            },
          ],
          nextPageToken: 'next-page',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({
          activities: [
            {
              name: 'sessions/123/activities/new',
              createTime: '2026-09-15T12:01:00Z',
              agentMessaged: { agentMessage: 'First new update' },
            },
            {
              name: 'sessions/123/activities/boundary',
              createTime: '2026-09-15T12:00:00Z',
              progressUpdated: { description: 'Boundary update' },
            },
          ],
        }),
      });

    const since = '2026-09-15T12:00:00Z';
    const result = await client.listActivitiesSince('123', since, 5);

    expect(result.activities.map((activity) => activity.name)).toEqual([
      'sessions/123/activities/new',
      'sessions/123/activities/newer',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.pathname).toBe('/v1alpha/sessions/123/activities');
    expect(firstUrl.searchParams.get('pageSize')).toBe('100');
    expect(firstUrl.searchParams.has('createTime')).toBe(false);
    expect(firstUrl.searchParams.has('filter')).toBe(false);

    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get('pageToken')).toBe('next-page');
    expect(secondUrl.searchParams.has('createTime')).toBe(false);
  });

  it('keeps activity pagination tokens on ordinary list requests', async () => {
    mockJson({ activities: [], nextPageToken: 'next-token' });

    const result = await client.listActivities('123', 20, 'page-token');
    expect(result.nextPageToken).toBe('next-token');

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('pageToken')).toBe('page-token');
  });
});
