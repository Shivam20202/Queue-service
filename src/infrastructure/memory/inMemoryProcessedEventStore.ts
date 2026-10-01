import { Clock, ProcessedEventStore } from '../../application/ports';

interface Claim {
  state: 'claimed' | 'done';
  leaseUntil: number;
}

export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly claims = new Map<string, Claim>();

  constructor(private readonly clock: Clock = () => new Date()) {}

  async tryClaim(consumer: string, eventId: string, leaseMs: number): Promise<boolean> {
    const key = `${consumer}:${eventId}`;
    const now = this.clock().getTime();
    const existing = this.claims.get(key);
    if (existing?.state === 'done') return false;
    if (existing && existing.leaseUntil > now) return false;
    this.claims.set(key, { state: 'claimed', leaseUntil: now + leaseMs });
    return true;
  }

  async complete(consumer: string, eventId: string): Promise<void> {
    this.claims.set(`${consumer}:${eventId}`, { state: 'done', leaseUntil: 0 });
  }

  async release(consumer: string, eventId: string): Promise<void> {
    this.claims.delete(`${consumer}:${eventId}`);
  }
}
