import { createHash } from 'node:crypto';
import {
  ChallengeError,
  ChallengeRedirection,
  ChallengeRequired,
  ChallengeSelfieCaptcha,
  ChallengeUnknownStep,
  LegacyForceSetNewPasswordForm,
  RecaptchaChallengeForm,
  SelectContactPointRecoveryForm,
  SubmitPhoneNumberForm,
} from '../core/errorClasses';
import { Session } from '../net/httpClient';
import { reprValue } from '../helpers/encoding';
import { randomInt, sleep } from '../helpers/delays';
import { ensure } from '../helpers/assertions';
import type { Client } from '../core/instaClient';

export const WAIT_SECONDS = 5;
export const BLOKS_REDIRECT_ACTION = 'com.bloks.www.ig.challenge.redirect.async';

export enum ChallengeChoice {
  SMS = 0,
  EMAIL = 1,
}

export function extractMessages(challenge: Record<string, any>): string[] {
  const messages: string[] = [];
  for (const item of challenge.extraData?.content ?? []) {
    const message = item.title ?? item.text;
    if (message) {
      const dot = String(message).endsWith('.') ? '' : '.';
      messages.push(`${message}${dot}`);
    }
  }
  return messages;
}

function withoutMessage(obj: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj || {})) if (k !== 'message') out[k] = v;
  return out;
}

/** Helpers for resolving login challenge */
export class ChallengeResolveFeature {
  _normalizeChallengeApiPath(this: Client, apiPath: string): string {
    if (apiPath.startsWith('/api/v1/')) return apiPath.slice('/api/v1'.length);
    if (apiPath.startsWith('/api/')) return apiPath.slice('/api'.length);
    return apiPath;
  }

