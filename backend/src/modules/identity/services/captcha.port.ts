import { Injectable } from '@nestjs/common';

/** What the captcha hook gets when an OTP request crosses a soft threshold. */
export interface CaptchaCheck {
  /** `captchaToken` from the request body; null when the app sent none. */
  token: string | null;
  action: 'otp_request';
  /** Rate-limit key of the client (IPv4 address or IPv6 /64). */
  ip: string | null;
  /** Normalised E.164 phone. */
  phone: string;
}

/**
 * Captcha hook for `POST /auth/otp/request`. AuthService calls it only when the phone (24 h) or
 * the IP network (IP window) is over OTP_CAPTCHA_PHONE_THRESHOLD / OTP_CAPTCHA_IP_THRESHOLD; a
 * `false` answer is 403 PC_OTP_CAPTCHA_REQUIRED, which tells the app to show the challenge and
 * resend with `captchaToken`. Bind a real adapter (reCAPTCHA Enterprise, Turnstile, hCaptcha) in
 * IdentityModule; until then NoopCaptchaVerifier accepts everything.
 */
export abstract class CaptchaVerifierPort {
  abstract verify(check: CaptchaCheck): Promise<boolean>;
}

/** Default adapter: no provider chosen yet, every request passes (the hard limits still apply). */
@Injectable()
export class NoopCaptchaVerifier extends CaptchaVerifierPort {
  verify(_check: CaptchaCheck): Promise<boolean> {
    return Promise.resolve(true);
  }
}
