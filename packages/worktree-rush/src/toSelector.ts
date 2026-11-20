/**
 * Checked `--to` package selectors. Deliberately import-free at runtime
 * (zero-workspace-imports contract; nothing here may touch process or fs).
 *
 * Grammar: an npm package name — optional `@scope/` then a name, where each
 * component is lowercase letters, digits, `.`, `_`, `-` and starts with a
 * letter or digit; non-empty, at most 214 characters in total. Anything
 * else (spaces, quotes, cmd.exe/shell metacharacters, newlines, leading `-`
 * that would read as a flag, uppercase, extra path separators) is refused.
 */
const COMPONENT = '[a-z0-9][a-z0-9._-]*';
const TO_SELECTOR = new RegExp(`^(?:@${COMPONENT}/)?${COMPONENT}$`);
export const TO_SELECTOR_MAX_LENGTH = 214;

export function isValidToSelector(value: string): boolean {
  return value.length <= TO_SELECTOR_MAX_LENGTH && TO_SELECTOR.test(value);
}

/** Returns a diagnostic for the first invalid selector, or undefined when
 * all are valid. The only caller-supplied text it quotes is the invalid
 * value itself. */
export function toSelectorError(values: readonly string[] | undefined): string | undefined {
  for (const value of values ?? []) {
    if (!isValidToSelector(value)) {
      return `--to value ${JSON.stringify(value)} is not a valid npm package name (optional @scope/, lowercase letters, digits, . _ -, at most ${TO_SELECTOR_MAX_LENGTH} characters)`;
    }
  }
  return undefined;
}
