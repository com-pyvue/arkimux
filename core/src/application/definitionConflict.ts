/** Shared identity used by Local and Managed immutable-definition adapters. */
export class ImmutableDefinitionConflictError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} already exists with different content.`);
    this.name = 'ImmutableDefinitionConflictError';
  }
}
