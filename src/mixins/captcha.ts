import { CaptchaChallengeRequired, ClientError } from '../exceptions';
import type { Client } from '../client';

export type CaptchaHandler = (details: Record<string, any>) => string | Promise<string>;

export class CaptchaHandlerMixin {
  /**
   * Set a custom handler function for solving captcha challenges.
   * The handler receives challenge details (site_key, page_url, challenge_type, raw_challenge_json)
   * and returns the solved captcha token as a string. Pass null to clear.
   */
  setCaptchaHandler(this: Client, handler: CaptchaHandler | null): void {
    this._captchaHandlerInstance = handler;
  }

  /** Resolve a captcha challenge using the registered handler. */
  async captchaResolve(this: Client, challengeDetails: Record<string, any> = {}): Promise<string> {
    if (this._captchaHandlerInstance === undefined) {
      throw new ClientError('CaptchaHandlerMixin not properly initialized. _captcha_handler_instance is missing.');
    }
    if (this._captchaHandlerInstance) {
      let token: any;
      try {
        // Ensure all keys expected by typical handlers are present, even if None
        const detailsToPass = {
          site_key: challengeDetails.site_key ?? null,
          page_url: challengeDetails.page_url ?? null, // Important for some solvers
          challenge_type: challengeDetails.challenge_type ?? null,
          raw_challenge_json: challengeDetails.raw_challenge_json ?? null,
        };
        token = await this._captchaHandlerInstance(detailsToPass);
      } catch (e: any) {
        if (e instanceof CaptchaChallengeRequired) throw e; // Allow handler to raise this specifically
        throw new CaptchaChallengeRequired(`Captcha handler raised an unexpected exception: ${e?.message ?? e}`, challengeDetails);
      }
      if (typeof token === 'string' && token) return token;
      // Handler was called but didn't return a valid token
      throw new CaptchaChallengeRequired('Captcha handler ran but did not return a valid token string.', challengeDetails);
    }
    // No handler is configured
    throw new CaptchaChallengeRequired('No captcha handler is configured. Use client.setCaptchaHandler() to set one.', challengeDetails);
  }
}
