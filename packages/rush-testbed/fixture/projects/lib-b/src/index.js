import { add } from 'lib-a';

export function greet(name) {
  return `hello ${name} (${add(1, 1)})`;
}

export function deadHelper() {
  return 'planted dead export: nothing imports this anywhere in the monorepo';
}
