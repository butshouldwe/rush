/**
 * Thrown for argv/config-shaped problems the CLI maps to exit 2 (usage), as
 * opposed to runtime/generation failures which map to exit 1. Lives in its
 * own module so both run.ts and scenarios.ts can throw it without an import
 * cycle. Mirrors fallow-rush's ScopeConflictError split.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
