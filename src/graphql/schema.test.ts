import { describe, expect, it } from '@jest/globals';
import { graphql } from 'graphql';
import { schema } from './schema.js';

describe('Query.ping', () => {
  it('returns pong', async () => {
    const result = await graphql({ schema, source: '{ ping }' });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ ping: 'pong' });
  });
});
