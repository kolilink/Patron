const crypto = require('crypto');

module.exports = {
  getRandomValues: (buf) => {
    const bytes = crypto.randomBytes(buf.length);
    buf.set(bytes);
    return buf;
  },
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn(async (_algorithm, data) =>
    crypto.createHash('sha256').update(data).digest('hex')
  ),
};
