import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock p-queue to avoid ESM issues
jest.mock('p-queue', () => {
  return jest.fn().mockImplementation(() => ({
    add: jest.fn((fn: any) => fn()),
  }));
});

import { SoulseekService } from '../../src/services/soulseek';
import { distributedLock } from '../../src/utils/distributedLock';

describe('SoulseekService - Connection Race Condition', () => {
  let service: SoulseekService;
  let connectSpy: jest.SpiedFunction<any>;

  beforeEach(() => {
    service = new SoulseekService();
    // Spy on the private connect method
    connectSpy = jest.spyOn(service as any, 'connect').mockResolvedValue(undefined);
  });

  it('should prevent concurrent connection attempts', async () => {
    // Simulate 3 concurrent connection requests
    const promises = [
      (service as any).ensureConnected(),
      (service as any).ensureConnected().catch((e: Error) => {
        // Second request fails to acquire lock, error is re-thrown with user-friendly message
        expect(e.message).toContain('Soulseek connection already in progress');
      }),
      (service as any).ensureConnected().catch((e: Error) => {
        // Third request fails to acquire lock, error is re-thrown with user-friendly message
        expect(e.message).toContain('Soulseek connection already in progress');
      }),
    ];

    await Promise.all(promises);

    // With distributed lock: should only call connect once
    // Other concurrent requests are blocked by the lock
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});
