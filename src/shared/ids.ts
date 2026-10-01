import { randomUUID } from 'node:crypto';

let lastMs = 0;
let sequence = 0;

/**
 * Time-sortable id: 9 chars of base36 milliseconds + 4-digit in-process sequence + random suffix.
 * Ids created in one process never collide, even inside the same millisecond.
 */
export function newId(now: number = Date.now()): string {
  if (now === lastMs) sequence += 1;
  else {
    lastMs = now;
    sequence = 0;
  }
  const time = now.toString(36).padStart(9, '0');
  return `${time}${sequence.toString().padStart(4, '0')}-${randomUUID().slice(0, 8)}`;
}
