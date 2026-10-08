import { openWhatsAppUrls, WHATSAPP_URLS } from '@/src/utils/whatsapp';

describe('openWhatsApp URL fallback', () => {
  it('Android never relies on the bare whatsapp:// scheme (no intent filter matches it)', () => {
    expect(WHATSAPP_URLS.android).not.toContain('whatsapp://');
    expect(WHATSAPP_URLS.android[0]).toBe('whatsapp://send');
  });
  it('stops at the first URL that opens', async () => {
    const open = jest.fn().mockResolvedValue(true);
    expect(await openWhatsAppUrls(WHATSAPP_URLS.android, open)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('falls through to wa.me when the first form throws (ActivityNotFound)', async () => {
    const open = jest.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(true);
    expect(await openWhatsAppUrls(WHATSAPP_URLS.android, open)).toBe(true);
    expect(open).toHaveBeenLastCalledWith('https://wa.me/');
  });
  it('never throws when nothing opens', async () => {
    expect(await openWhatsAppUrls(WHATSAPP_URLS.android, jest.fn().mockRejectedValue(new Error('x')))).toBe(false);
  });
});
