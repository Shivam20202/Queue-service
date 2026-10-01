import { Errors } from '../domain/errors';
import { Location, Queue } from '../domain/types';
import { newId } from '../shared/ids';
import { Clock, QueueStore } from './ports';

export const DEFAULT_AVG_SERVICE_MINUTES = 5;

export class DirectoryService {
  constructor(
    private readonly store: QueueStore,
    private readonly clock: Clock,
  ) {}

  async createLocation(tenantId: string, name: string): Promise<Location> {
    const location: Location = {
      id: newId(),
      tenantId,
      name,
      createdAt: this.clock().toISOString(),
    };
    await this.store.createLocation(location);
    return location;
  }

  async createQueue(
    tenantId: string,
    locationId: string,
    name: string,
    avgServiceMinutes: number = DEFAULT_AVG_SERVICE_MINUTES,
  ): Promise<Queue> {
    // The location lookup is tenant-scoped: another tenant's location id is simply "not found".
    const location = await this.store.getLocation(tenantId, locationId);
    if (!location) throw Errors.locationNotFound();
    const queue: Queue = {
      id: newId(),
      tenantId,
      locationId,
      name,
      avgServiceMinutes,
      createdAt: this.clock().toISOString(),
    };
    await this.store.createQueue(queue);
    return queue;
  }
}
