import { describe, expect, it, jest } from '@jest/globals';
import { createConsoleEmailService } from '../../src/lib/email.js';

describe('createConsoleEmailService', () => {
  it('logs the OTP code for the given email without sending anywhere', async () => {
    const info = jest.fn();
    const service = createConsoleEmailService({ info });

    await service.sendOtpEmail('user@example.com', '123456');

    expect(info).toHaveBeenCalledTimes(1);
    const [message] = info.mock.calls[0] as [string];
    expect(message).toContain('user@example.com');
    expect(message).toContain('123456');
  });
});
