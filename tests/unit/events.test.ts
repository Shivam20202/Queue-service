import { describe, expect, it } from 'vitest';
import { buildEventPipeline, buildServices, createQueue, freshKey } from '../helpers';

async function setup() {
  const s = buildServices();
  const queue = await createQueue(s, 't1');
  const pipeline = buildEventPipeline(s.store, s.clock);
  const join = () =>
    s.join.join({
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c1',
      idempotencyKey: freshKey(),
      name: 'Asha',
      phone: '+919876543210',
    });
  return { s, queue, ...pipeline, join };
}

describe('outbox relay + consumer', () => {
  it('join creates a CustomerJoined outbox event atomically with the entry', async () => {
    const { s, queue, join } = await setup();
    await join();
    const { entries, outbox } = s.store.snapshot('t1', queue.id);
    expect(entries).toHaveLength(1);
    expect(outbox).toMatchObject([{ type: 'CustomerJoined', status: 'Pending' }]);
  });

  it('the event payload carries ids only, never the phone number', async () => {
    const { s, queue, join } = await setup();
    await join();
    const [event] = s.store.snapshot('t1', queue.id).outbox;
    expect(JSON.stringify(event)).not.toContain('+9198765');
  });

  it('relay publishes Pending events to the bus and marks them Published', async () => {
    const { s, queue, bus, relay, join } = await setup();
    await join();
    expect(await relay.runOnce()).toEqual({ published: 1, failed: 0 });
    expect(bus.published).toHaveLength(1);
    expect(s.store.snapshot('t1', queue.id).outbox[0].status).toBe('Published');
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0 }); // not sent twice
  });

  it('a failed publish keeps the event Pending and it is retried after backoff (no lost event)', async () => {
    const { s, queue, bus, relay, join } = await setup();
    await join();
    bus.failNextPublishes(1);

    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1 });
    const [afterFailure] = s.store.snapshot('t1', queue.id).outbox;
    expect(afterFailure).toMatchObject({ status: 'Pending', attempts: 1 });

    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0 }); // still backing off
    s.clock.advance(5000);
    expect(await relay.runOnce()).toEqual({ published: 1, failed: 0 });
    expect(bus.published).toHaveLength(1);
  });

  it('end to end: join -> relay -> bus -> consumer sends exactly one SMS', async () => {
    const { bus, relay, sms, join } = await setup();
    await join();
    await relay.runOnce();
    await bus.drain();
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe('+919876543210');
  });

  it('duplicate delivery of the same message does not send a second SMS', async () => {
    const { bus, consumer, relay, sms, join } = await setup();
    await join();
    await relay.runOnce();
    const [message] = bus.published;

    expect(await consumer.handle(message)).toBe('sent');
    expect(await consumer.handle(message)).toBe('duplicate');
    expect(await consumer.handle(message)).toBe('duplicate');
    expect(sms.sent).toHaveLength(1);
  });

  it('two simultaneous deliveries of the same message send only one SMS', async () => {
    const { bus, consumer, relay, sms, join } = await setup();
    await join();
    await relay.runOnce();
    const [message] = bus.published;
    const outcomes = await Promise.all([consumer.handle(message), consumer.handle(message)]);
    expect(outcomes.sort()).toEqual(['duplicate', 'sent']);
    expect(sms.sent).toHaveLength(1);
  });

  it('if the SMS send fails the claim is released so redelivery sends it (SMS is not lost)', async () => {
    const { bus, consumer, relay, sms, join } = await setup();
    await join();
    await relay.runOnce();
    const [message] = bus.published;
    const realSend = sms.send.bind(sms);
    let fail = true;
    sms.send = async (payload) => {
      if (fail) throw new Error('provider down');
      return realSend(payload);
    };

    await expect(consumer.handle(message)).rejects.toThrow('provider down');
    fail = false;
    expect(await consumer.handle(message)).toBe('sent');
    expect(sms.sent).toHaveLength(1);
  });

  it('call-next produces a CustomerCalled SMS to the called customer', async () => {
    const { s, queue, bus, relay, sms, join } = await setup();
    await join();
    await relay.runOnce();
    await bus.drain();
    await s.callNext.callNext('t1', queue.id);
    await relay.runOnce();
    await bus.drain();
    expect(sms.sent).toHaveLength(2);
    expect(sms.sent[1].text).toContain('your turn');
  });
});
