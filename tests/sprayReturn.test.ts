import { expect, it } from 'vitest';
import { createSprayPool } from '../src/foam/sprayPool';

it('rejects conflicting return planes and invalid birth offsets', () => {
  expect(() => createSprayPool(2, { returnBelowBirth: 0.05, killBelow: () => 0 })).toThrow('no shared killBelow plane');
  for (const offset of [-1, NaN, Infinity]) {
    expect(() => createSprayPool(2, { returnBelowBirth: offset })).toThrow('finite nonnegative offset');
  }
});
