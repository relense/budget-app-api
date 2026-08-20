import { describe, expect, it } from '@jest/globals';
import { graphql } from 'graphql';
import { mutationResolvers, queryResolvers, schema } from '../../src/graphql/schema.js';

describe('Query.ping', () => {
  it('returns pong', async () => {
    const result = await graphql({ schema, source: '{ ping }' });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ ping: 'pong' });
  });
});

// codegen's generated QueryResolvers/MutationResolvers make every field
// optional (GraphQL allows a default property-access resolver), so typing
// queryResolvers/mutationResolvers against them doesn't force a resolver
// to exist for a brand-new SDL field — verified by actually testing it
// (see docs/PROGRESS.md's GraphQL Code Generator entry). This is the
// runtime backstop for that gap: every field the SDL declares must have a
// matching key in the resolver map, so a forgotten resolver fails a test
// instead of only surfacing the first time a client queries that field.
describe('schema completeness', () => {
  it('every Query field has a matching resolver', () => {
    const sdlFields = Object.keys(schema.getQueryType()!.getFields());

    expect(sdlFields.sort()).toEqual(Object.keys(queryResolvers).sort());
  });

  it('every Mutation field has a matching resolver', () => {
    const sdlFields = Object.keys(schema.getMutationType()!.getFields());

    expect(sdlFields.sort()).toEqual(Object.keys(mutationResolvers).sort());
  });
});
