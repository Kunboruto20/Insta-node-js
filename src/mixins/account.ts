import { extractAccount, extractUserShort } from '../extractors';
import { Account, UserShort } from '../types';
import { genToken, generateSignature } from '../utils/auth';
import { dumps, pyJsonDumps } from '../utils/serialization';
import { pyAssert } from '../utils/validation';
import type { Client } from '../client';

export type ProfessionalAccountType = 2 | 3;
export const AIGM_UPDATE_ACCOUNT_LABEL_VISIBILITY_CLIENT_DOC_ID = '85502578717429613610069073956';

export interface ConvertProfessionalOptions {
  categoryId?: string | number;
  shouldShowCategory?: boolean;
  shouldShowPublicContacts?: boolean;
  entryPoint?: string;
  creatorDestinationMigration?: boolean;
  extraData?: Record<string, any> | null;
}

/** Helper class to manage your account */
export class AccountMixin {
  /**
   * Send a password reset link or code to the account email or phone.
   * identifier: username, email address, or phone number. recaptchaChallengeField: when Instagram asks for one.
   */
  async sendPasswordReset(this: Client, identifier: string, recaptchaChallengeField = ''): Promise<any> {
    const csrfToken = this.public.cookies.get('csrftoken') || genToken();
    return this.publicRequest('https://www.instagram.com/accounts/account_recovery_send_ajax/', {
      data: { email_or_username: identifier, recaptcha_challenge_field: recaptchaChallengeField },
      headers: { 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': csrfToken },
      returnJson: true,
      updateHeaders: false,
    });
  }

  /** Send a password reset link or code. Kept for backward compatibility; use sendPasswordReset. */
  async resetPassword(this: Client, username: string): Promise<any> {
    return this.sendPasswordReset(username);
  }

  /** Fetch your account info */
  async accountInfo(this: Client): Promise<Account> {
    const result = await this.privateRequest('accounts/current_user/?edit=true');
    return extractAccount(result.user);
  }

  /** Set the account-level AI-generated disclosure label. Returns the refreshed account. */
  async accountSetAiInfo(this: Client, enabled: boolean): Promise<Account> {
    const data = {
      method: 'post',
      format: 'json',
      server_timestamps: 'true',
      locale: 'user',
      fb_api_req_friendly_name: 'AIGMUpdateAccountLabelVisibilityMutation',
      enable_canonical_naming: 'true',
      enable_canonical_variable_overrides: 'true',
      enable_canonical_naming_ambiguous_type_prefixing: 'true',
      client_doc_id: AIGM_UPDATE_ACCOUNT_LABEL_VISIBILITY_CLIENT_DOC_ID,
      variables: JSON.stringify({ is_enabled: enabled }),
    };
    await this.privateGraphqlRequest(data, { 'X-Client-Doc-Id': AIGM_UPDATE_ACCOUNT_LABEL_VISIBILITY_CLIENT_DOC_ID });
    return this.accountInfo();
  }

  /**
   * Convert the current account to a professional account.
   * toAccountType: 2 is business and 3 is creator.
   */
  async accountConvertToProfessional(
    this: Client,
    toAccountType: ProfessionalAccountType = 3,
    opts: ConvertProfessionalOptions = {},
  ): Promise<Account> {
    const {
      categoryId = '2347428775505624',
      shouldShowCategory = true,
      shouldShowPublicContacts = false,
      entryPoint = 'setting',
      creatorDestinationMigration = false,
      extraData = null,
    } = opts;
    if (toAccountType !== 2 && toAccountType !== 3) throw new Error('to_account_type must be 2 (business) or 3 (creator)');
    const data: Record<string, any> = {
      entry_point: entryPoint,
      creator_destination_migration: this._accountBoolValue(creatorDestinationMigration),
      to_account_type: String(toAccountType),
      category_id: String(categoryId),
      should_show_category: this._accountBoolFlag(shouldShowCategory),
      should_show_public_contacts: this._accountBoolFlag(shouldShowPublicContacts),
    };
    Object.assign(data, extraData || {});
    await this.privateRequest('business/account/convert_account/', this.withDefaultData(data));
    return this.accountInfo();
  }

  /** Convert the current account to a business professional account. */
  async accountConvertToBusiness(this: Client, opts: ConvertProfessionalOptions = {}): Promise<Account> {
    return this.accountConvertToProfessional(2, opts);
  }

  /** Convert the current account to a creator professional account. */
  async accountConvertToCreator(this: Client, opts: ConvertProfessionalOptions = {}): Promise<Account> {
    return this.accountConvertToProfessional(3, opts);
  }

  _accountBoolFlag(this: Client, value: boolean): string {
    return value ? '1' : '0';
  }

  _accountBoolValue(this: Client, value: boolean): string {
    return value ? 'true' : 'false';
  }

  /** Change password */
  async changePassword(this: Client, oldPassword: string, newPassword: string): Promise<any> {
    try {
      const encOldPassword = await this.passwordEncrypt(oldPassword);
      const encNewPassword = await this.passwordEncrypt(newPassword);
      const data = { enc_old_password: encOldPassword, enc_new_password1: encNewPassword, enc_new_password2: encNewPassword };
      this.withActionData({ _uid: this.userIdInt, _uuid: this.uuid, _csrftoken: this.token });
      return await this.privateRequest('accounts/change_password/', data);
    } catch (e) {
      this.logger.exception(e);
      return false;
    }
  }

  async removeBioLinks(this: Client, linkIds: Array<number | string>): Promise<any> {
    const signedBody = { signed_body: 'SIGNATURE.' + pyJsonDumps({ _uid: this.userIdInt, _uuid: this.uuid, link_ids: linkIds }) };
    return this.privateRequest('accounts/remove_bio_links/', signedBody, { withSignature: false });
  }

  /** Set new external url (bio link) */
  async setExternalUrl(this: Client, externalUrl: string): Promise<any> {
    const data = dumps({
      updated_links: dumps([{ url: externalUrl, title: '', link_type: 'external' }]),
      _uid: this.userIdInt,
      _uuid: this.uuid,
    });
    return this.privateRequest('accounts/update_bio_links/', generateSignature(data), { withSignature: false });
  }

  /** Sets your account private */
  async accountSetPrivate(this: Client): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const data = this.withActionData({ _uid: String(this.userId), _uuid: this.uuid });
    const result = await this.privateRequest('accounts/set_private/', data);
    return result.status === 'ok';
  }

