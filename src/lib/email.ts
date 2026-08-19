export interface EmailService {
  sendOtpEmail(email: string, code: string): Promise<void>;
}

interface LoggerLike {
  info: (msg: string) => void;
}

export function createConsoleEmailService(logger: LoggerLike): EmailService {
  return {
    async sendOtpEmail(email, code) {
      logger.info(`[dev email] OTP code for ${email}: ${code}`);
    },
  };
}
