// Critical path 3: isNetworkError — decides whether a failed sale goes to the queue
// Critical path 4: translateError — every French error message users see

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

jest.mock('@/lib/db', () => ({
  getPendingOps: jest.fn().mockResolvedValue([]),
  deleteQueueItem: jest.fn(),
  markAttemptFailed: jest.fn(),
}));

import { isNetworkError } from '@/lib/sync';
import { translateError } from '@/lib/errors';

describe('isNetworkError', () => {
  it('returns true for fetch failures', () => {
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('failed to fetch'))).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isNetworkError(new Error('Network request failed'))).toBe(true);
    expect(isNetworkError(new Error('network error occurred'))).toBe(true);
  });

  it('returns true for timeout and connection errors', () => {
    expect(isNetworkError(new Error('connection timeout'))).toBe(true);
    expect(isNetworkError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isNetworkError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('returns true for iOS-specific load failure', () => {
    expect(isNetworkError(new Error('load failed'))).toBe(true);
  });

  it('returns false for auth and permission errors', () => {
    expect(isNetworkError(new Error('permission denied'))).toBe(false);
    expect(isNetworkError(new Error('invalid login credentials'))).toBe(false);
    expect(isNetworkError(new Error('JWT expired'))).toBe(false);
  });

  it('returns false for database constraint errors', () => {
    expect(isNetworkError(new Error('duplicate key violates unique constraint'))).toBe(false);
    expect(isNetworkError(new Error('violates foreign key constraint'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isNetworkError('some string')).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError(42)).toBe(false);
  });
});

describe('translateError', () => {
  it('translates auth errors to French', () => {
    expect(translateError(new Error('invalid login credentials'), 'fallback'))
      .toBe('Email ou mot de passe incorrect');
    expect(translateError(new Error('invalid credentials'), 'fallback'))
      .toBe('Email ou mot de passe incorrect');
    expect(translateError(new Error('user already registered'), 'fallback'))
      .toBe('Cet email est déjà utilisé');
  });

  it('translates session expiry to French', () => {
    expect(translateError(new Error('token has expired'), 'fallback'))
      .toBe('Session expirée. Reconnectez-vous.');
    expect(translateError(new Error('jwt expired'), 'fallback'))
      .toBe('Session expirée. Reconnectez-vous.');
  });

  it('translates network errors to French', () => {
    expect(translateError(new Error('network request failed'), 'fallback'))
      .toBe('Erreur de réseau. Vérifiez votre connexion.');
    expect(translateError(new Error('failed to fetch'), 'fallback'))
      .toBe('Erreur de réseau. Vérifiez votre connexion.');
  });

  it('translates DB permission errors to French', () => {
    expect(translateError(new Error('permission denied for table'), 'fallback'))
      .toBe('Accès refusé');
    expect(translateError(new Error('violates row-level security policy'), 'fallback'))
      .toBe('Accès refusé');
  });

  it('returns the fallback for unknown errors', () => {
    expect(translateError(new Error('something completely unexpected'), 'Erreur inattendue'))
      .toBe('Erreur inattendue');
  });

  it('returns the fallback when error is not an Error instance', () => {
    expect(translateError('a plain string', 'fallback')).toBe('fallback');
    expect(translateError(null, 'fallback')).toBe('fallback');
    expect(translateError({ code: 42 }, 'fallback')).toBe('fallback');
  });
});
