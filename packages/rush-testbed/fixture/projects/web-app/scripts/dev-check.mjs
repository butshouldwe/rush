import isOdd from 'is-odd';

if (isOdd(3) !== true) {
  throw new Error('dev sanity check failed');
}
