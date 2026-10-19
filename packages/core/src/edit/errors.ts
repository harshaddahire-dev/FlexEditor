export type EditErrorCode =
  | 'not_found'
  | 'locked'
  | 'overlap'
  | 'out_of_bounds'
  | 'invalid'
  | 'grid'
  | 'no_handle'
  | 'not_adjacent'
  | 'kind_mismatch'
  | 'invariant';

/** A rejected edit. The sequence is left untouched (operations run on an Immer draft that is discarded). */
export class EditError extends Error {
  constructor(
    readonly code: EditErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EditError';
  }
}

export const isEditError = (e: unknown): e is EditError => e instanceof EditError;
