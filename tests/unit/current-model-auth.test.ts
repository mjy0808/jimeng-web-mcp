import { describe, expect, it } from '@jest/globals';
import { generateCookie } from '../../src/utils/auth.js';
import { getModel, DEFAULT_MODEL } from '../../src/types/models.js';

describe('Current image model and session credentials', () => {
  it('maps 5.0 Lite explicitly instead of falling back to 4.5', () => {
    expect(getModel('jimeng-5.0-lite')).toBe('high_aes_general_v50');
    expect(getModel('jimeng-5.0')).toBe('high_aes_general_v50');
    expect(getModel('jimeng-5.0-lite')).not.toBe(getModel(DEFAULT_MODEL));
  });

  it('builds cookies solely from the current caller session', () => {
    expect(generateCookie(' test-session-123 ')).toBe(
      'sessionid=test-session-123; sessionid_ss=test-session-123; sid_tt=test-session-123'
    );
  });

  it.each(['', '   ', 'session; other=account', 'session\r\nInjected: header'])(
    'rejects an invalid session value without reflecting it', value => {
      expect(() => generateCookie(value)).toThrow('sessionid 格式无效');
    }
  );
});
