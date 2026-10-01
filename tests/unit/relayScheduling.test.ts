import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEventPipeline, buildServices, createQueue, freshKey } from '../helpers';

describe('OutboxRelay scheduling', () => {
  afterEach(() => vi.useRealTimers());

  it('start() publishes pending events on a timer and stop() halts it', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const { relay, bus } = buildEventPipeline(s.store, s.clock);
    await s.join.join({
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c1',
      idempotencyKey: freshKey(),
      name: 'Asha',
      phone: '+919876543210',
    });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // leave setImmediate real: the store uses it
    relay.start(1000);
    vi.advanceTimersByTime(1100);
    await vi.waitFor(() => expect(bus.published).toHaveLength(1));

    relay.stop();
    await s.join.join({
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c2',
      idempotencyKey: freshKey(),
      name: 'Bala',
      phone: '+919876500002',
    });
    vi.advanceTimersByTime(5000);
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.published).toHaveLength(1); // stopped: second event stays Pending
  });
});
