import { stepQuantity, stepIsBlocked, clampQuantity, parseQuantity } from '@/src/utils/quantity';

describe('stepQuantity', () => {
  it('a line cannot go below 1 via the stepper', () => {
    expect(stepQuantity(1, -1)).toBe(1);
    expect(stepQuantity(1, -1, { min: 1 })).toBe(1);
    expect(stepQuantity(0, -1)).toBe(1);
    expect(stepIsBlocked(1, -1)).toBe(true);
  });
  it('steps by one inside the bounds', () => {
    expect(stepQuantity(5, -1)).toBe(4);
    expect(stepQuantity(5, 1)).toBe(6);
  });
  it('stops at known stock', () => {
    expect(stepQuantity(3, 1, { max: 3 })).toBe(3);
    expect(stepIsBlocked(3, 1, { max: 3 })).toBe(true);
    expect(stepIsBlocked(2, 1, { max: 3 })).toBe(false);
  });
  it('blank or half-typed text steps from zero to a valid first quantity', () => {
    expect(stepQuantity('', 1)).toBe(1);
    expect(stepQuantity('', -1)).toBe(1);
    expect(stepQuantity('7', 1)).toBe(8);
    expect(stepQuantity('1,5', 1)).toBe(2.5);
  });
  it('never returns NaN/Infinity', () => {
    expect(stepQuantity(NaN, 1)).toBe(1);
    expect(clampQuantity(Infinity, { max: 9 })).toBe(9);
    expect(parseQuantity('abc')).toBeNull();
  });
  it('a custom minimum of 0 is honoured where 0 is meaningful', () => {
    expect(stepQuantity(1, -1, { min: 0 })).toBe(0);
    expect(stepQuantity(0, -1, { min: 0 })).toBe(0);
  });
});
