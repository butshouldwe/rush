import kleur from 'kleur';
import ms from 'ms';
import { add } from 'lib-a';
import { greet } from 'lib-b';

export function main() {
  return kleur.green(`${greet('world')} in ${ms(add(1000, 500))}`);
}
