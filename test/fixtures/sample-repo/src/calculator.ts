import { add } from './mathUtils';

export function sum(values: number[]) {
  return values.reduce((acc, v) => add(acc, v), 0);
}
