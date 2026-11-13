/** Errors raised by the AI client and the ensemble. Kept in a module of its own so code that only needs the error type does not load the HTTP client. */
export class AiError extends Error {
  constructor(message: string, public code: 'no-provider' | 'auth' | 'quota' | 'model' | 'network' | 'cors' | 'aborted' | 'unsupported' | 'other' = 'other', public status?: number) { super(message); }
}

/** How long one AI request may take before it is given up (a stream: how long it may go without sending anything). */
export const AI_TIMEOUT_MS = 180_000;