  /** Sets your account public */
  async accountSetPublic(this: Client): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const data = this.withActionData({ _uid: String(this.userId), _uuid: this.uuid });
    const result = await this.privateRequest('accounts/set_public/', data);
    return result.status === 'ok';
  }

  /**
   * Fetch your account security info (is_phone_confirmed, is_two_factor_enabled, is_totp_two_factor_enabled,
   * backup_codes, trusted_devices, totp_seeds, ...)
   */
  async accountSecurityInfo(this: Client): Promise<any> {
    return this.privateRequest('accounts/account_security_info/', this.withDefaultData({}));
  }

  /**
   * Edit your profile (authorized account).
   * Fields: external_url, username, full_name, biography, phone_number, email
   */
  async accountEdit(this: Client, data: Record<string, any>): Promise<Account> {
    const fields = ['external_url', 'username', 'full_name', 'biography', 'phone_number', 'email'];
    let payload: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([k]) => fields.includes(k)));
    if (!('email' in payload) || !('phone_number' in payload)) {
      // Instagram Error: You need an email or confirmed phone number.
      const userData: Record<string, any> = { ...(await this.accountInfo()) };
      const picked = Object.fromEntries(fields.map((f) => [f, userData[f]]));
      payload = { ...picked, ...payload };
    }
    const fullName = payload.full_name;
    delete payload.full_name;
    // Instagram original field-name for full user name is "first_name"
    if (fullName) payload.first_name = fullName;
    // Biography with entities (markup)
    const result = await this.privateRequest('accounts/edit_profile/', this.withDefaultData(payload));
    const biography = payload.biography;
    if (biography) await this.accountSetBiography(biography);
    return extractAccount(result.user);
  }

  /** Set biography with entities (markup) */
  async accountSetBiography(this: Client, biography: string): Promise<boolean> {
    const data = { logged_in_uids: dumps([String(this.userId)]), raw_text: biography };
    const result = await this.privateRequest('accounts/set_biography/', this.withDefaultData(data));
    return result.status === 'ok';
  }

  /** Change photo for your profile (authorized account) */
  async accountChangePicture(this: Client, path: string): Promise<UserShort> {
    const [uploadId] = await this.photoRupload(path);
    const result = await this.privateRequest(
      'accounts/change_profile_picture/',
      this.withDefaultData({ use_fbuploader: true, upload_id: uploadId }),
    );
    return extractUserShort(result.user);
  }

  /** Get old and new stories as is */
  async newsInboxV1(this: Client, markAsSeen = false): Promise<any> {
    return this.privateRequest('news/inbox/', null, { params: { mark_as_seen: markAsSeen } });
  }

  /** Send confirmation code to new email address */
  async sendConfirmEmail(this: Client, email: string): Promise<any> {
    return this.privateRequest('accounts/send_confirm_email/', this.withExtraData({ send_source: 'personal_information', email }));
  }

  /** Confirm new email address by code */
  async confirmEmail(this: Client, email: string, code: string): Promise<any> {
    return this.privateRequest('accounts/verify_email_code/', this.withExtraData({ email, code }));
  }

  /** Send confirmation code to new phone number */
  async sendConfirmPhoneNumber(this: Client, phoneNumber: string): Promise<any> {
    return this.privateRequest(
      'accounts/initiate_phone_number_confirmation/',
      this.withExtraData({ android_build_type: 'release', send_source: 'edit_profile', phone_number: phoneNumber }),
    );
  }

  /** Confirm new phone number by SMS code */
  async confirmPhoneNumber(this: Client, phoneNumber: string, code: string, hasSmsConsent = false): Promise<any> {
    const data: Record<string, any> = { phone_number: phoneNumber, verification_code: code };
    if (hasSmsConsent) data.has_sms_consent = 'true';
    return this.privateRequest('accounts/verify_sms_code/', this.withExtraData(data));
  }
}