  async challengeCodeOrRaised(this: Client, choice: ChallengeChoice, waitSeconds = 5, attempts = 24): Promise<string> {
    const errorContext = withoutMessage(this.lastJson);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const code = await this.challengeCodeHandler(this.username!, choice);
      if (code) {
        console.log(`Code entered "${code}" for ${this.username} (${attempt} attempts by ${waitSeconds} seconds)`);
        return code;
      }
      if (attempt === 0) {
        throw new ChallengeRequired(
          'Challenge code required. Provide it via challengeCodeHandler or retry login after saving client settings.',
          errorContext,
        );
      }
      await sleep(waitSeconds);
    }
    throw new ChallengeRequired('Challenge code was not provided before the retry window expired.', errorContext);
  }

  _challengeErrorContext(this: Client): Record<string, any> {
    return withoutMessage(this.lastJson);
  }

  _raiseBloksRedirectRequired(this: Client): never {
    throw new ChallengeRequired(
      'Manual verification required via Instagram Bloks redirect checkpoint. ' +
        'Please confirm the login in the official Instagram app or web flow on a trusted device, ' +
        'then retry with the same saved client settings, device identifiers, and proxy/IP.',
      this._challengeErrorContext(),
    );
  }

  async _challengeResolveChangePassword(this: Client): Promise<boolean> {
    const challengeContext = this.lastJson.challenge_context;
    if (!challengeContext) {
      throw new ChallengeRequired(
        'Password change required, but Instagram did not return a challenge context. Complete the flow manually.',
        this._challengeErrorContext(),
      );
    }
    const waitSeconds = 5;
    let pwd: string | null | undefined = null;
    let attempt = 0;
    for (attempt = 0; attempt < 24; attempt++) {
      pwd = await this.changePasswordHandler(this.username!);
      if (pwd) break;
      await sleep(waitSeconds);
    }
    if (!pwd) {
      throw new ChallengeRequired(
        'Password change required. Provide a new password via changePasswordHandler or complete the flow manually.',
        this._challengeErrorContext(),
      );
    }
    this.logger.info('New password (%d chars) entered for %s (%d attempts by %d seconds)', pwd.length, this.username, attempt, waitSeconds);
    return this.bloksChangePassword(pwd, challengeContext);
  }

  /**
   * Acknowledge a pending Bloks redirect checkpoint after manual approval.
   * Call this after approving the login in the official Instagram app while keeping the same client instance/settings alive.
   */
  async challengeBloksRedirectDismiss(this: Client): Promise<boolean> {
    if (this.lastJson.bloks_action !== BLOKS_REDIRECT_ACTION || !this.lastJson.challenge_context) {
      throw new ChallengeRequired(
        'No pending Bloks redirect challenge context found. ' +
          'Retry the original login/request first, then approve it in the official app.',
        this._challengeErrorContext(),
      );
    }
    const result = await this.bloksChallengeTakeChallenge(this.lastJson.challenge_context);
    if (result && typeof result === 'object' && !Array.isArray(result)) this.lastJson = result;
    if (this.lastJson.status !== 'ok') this._raiseBloksRedirectRequired();
    if (this.lastJson.action === 'close' || this.lastJson.type === 'CHALLENGE_REDIRECTION') return true;
    if (this.lastJson.bloks_action === BLOKS_REDIRECT_ACTION) this._raiseBloksRedirectRequired();
    return true;
  }

  /** Start challenge resolve */
  async challengeResolve(this: Client, lastJson: Record<string, any>): Promise<boolean> {
    // START GET REQUEST to challenge_url
    const challengeUrl = this._normalizeChallengeApiPath(lastJson.challenge.api_path);
    if (challengeUrl.startsWith('/auth_platform/')) {
      lastJson.message = 'Manual verification required via Instagram auth platform flow. This challenge is not yet supported automatically.';
      throw new ChallengeRequired({ ...lastJson });
    }
    if ((lastJson.challenge || {}).native_flow && challengeUrl.startsWith('/challenge/')) {
      const errorContext = { ...lastJson, message: 'challenge_required' };
      throw new ChallengeRequired(
        'Manual verification required via Instagram native challenge flow. ' +
          'This checkpoint is not handled by challengeCodeHandler or changePasswordHandler; ' +
          'complete it in the official Instagram app or web flow on a trusted device. ' +
          'Retry with the same saved client settings, device identifiers, and proxy/IP.',
        errorContext,
      );
    }
    let params: Record<string, any> = {};
    const parts = challengeUrl.split('/').slice(2, 4);
    if (parts.length === 2 && /^\s*[+-]?\d+\s*$/.test(parts[0])) {
      const [userId, nonceCode] = parts;
      let challengeContext = (lastJson.challenge || {}).challenge_context;
      if (!challengeContext) {
        challengeContext = `{"step_name": "", "nonce_code": ${JSON.stringify(nonceCode)}, "user_id": ${BigInt(userId.trim())}, "is_stateless": false}`;
      }
      params = { guid: this.uuid, device_id: this.androidDeviceId, challenge_context: challengeContext };
    } else {
      // not enough values to unpack (expected 2, got 1)
      params = {};
    }
    try {
      await this._sendPrivateRequest(challengeUrl.replace(/^\/+/, ''), null, { params });
    } catch (e) {
      if (e instanceof ChallengeRequired) {
        ensure(this.lastJson.message === 'challenge_required', reprValue(this.lastJson));
        return this.challengeResolveContactForm(challengeUrl);
      }
      throw e;
    }
    return this.challengeResolveSimple(challengeUrl);
  }

  /**
   * Start challenge resolve (web contact form)
   *
   * Help us make sure you own this account
   * > CODE
   * Is your profile information correct?
   * We have noticed suspicious activity on your account.
   * For security reasons, please let us know if your profile information is correct.
   * > I AGREE
   */
  async challengeResolveContactForm(this: Client, challengeUrl: string): Promise<boolean> {
    let result: any = this.lastJson;
    challengeUrl = `https://i.instagram.com${challengeUrl}`;
    // IG's web flow tags requests with an "instagram_ajax" fingerprint derived from a timestamp seed.
    // Despite the leading "#PWD_..." marker, this string contains no password — only the current epoch.
    const ajaxSeed = `#PWD_INSTAGRAM_BROWSER:0:${Math.trunc(Date.now() / 1000)}:`;
    const instagramAjax = createHash('sha256').update(ajaxSeed).digest('hex').slice(0, 12);
    const session = new Session();
    session.verify = this.tlsVerify;
    session.proxies = this.private.proxies;
    session.headers.update({
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 8.0.0; MI 5s Build/OPR1.170623.032; wv) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/80.0.3987.149 ' +
        `Mobile Safari/537.36 ${this.userAgent}`,
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'x-requested-with': 'com.instagram.android',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'accept-encoding': 'gzip, deflate',
      'accept-language': 'en-US,en;q=0.9,en-US;q=0.8,en;q=0.7',
      pragma: 'no-cache',
      'cache-control': 'no-cache',
    });
    for (const [key, value] of Object.entries(this.private.cookies.getDict())) {
      if (key === 'mid' || key === 'csrftoken') session.cookies.set(key, value);
    }
    await sleep(WAIT_SECONDS);
    await session.get(challengeUrl); // render html form
    session.headers.update({
      'x-ig-www-claim': '0',
      'x-instagram-ajax': instagramAjax,
      'content-type': 'application/x-www-form-urlencoded',
      accept: '*/*',
      'sec-fetch-dest': 'empty',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrftoken': session.cookies.getDict().csrftoken ?? null,
      'x-ig-app-id': this.private.headers.get('X-IG-App-ID') ?? null,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      referer: challengeUrl,
    });
    await sleep(WAIT_SECONDS);
    let choice = ChallengeChoice.EMAIL;
    result = (await session.post(challengeUrl, { data: { choice } })).json();
    for (let retry = 0; retry < 8; retry++) {
      await sleep(WAIT_SECONDS);
      try {
        // FORM TO ENTER CODE
        result = this.handleChallengeResult(result);
        break;
      } catch (e: any) {
        if (e instanceof SelectContactPointRecoveryForm) {
          if (choice === ChallengeChoice.SMS) throw e; // last iteration
          choice = ChallengeChoice.SMS;
          result = (await session.post(challengeUrl, { data: { choice } })).json();
          continue; // next choice attempt
        }
        if (e instanceof SubmitPhoneNumberForm) {
          result = (
            await session.post(challengeUrl, {
              data: { phone_number: e.challenge.fields.phone_number, challenge_context: e.challenge.challenge_context },
            })
          ).json();
          break;
        }
        if (e instanceof ChallengeRedirection) return true; // instagram redirect
        throw e;
      }
    }
    if (!['VerifyEmailCodeForm', 'VerifySMSCodeForm', 'VerifySMSCodeFormForSMSCaptcha'].includes(result.challengeType)) {
      throw new ChallengeError(`Unexpected contact-form challenge step after verification selection: ${reprValue(result)}`);
    }
    for (let retryCode = 0; retryCode < 5; retryCode++) {
      let code: string | null | undefined = null;
      for (let attempt = 1; attempt < 11; attempt++) {
        code = await this.challengeCodeHandler(this.username!, choice);
        if (code) break;
        await sleep(WAIT_SECONDS * attempt);
      }
      if (!code) {
        throw new ChallengeRequired(
          'Challenge code required to continue contact-form verification. ' +
            'Provide it via challengeCodeHandler or retry after manual verification.',
          withoutMessage(this.lastJson),
        );
      }
      // SEND CODE
      await sleep(WAIT_SECONDS);
      result = (await session.post(challengeUrl, { data: { security_code: code } })).json();
      result = result.challenge ?? result;
      if (!String((result.errors && result.errors.length ? result.errors : [''])[0]).includes('Please check the code we sent you and try again')) {
        break;
      }
    }
    // FORM TO APPROVE CONTACT DATA
    const challengeType = result.challengeType;
    if (challengeType === 'LegacyForceSetNewPasswordForm') this.challengeResolveNewPasswordForm(result);
    if (result.challengeType !== 'ReviewContactPointChangeForm') {
      throw new ChallengeError(`Unexpected contact-form challenge step after security code submission: ${reprValue(result)}`);
    }
    const details: string[] = [];
    const extraData = result.extraData || {};
    const content = extraData.content || [];
    for (const data of content) {
      for (const entry of data.labeled_list_entries ?? []) {
        let val = entry.list_item_text;
        if (!val) continue;
        if (!val.includes('@')) val = val.replace(/ /g, '').replace(/-/g, '');
        details.push(val);
      }
    }
    // CHECK ACCOUNT DATA
    for (const detail of [this.username, this.email, this.phoneNumber]) {
      if (detail && !details.includes(detail)) throw new ChallengeError(`ChallengeResolve: Data invalid: "${detail}" not in ${reprValue(details)}`);
    }
    const navigation = result.navigation || {};
    const forward = navigation.forward;
    if (!forward) throw new ChallengeError('Contact-form challenge response did not provide a forward navigation target.');
    await sleep(WAIT_SECONDS);
    result = (
      await session.post(`https://i.instagram.com${forward}`, {
        data: {
          choice: 0, // I AGREE
          enc_new_password1: ajaxSeed,
          new_password1: '',
          enc_new_password2: ajaxSeed,
          new_password2: '',
        },
      })
    ).json();
    if (result.type !== 'CHALLENGE_REDIRECTION' || result.status !== 'ok') {
      throw new ChallengeError(`Unexpected final response after contact-form approval: ${reprValue(result)}`);
    }
    return true;
  }

  challengeResolveNewPasswordForm(this: Client, result: Record<string, any>): never {
    const msg = ['Log into your Instagram account from smartphone and change password!', ...extractMessages(result)].join(' ');
    throw new LegacyForceSetNewPasswordForm(msg);
  }

  /** Handle challenge result */
  handleChallengeResult(this: Client, challenge: Record<string, any>): Record<string, any> {
    const messages: string[] = [];
    if ('challenge' in challenge) {
      // Sometimes there is nesting in JSON, instead of {challege_object} comes {"challenge": {challenge_object}}
      challenge = challenge.challenge;
      if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) {
        throw new ChallengeError('Malformed nested challenge payload received from Instagram.');
      }
    }
    const challengeType = challenge.challengeType;
    if (challengeType === 'SelectContactPointRecoveryForm') {
      // Help Us Confirm You Own This Account: To secure your account, you need to request help logging in.
      if ('extraData' in challenge) messages.push(...extractMessages(challenge));
      if ('errors' in challenge) for (const error of challenge.errors) messages.push(error);
      throw new SelectContactPointRecoveryForm(messages.join(' '), { challenge });
    } else if (challengeType === 'RecaptchaChallengeForm') {
      throw new RecaptchaChallengeForm((challenge.errors ?? []).join('. '));
    } else if (['VerifyEmailCodeForm', 'VerifySMSCodeForm', 'VerifySMSCodeFormForSMSCaptcha'].includes(challengeType)) {
      // Success. Next step
      return challenge;
    } else if (challengeType === 'SubmitPhoneNumberForm') {
      throw new SubmitPhoneNumberForm({ challenge });
    } else if (challengeType) {
      // Unknown challenge_type
      messages.push(`Unsupported challenge type: ${challengeType}.`);
      if (challenge.extraData) messages.push(...extractMessages(challenge));
      if ('errors' in challenge) messages.push(challenge.errors.join('\n'));
      messages.push('(Please manual login)');
      throw new ChallengeError(messages.join(' '));
    } else if (challenge.type === 'CHALLENGE_REDIRECTION') {
      // Example: {'location': 'instagram://checkpoint/dismiss', 'status': 'ok', 'type': 'CHALLENGE_REDIRECTION'}
      throw new ChallengeRedirection();
    }
    return challenge;
  }

  /** Old type (through private api) challenge resolver */
  async challengeResolveSimple(this: Client, challengeUrl: string): Promise<boolean> {
    const stepName = this.lastJson.step_name ?? '';
    if (['delta_login_review', 'delta_acknowledge_approved', 'scraping_warning'].includes(stepName)) {
      // IT WAS ME (by GEO)
      await this._sendPrivateRequest(challengeUrl, { choice: '0' });
      return true;
    } else if (stepName === 'add_birthday') {
      await this._sendPrivateRequest(challengeUrl, {
        birthday_year: String(randomInt(1970, 2004)),
        birthday_month: String(randomInt(1, 12)),
        birthday_day: String(randomInt(1, 28)),
      });
      return true;
    } else if (
      ['verify_email', 'verify_email_code', 'verify_phone', 'verify_phone_code', 'verify_sms', 'verify_sms_code', 'select_verify_method'].includes(
        stepName,
      )
    ) {
      let choice = stepName.includes('phone') || stepName.includes('sms') ? ChallengeChoice.SMS : ChallengeChoice.EMAIL;
      if (stepName === 'select_verify_method') {
        // {'step_name': 'select_verify_method', 'step_data': {'choice': '0', ..., 'phone_number': '+7 *** ***-**-09',
        //  'email': 'x****g@y*****.com'}, 'nonce_code': 'DrW8V4m5Ec', 'user_id': 12060121299, 'status': 'ok'}
        const steps = Object.keys(this.lastJson.step_data);
        challengeUrl = challengeUrl.slice(1);
        if (steps.includes('email')) {
          choice = ChallengeChoice.EMAIL;
          await this._sendPrivateRequest(challengeUrl, { choice: String(choice) });
        } else if (steps.includes('phone_number')) {
          choice = ChallengeChoice.SMS;
          await this._sendPrivateRequest(challengeUrl, { choice: String(choice) });
        } else {
          throw new ChallengeError(
            `ChallengeResolve: Choice "email" or "phone_number" (sms) not available to this account ${reprValue(this.lastJson)}`,
          );
        }
      }
      const code = await this.challengeCodeOrRaised(choice, 5, 24);
      await this._sendPrivateRequest(challengeUrl, { security_code: code });
      // assert 'logged_in_user' in client.last_json
      ensure((this.lastJson.action ?? '') === 'close');
      ensure((this.lastJson.status ?? '') === 'ok');
      return true;
    } else if (stepName === 'submit_phone') {
      const phoneNumber = this.phoneNumber;
      if (!phoneNumber) {
        throw new ChallengeRequired(
          'Phone number required to continue submit_phone challenge. Set client.phoneNumber or complete the flow manually.',
          withoutMessage(this.lastJson),
        );
      }
      await this._sendPrivateRequest(challengeUrl, { phone_number: phoneNumber });
      if (this.lastJson.step_name === stepName) {
        throw new ChallengeError(`submit_phone challenge did not advance after phone submission: ${reprValue(this.lastJson)}`);
      }
      return this.challengeResolveSimple(challengeUrl);
    } else if (this.lastJson.bloks_action === BLOKS_REDIRECT_ACTION) {
      if (this.lastJson.challenge_type_enum_str === 'PASSWORD_RESET') return this._challengeResolveChangePassword();
      const challengeContext = this.lastJson.challenge_context;
      if (!challengeContext) this._raiseBloksRedirectRequired();
      const result = await this.bloksChallengeTakeChallenge(challengeContext, 0);
      if (result && typeof result === 'object' && !Array.isArray(result)) this.lastJson = result;
      if (this.lastJson.status !== 'ok') this._raiseBloksRedirectRequired();
      if (this.lastJson.action === 'close' || this.lastJson.type === 'CHALLENGE_REDIRECTION') return true;
      if (this.lastJson.bloks_action === BLOKS_REDIRECT_ACTION) this._raiseBloksRedirectRequired();
      if (this.lastJson.step_name) return this.challengeResolveSimple(challengeUrl);
      return true;
    } else if (stepName === '') {
      ensure((this.lastJson.action ?? '') === 'close');
      ensure((this.lastJson.status ?? '') === 'ok');
      return true;
    } else if (stepName === 'change_password') {
      // Example: {'step_name': 'change_password', 'step_data': {'new_password1': 'None', 'new_password2': 'None'},
      //  'flow_render_type': 3, 'bloks_action': 'com.instagram.challenge.navigation.take_challenge', ...,
      //  'challenge_type_enum_str': 'PASSWORD_RESET', 'status': 'ok'}
      return this._challengeResolveChangePassword();
    } else if (stepName === 'ufac_www_bloks') {
      throw new ChallengeRequired(
        'Manual verification required via Instagram UFAC web bloks checkpoint. Please resolve it in the Instagram app or web flow and then retry.',
        withoutMessage(this.lastJson),
      );
    } else if (stepName === 'selfie_captcha') {
      throw new ChallengeSelfieCaptcha(reprValue(this.lastJson));
    } else if (stepName === 'select_contact_point_recovery') {
      // {'step_name': 'select_contact_point_recovery', 'step_data': {'choice': '0', 'phone_number': '+62 ***-****-**11',
      //  'email': 'g*******b@w**.de', ...}, 'challenge_type_enum_str': 'HACKED_LOCK', 'status': 'ok'}
      const steps = Object.keys(this.lastJson.step_data);
      challengeUrl = challengeUrl.slice(1);
      let choice = ChallengeChoice.EMAIL;
      if (steps.includes('email')) {
        choice = ChallengeChoice.EMAIL;
        await this._sendPrivateRequest(challengeUrl, { choice: String(choice) });
      } else if (steps.includes('phone_number')) {
        choice = ChallengeChoice.SMS;
        await this._sendPrivateRequest(challengeUrl, { choice: String(choice) });
      } else {
        throw new ChallengeError(
          `ChallengeResolve: Choice "email" or "phone_number" (sms) not available to this account ${reprValue(this.lastJson)}`,
        );
      }
      const code = await this.challengeCodeOrRaised(choice, 5, 24);
      await this._sendPrivateRequest(challengeUrl, { security_code: code });
      if ((this.lastJson.action ?? '') === 'close') {
        ensure((this.lastJson.status ?? '') === 'ok');
        return true;
      }
      // last form to verify account details
      if (this.lastJson.step_name !== 'review_contact_point_change') {
        throw new ChallengeError(`Unexpected final challenge step after contact point recovery: ${this.lastJson.step_name}`);
      }
      // TODO: add validation of account details
      // "choice": 0 ==> details look good
      await this._sendPrivateRequest(challengeUrl, { choice: 0 });
      // TODO: assert that the user is now logged in.
      return true;
    } else {
      throw new ChallengeUnknownStep(
        `ChallengeResolve: Unknown step_name "${stepName}" for "${this.username}" in challenge resolver: ${reprValue(this.lastJson)}`,
      );
    }
  }
}
