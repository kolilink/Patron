import { shouldKickOnConnectivityChange } from '@/lib/netInfoKick';

describe('shouldKickOnConnectivityChange', () => {
  it('does not kick on the initial subscribe event (prev null)', () => {
    expect(shouldKickOnConnectivityChange(null, true)).toBe(false);
    expect(shouldKickOnConnectivityChange(null, false)).toBe(false);
  });

  it('kicks on a genuine offline -> online transition', () => {
    expect(shouldKickOnConnectivityChange(false, true)).toBe(true);
  });

  it('does not kick when staying online', () => {
    expect(shouldKickOnConnectivityChange(true, true)).toBe(false);
  });

  it('does not kick when going online -> offline', () => {
    expect(shouldKickOnConnectivityChange(true, false)).toBe(false);
  });

  it('does not kick when staying offline', () => {
    expect(shouldKickOnConnectivityChange(false, false)).toBe(false);
  });
});
