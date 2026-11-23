import { randomUUID } from 'node:crypto';
import { ChallengeError, ClientError } from '../exceptions';
import { rawDecode, simpleCookieLoad } from '../utils/json';
import { dumps } from '../utils/serialization';
import { pyAssert } from '../utils/validation';
import { ChallengeChoice } from './challenge';
import type { Client } from '../client';

export const CAA_API_DOMAIN = 'b.i.instagram.com';
export const AP_2SV_ENTRYPOINT = 'com.bloks.www.ap.two_step_verification.entrypoint_async';
export const AP_2SV_CODE_ENTRY = 'com.bloks.www.ap.two_step_verification.code_entry';
export const AP_2SV_CODE_ENTRY_ASYNC = 'com.bloks.www.ap.two_step_verification.code_entry_async';

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function truthy(v: any): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}

export class BloksMixin {
  _bloksPayload(this: Client, params: Record<string, any>, bloksVersioningId = ''): Record<string, string> {
    const versioningId = bloksVersioningId || this.bloksVersioningId;
    pyAssert(versioningId, 'Client.bloks_versioning_id is empty (hash is expected)');
    return {
      params: dumps(params),
      _uuid: this.uuid,
      bk_client_context: dumps({ bloks_version: versioningId, styles_id: 'instagram' }),
      bloks_versioning_id: versioningId,
    };
  }

  /**
   * Perform a raw Bloks async action, e.g. "com.bloks.www.fxcal.link.async".
   * login: send the request without the normal post-login delay.
   */
  async bloksAsyncAction(
    this: Client,
    action: string,
    params: Record<string, any>,
    bloksVersioningId = '',
    domain: string | null = null,
    extraHeaders: Record<string, string> | null = null,
    login = false,
  ): Promise<any> {
    const data = this._bloksPayload(params, bloksVersioningId);
    const headers: Record<string, string> = { 'X-FB-Friendly-Name': `IgApi: bloks/async_action/${action}/` };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    return this.privateRequest(`bloks/async_action/${action}/`, data, {
      withSignature: false,
      headers,
      ...(domain ? { domain } : {}),
      ...(login ? { login: true } : {}),
    });
  }

  /** Perform a raw Bloks app request, e.g. "com.bloks.www.two_step_verification.entrypoint". */
  async bloksApp(this: Client, app: string, params: Record<string, any>, bloksVersioningId = '', domain: string | null = null, login = false): Promise<any> {
    const data = this._bloksPayload(params, bloksVersioningId);
    return this.privateRequest(`bloks/apps/${app}/`, data, {
      withSignature: false,
      ...(domain ? { domain } : {}),
      ...(login ? { login: true } : {}),
    });
  }

  /**
   * Perform a Bloks app request through the mobile graphql_www endpoint.
   * Current CAA registration screens use this wrapper instead of bloks/apps for most steps.
   * Instagram expects params to be nested as a JSON string inside another JSON string.
   */
  async bloksGraphqlApp(
    this: Client,
    app: string,
    params: Record<string, any>,
    clientDocId: string,
    bloksVersioningId = '',
    domain = 'b.i.instagram.com',
    infraDeviceId = '',
  ): Promise<any> {
    const versioningId = bloksVersioningId || this.bloksVersioningId;
    pyAssert(versioningId, 'Client.bloks_versioning_id is empty (hash is expected)');
    const variables = {
      params: {
        params: dumps({ params: dumps(params) }),
        bloks_versioning_id: versioningId,
        infra_params: { device_id: infraDeviceId || this.uuid },
        app_id: app,
      },
      bk_context: { is_flipper_enabled: false, theme_params: [], debug_tooling_metadata_token: null },
    };
    return this.privateGraphqlWwwRequest(`IGBloksAppRootQuery-${app}`, variables, clientDocId, domain);
  }

  /**
   * Submit a challenge-navigation Bloks request.
   * Instagram may return challenge_context as an opaque string instead of JSON. Pass it through unchanged.
   */
  async bloksChallengeTakeChallenge(
    this: Client,
    challengeContext: string | null = '',
    choice: number | null = null,
    hasFollowUpScreens = 0,
    extraData: Record<string, any> | null = null,
    bloksVersioningId = '',
  ): Promise<any> {
    const versioningId = bloksVersioningId || this.bloksVersioningId;
    pyAssert(versioningId, 'Client.bloks_versioning_id is empty (hash is expected)');
    const data: Record<string, any> = {
      _uuid: this.uuid,
      has_follow_up_screens: String(hasFollowUpScreens),
      bk_client_context: dumps({ bloks_version: versioningId, styles_id: 'instagram' }),
      bloks_versioning_id: versioningId,
    };
    if (challengeContext !== null && challengeContext !== undefined) data.challenge_context = challengeContext;
    if (choice !== null && choice !== undefined) data.choice = String(choice);
    if (extraData) Object.assign(data, extraData);
    return this.privateRequest('bloks/apps/com.instagram.challenge.navigation.take_challenge/', data, { withSignature: false });
  }

  /**
   * Start the Account Center link flow used by Reel Facebook sharing.
   * This exposes the raw app surface; it does not guarantee that Facebook linking can be completed
   * without the interactive Instagram app UI and native authentication context.
   */
  async bloksFxcalLinkReelsShare(
    this: Client,
    flow = 'ig_fb_reels_composer_rowshare',
    loggingEvent = 'linking_flow_initiated',
    cdsClientValue = 1,
    opaqueVerifiedNativeAuthData: string | null = null,
    nativeAuthData: Record<string, any>[] | null = null,
    accountType = 0,
    bloksVersioningId = '',
  ): Promise<any> {
    const params = {
      server_params: {
        flow,
        logging_event: loggingEvent,
        cds_client_value: cdsClientValue,
        opaque_verified_native_auth_data: opaqueVerifiedNativeAuthData,
        native_auth_data: nativeAuthData || [],
        account_type: accountType,
      },
    };
    return this.bloksAsyncAction('com.bloks.www.fxcal.link.async', params, bloksVersioningId);
  }

  /**
   * Open the current Bloks two-step verification entrypoint (requires a two_step_verification_context
   * returned by Instagram during login).
   */
  async bloksTwoStepVerificationEntrypoint(
    this: Client,
    twoStepVerificationContext: string,
    flowSource = 'two_factor_login',
    shouldFallbackToSms = false,
    screenId: string | null = null,
    bloksVersioningId = '',
  ): Promise<any> {
    const serverParams: Record<string, any> = {
      should_fallback_to_sms: Number(shouldFallbackToSms),
      family_device_id: this.phoneId,
      device_id: this.androidDeviceId,
      two_step_verification_context: twoStepVerificationContext,
      flow_source: flowSource,
    };
    if (screenId) serverParams.INTERNAL_INFRA_screen_id = screenId;
    const params = {
      client_input_params: { device_id: this.androidDeviceId, is_whatsapp_installed: 0, machine_id: this.mid },
      server_params: serverParams,
    };
    return this.bloksApp('com.bloks.www.two_step_verification.entrypoint', params, bloksVersioningId);
  }

  /** Open the Bloks two-step verification method picker. */
  async bloksTwoStepVerificationMethodPicker(
    this: Client,
    twoStepVerificationContext: string,
    flowSource = 'two_factor_login',
    shouldFallbackToSms = false,
    screenId: string | null = null,
    bloksVersioningId = '',
  ): Promise<any> {
    const serverParams: Record<string, any> = {
      should_fallback_to_sms: Number(shouldFallbackToSms),
      device_id: this.androidDeviceId,
      two_step_verification_context: twoStepVerificationContext,
      flow_source: flowSource,
    };
    if (screenId) serverParams.INTERNAL_INFRA_screen_id = screenId;
    const params = { client_input_params: { is_whatsapp_installed: 0 }, server_params: serverParams };
    return this.bloksApp('com.bloks.www.two_step_verification.method_picker', params, bloksVersioningId);
  }

  /** Select a two-step verification method such as "totp" or "sms". */
  async bloksTwoStepVerificationSelectMethod(
    this: Client,
    twoStepVerificationContext: string,
    selectedMethod: string,
    flowSource = 'two_factor_login',
    shouldFallbackToSms = false,
    latencyQplMarkerId: number | null = null,
    latencyQplInstanceId: number | null = null,
    bloksVersioningId = '',
  ): Promise<any> {
    const serverParams: Record<string, any> = {
      should_fallback_to_sms: Number(shouldFallbackToSms),
      device_id: this.androidDeviceId,
      spectra_reg_login_data: null,
      two_step_verification_context: twoStepVerificationContext,
      flow_source: flowSource,
    };
    if (latencyQplMarkerId !== null) serverParams.INTERNAL__latency_qpl_marker_id = latencyQplMarkerId;
    if (latencyQplInstanceId !== null) serverParams.INTERNAL__latency_qpl_instance_id = latencyQplInstanceId;
    const params = {
      client_input_params: {
        selected_method: selectedMethod,
        // Instagram payload field name, not a secret value.
        cloud_trust_token: null,
        network_bssid: null,
      },
      server_params: serverParams,
    };
    return this.bloksAsyncAction('com.bloks.www.two_step_verification.method_picker.navigation.async', params, bloksVersioningId);
  }

  /** Open the Bloks TOTP code entry app. */
  async bloksTwoStepVerificationEnterTotpCode(
    this: Client,
    twoStepVerificationContext: string,
    flowSource = 'two_factor_login',
    screenId: string | null = null,
    bloksVersioningId = '',
  ): Promise<any> {
    const serverParams: Record<string, any> = {
      device_id: this.androidDeviceId,
      two_step_verification_context: twoStepVerificationContext,
      flow_source: flowSource,
    };
    if (screenId) serverParams.INTERNAL_INFRA_screen_id = screenId;
    return this.bloksApp('com.bloks.www.two_factor_login.enter_totp_code', { server_params: serverParams }, bloksVersioningId);
  }

  /** Open the Bloks backup-code entry app. */
  async bloksTwoStepVerificationEnterBackupCode(
    this: Client,
    twoStepVerificationContext: string,
    flowSource = 'two_factor_login',
    screenId: string | null = null,
    bloksVersioningId = '',
  ): Promise<any> {
    const serverParams: Record<string, any> = {
      device_id: this.androidDeviceId,
      two_step_verification_context: twoStepVerificationContext,
      flow_source: flowSource,
    };
    if (screenId) serverParams.INTERNAL_INFRA_screen_id = screenId;
    return this.bloksApp('com.bloks.www.two_factor_login.enter_backup_code', { server_params: serverParams }, bloksVersioningId);
  }

  /**
   * Verify a Bloks two-step verification code. challenge is the selected method name ("totp" or "sms").
   * The raw response may contain an embedded login payload; parse it with bloksExtractLoginResponse.
   */
  async bloksTwoStepVerificationVerifyCode(
    this: Client,
    twoStepVerificationContext: string,
    code: string,
    challenge = 'totp',
    flowSource = 'two_factor_login',
    shouldTrustDevice = true,
    shouldFallbackToSms = false,
    authSecureDeviceId = '',
    blockStoreMachineId = '',
    latencyQplMarkerId: number | null = null,
    latencyQplInstanceId: number | null = null,
    bloksVersioningId = '',
  ): Promise<any> {
    const serverParams: Record<string, any> = {
      should_fallback_to_sms: Number(shouldFallbackToSms),
      device_id: this.androidDeviceId,
      spectra_reg_login_data: null,
      challenge,
      two_step_verification_context: twoStepVerificationContext,
      flow_source: flowSource,
    };
    if (latencyQplMarkerId !== null) serverParams.INTERNAL__latency_qpl_marker_id = latencyQplMarkerId;
    if (latencyQplInstanceId !== null) serverParams.INTERNAL__latency_qpl_instance_id = latencyQplInstanceId;
    const params = {
      client_input_params: {
        auth_secure_device_id: authSecureDeviceId,
        block_store_machine_id: blockStoreMachineId,
        code,
        should_trust_device: Number(shouldTrustDevice),
        family_device_id: this.phoneId,
        device_id: this.androidDeviceId,
        // Instagram payload field name, not a secret value.
        cloud_trust_token: null,
        network_bssid: null,
        machine_id: this.mid,
      },
      server_params: serverParams,
    };
    return this.bloksAsyncAction('com.bloks.www.two_step_verification.verify_code.async', params, bloksVersioningId);
  }

  _caaDeviceNetworkInfo(this: Client): Record<string, any> {
    return {
      active_subscriptions_info: null,
      default_subscription_info: {
        network_type: null,
        is_data_roaming: 1,
        is_esim: null,
        is_gsm_roaming: 0,
        is_sim_sms_capable: null,
        is_mobile_data_enabled: 1,
        sim_carrier_id: 1,
        sim_carrier_id_name: null,
        sim_state: 5,
        sim_operator: '310260',
        sim_operator_name: 'T-Mobile',
        signal_strength: null,
        group_id_level_1: null,
        network_operator: '310260',
      },
      is_airplane_mode: 0,
      is_active_network_cellular: 0,
      is_device_sms_capable: 1,
      sim_count: 1,
      is_wifi: 1,
    };
  }

  /** Extract the server-issued CAA account access context. */
  bloksExtractAac(this: Client, result: Record<string, any>): string {
    const data = result?.layout?.bloks_payload?.data ?? [];
    if (!Array.isArray(data)) return '';
    for (const node of data) {
      const payload = isDict(node) ? node.data : null;
      if (!isDict(payload) || payload.key !== 'CAA_ACCOUNT_ACCESS_CONTEXT:aac') continue;
      const initial = payload.initial;
      if (typeof initial === 'string' && initial.trim()) return initial;
      const lispy = payload.initial_lispy;
      if (typeof lispy === 'string' && lispy) {
        const value = this._extractFirstJsonString(lispy, 0);
        if (value) return value;
      }
    }
    return '';
  }

  /** Open the CAA login homepage and retain its server-issued aac. */
  async bloksCaaLoginProcessClientData(
    this: Client,
    waterfallId = '',
    offlineExperimentGroup = 'caa_iteration_v3_perf_ig_4',
    bloksVersioningId = '',
    domain: string | null = null,
  ): Promise<any> {
    this.caaWaterfallId = waterfallId || randomUUID();
    this.caaAac = '';
    const params = {
      is_from_logged_out: false,
      logged_out_user: '',
      qpl_join_id: null,
      family_device_id: this.phoneId,
      device_id: this.androidDeviceId,
      offline_experiment_group: offlineExperimentGroup,
      waterfall_id: this.caaWaterfallId,
      logout_source: '',
      show_internal_settings: false,
      last_auto_login_time: 0,
      disable_auto_login: false,
      qe_device_id: this.uuid,
      use_auto_login_interstitial: true,
      disable_recursive_auto_login_interstitial: true,
      auto_login_interstitial_experiment_group_name: '',
      is_from_logged_in_switcher: false,
      switcher_logged_in_uid: '',
      account_list: [],
      blocked_uid: [],
      INTERNAL_INFRA_THEME: 'THREE_NEUTRAL_GRAY',
      layered_homepage_experiment_group: 'Deploy: Not in Experiment',
      launched_url: '',
      sim_phone_numbers: [],
      is_from_registration_reminder: false,
    };
    const result = await this.bloksAsyncAction(
      'com.bloks.www.bloks.caa.login.process_client_data_and_redirect',
      params,
      bloksVersioningId,
      domain,
      null,
      true,
    );
    this.caaAac = this.bloksExtractAac(result);
    return result;
  }

  /** Perform the CAA OAuth token preflight sent before credentials. */
  async bloksCaaLoginOauthTokenFetch(
    this: Client,
    username = '',
    waterfallId = '',
    offlineExperimentGroup = 'caa_iteration_v3_perf_ig_4',
    bloksVersioningId = '',
    domain: string | null = null,
  ): Promise<any> {
    this.caaWaterfallId = waterfallId || this.caaWaterfallId || randomUUID();
    const params = {
      client_input_params: {
        username_input: username || this.username,
        si_device_param_network_info: this._caaDeviceNetworkInfo(),
        aac: this.caaAac,
        lois_settings: { lois_token: '' },
        cloud_trust_token: null,
        zero_balance_state: '',
        network_bssid: null,
      },
      server_params: {
        is_from_logged_out: 0,
        layered_homepage_experiment_group: 'Deploy: Not in Experiment',
        device_id: this.androidDeviceId,
        login_surface: 'login_home',
        waterfall_id: this.caaWaterfallId,
        INTERNAL__latency_qpl_instance_id: Date.now(),
        is_platform_login: 0,
        login_entry_point: 'logged_out',
        INTERNAL__latency_qpl_marker_id: 36707139,
        family_device_id: this.phoneId,
        offline_experiment_group: offlineExperimentGroup,
        access_flow_version: 'pre_mt_behavior',
        is_from_logged_in_switcher: 0,
        qe_device_id: this.uuid,
      },
    };
    return this.bloksAsyncAction('com.bloks.www.caa.login.oauth.token.fetch.async', params, bloksVersioningId, domain, null, true);
  }

  /** Run the ordered device and CAA preflight needed before login. */
  async bloksCaaLoginPrepare(
    this: Client,
    username = '',
    domain: string | null = null,
    waterfallId = '',
    offlineExperimentGroup = 'caa_iteration_v3_perf_ig_4',
    bloksVersioningId = '',
  ): Promise<boolean> {
    if (!this.usdidRegistered && !(await this.usdidRegister())) return false;
    await this.bloksCaaLoginProcessClientData(waterfallId, offlineExperimentGroup, bloksVersioningId, domain);
    this.attestationChallengeNonce = '';
    this.attestationKeyNonce = '';
    await this.attestationCreateAndroidKeystore('', domain);
    if (this.caaAac) await this.bloksCaaLoginOauthTokenFetch(username, waterfallId, offlineExperimentGroup, bloksVersioningId, domain);
    return Boolean(this.caaAac && this.attestationChallengeNonce);
  }

  /**
   * Send the current CAA/Bloks login request used before Bloks 2FA.
   * When needed, obtains the server-issued account access context through bloksCaaLoginPrepare before
   * encrypting the password. Set autoPrepare=false to require pre-existing state.
   */
  async bloksCaaLoginSendRequest(
    this: Client,
    password: string,
    opts: {
      username?: string;
      loginAttemptCount?: number;
      tryNum?: number;
      waterfallId?: string;
      offlineExperimentGroup?: string;
      bloksVersioningId?: string;
      domain?: string | null;
      autoPrepare?: boolean;
    } = {},
  ): Promise<any> {
    const {
      username = '',
      loginAttemptCount = 1,
      tryNum = 1,
      waterfallId = '',
      offlineExperimentGroup = 'caa_iteration_v3_perf_ig_4',
      bloksVersioningId = '',
      domain = null,
      autoPrepare = true,
    } = opts;
    const contactPoint = username || this.username;
    if (autoPrepare && !this.caaAac) {
      const preflightState = [this.caaAac, this.caaWaterfallId, this.attestationChallengeNonce, this.attestationKeyNonce] as const;
      try {
        await this.bloksCaaLoginPrepare(contactPoint || '', domain, waterfallId, offlineExperimentGroup, bloksVersioningId);
      } catch (e) {
        [this.caaAac, this.caaWaterfallId, this.attestationChallengeNonce, this.attestationKeyNonce] = preflightState;
        throw e;
      }
    }
    if (!this.caaAac) {
      throw new ClientError('CAA login requires a server-issued aac; call bloksCaaLoginPrepare() before send_login_request');
    }
    const encryptedPassword = password.startsWith('#PWD_') ? password : await this.passwordEncrypt(password);
    const flowId = waterfallId || this.caaWaterfallId || randomUUID();
    this.caaWaterfallId = flowId;
    // Recent CAA login screens emit short base36-like input ids. Hex-only
    // UUID prefixes are accepted by the VM but can return a null-payload 404.
    const textInputId = `${randomUUID().replace(/-/g, '').slice(0, 4)}ig`;
    const params = {
      client_input_params: {
        blocked_uids: [],
        aac: this.caaAac,
        sim_phones: [],
        aymh_accounts: [],
        network_bssid: null,
        secure_family_device_id: '',
        has_granted_read_contacts_permissions: 0,
        auth_secure_device_id: '',
        has_whatsapp_installed: 0,
        si_device_param_network_info: this._caaDeviceNetworkInfo(),
        password: encryptedPassword,
        sso_token_map_json_string: '',
        block_store_machine_id: '',
        ig_vetted_device_nonces: null,
        cloud_trust_token: null,
        event_flow: 'login_manual',
        password_contains_non_ascii: String(!isAscii(password)).toLowerCase(),
        client_known_key_hash: '',
        sso_accounts_auth_data: [],
        encrypted_msisdn: '',
        has_granted_read_phone_permissions: 0,
        app_manager_id: '',
        should_show_nested_nta_from_aymh: 0,
        device_id: this.androidDeviceId,
        zero_balance_state: '',
        login_attempt_count: loginAttemptCount,
        machine_id: this.mid,
        flash_call_permission_status: { READ_PHONE_STATE: 'DENIED', READ_CALL_LOG: 'DENIED', ANSWER_PHONE_CALLS: 'DENIED' },
        accounts_list: [],
        gms_incoming_call_retriever_eligibility: 'eligible',
        family_device_id: this.phoneId,
        fb_ig_device_id: [],
        device_emails: [],
        try_num: tryNum,
        lois_settings: { lois_token: '' },
        event_step: 'home_page',
        headers_infra_flow_id: '',
        openid_tokens: {},
        contact_point: contactPoint,
      },
      server_params: {
        should_trigger_override_login_2fa_action: 0,
        is_from_logged_out: 0,
        should_trigger_override_login_success_action: 0,
        login_credential_type: 'none',
        server_login_source: 'login',
        waterfall_id: flowId,
        two_step_login_type: 'one_step_login',
        login_source: 'Login',
        is_platform_login: 0,
        login_entry_point: 'logged_out',
        INTERNAL__latency_qpl_marker_id: 36707139,
        is_from_aymh: 0,
        offline_experiment_group: offlineExperimentGroup,
        is_from_landing_page: 0,
        left_nav_button_action: 'NONE',
        password_text_input_id: `${textInputId}:82`,
        is_from_empty_password: 0,
        is_from_msplit_fallback: 0,
        ar_event_source: 'login_home_page',
        qe_device_id: this.uuid,
        username_text_input_id: `${textInputId}:81`,
        layered_homepage_experiment_group: 'Deploy: Not in Experiment',
        device_id: this.androidDeviceId,
        login_surface: 'login_home',
        INTERNAL__latency_qpl_instance_id: Date.now(),
        reg_flow_source: 'login_home_native_integration_point',
        is_caa_perf_enabled: 1,
        credential_type: 'password',
        is_from_password_entry_page: 0,
        caller: 'gslr',
        family_device_id: this.phoneId,
        is_from_assistive_id: 0,
        access_flow_version: 'pre_mt_behavior',
        is_from_logged_in_switcher: 0,
      },
    };
    const attestParams = this.attestationParams();
    return this.bloksAsyncAction(
      'com.bloks.www.bloks.caa.login.async.send_login_request',
      params,
      bloksVersioningId,
      domain,
      attestParams ? { 'X-IG-Attest-Params': attestParams } : null,
      true,
    );
  }

  /** Run current Android CAA login, including its profile-code challenge. */
  async bloksCaaLogin(
    this: Client,
    verificationCode = '',
    opts: { username?: string; password?: string | null; prepare?: boolean; domain?: string } = {},
  ): Promise<Record<string, any>> {
    const username = opts.username || this.username || '';
    const password = opts.password || this.password || '';
    const prepare = opts.prepare ?? true;
    const domain = opts.domain ?? CAA_API_DOMAIN;
    if (prepare && !(await this.bloksCaaLoginPrepare(username, domain))) {
      return {
        logged_in: false,
        two_step_verification_context: '',
        result: {},
        two_step: {},
        reason: 'CAA preflight did not return account access and attestation data',
      };
    }
    const result = await this.bloksCaaLoginSendRequest(password, { username, domain, autoPrepare: prepare });
    let loggedIn = this.bloksApplyLoginResponse(result);
    let twoStep: Record<string, any> = {};
    if (!loggedIn && this.bloksCaaLoginNeedsTwoStep(result)) {
      twoStep = await this.bloksCaaResolveTwoStepVerification(result, verificationCode, domain);
      loggedIn = Boolean(twoStep.logged_in);
    }
    const context = loggedIn ? '' : this.bloksExtractTwoStepVerificationContext(result);
    return {
      logged_in: loggedIn,
      two_step_verification_context: context,
      result,
      two_step: twoStep,
      reason: loggedIn ? '' : String(twoStep.reason || 'CAA login did not return a session'),
    };
  }

  _bloksCollectStrings(this: Client, value: any, output: string[]): void {
    if (typeof value === 'string') output.push(value);
    else if (isDict(value)) for (const child of Object.values(value)) this._bloksCollectStrings(child, output);
    else if (Array.isArray(value)) for (const child of value) this._bloksCollectStrings(child, output);
  }

  _bloksAllText(this: Client, result: any): string {
    const strings: string[] = [];
    this._bloksCollectStrings(result, strings);
    return strings.join('\n');
  }

  /** Return whether CAA routed login to the profile-code challenge. */
  bloksCaaLoginNeedsTwoStep(this: Client, result: any): boolean {
    return this._bloksAllText(result).includes(AP_2SV_ENTRYPOINT);
  }

  /** Return one balanced Bloks expression while respecting quoted strings. */
  _bloksParenthesizedExpression(this: Client, value: string, start: number): string {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index++) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) return value.slice(start, index + 1);
      }
    }
    return '';
  }

  /** Read direct operands without flattening nested expressions or scalars. */
  _bloksExpressionItems(this: Client, value: string): string[] {
    if (!value.startsWith('(') || !value.endsWith(')')) return [];
    const items: string[] = [];
    let index = 1;
    while (index < value.length - 1) {
      if (/\s/.test(value[index])) {
        index += 1;
        continue;
      }
      let item: string;
      if (value[index] === '(') {
        item = this._bloksParenthesizedExpression(value, index);
        if (!item) return [];
      } else if (value[index] === '"') {
        try {
          const [, consumed] = rawDecode(value.slice(index));
          item = value.slice(index, index + consumed);
        } catch {
          return [];
        }
      } else {
        const atom = /^[^()\s"]+/.exec(value.slice(index));
        if (!atom) return [];
        item = atom[0];
      }
      items.push(item);
      index += item.length;
    }
    return items;
  }

  /** Extract the context token chained to an exact Bloks app id. */
  bloksExtractContextData(this: Client, result: any, appId: string): string {
    return this._bloksExtractContextValue(result, appId, 'context_data');
  }

  /** Read a literal context from the target app's static parameter map. */
  _bloksExtractContextValue(this: Client, result: any, appId: string, contextKey: string): string {
    const strings: string[] = [];
    this._bloksCollectStrings(result, strings);
    const anchor = new RegExp(escapeRegex(JSON.stringify(appId)), 'g');
    for (const text of strings) {
      anchor.lastIndex = 0;
      let found: RegExpExecArray | null;
      while ((found = anchor.exec(text))) {
        const foundEnd = found.index + found[0].length;
        const mapStart = text.indexOf('(f4i', foundEnd);
        if (mapStart < 0) continue;
        const appReference = /(?<![_a-zA-Z0-9])com\.bloks\.[_a-zA-Z0-9.]+/g;
        appReference.lastIndex = foundEnd;
        const nextApp = appReference.exec(text);
        if (nextApp && nextApp.index < mapStart) continue;
        let expression = this._bloksParenthesizedExpression(text, mapStart);
        if (!expression) continue;
        while (expression) {
          const items = this._bloksExpressionItems(expression);
          if (items.length !== 3 || items[0] !== 'f4i') break;
          const keys = this._bloksExpressionItems(items[1]);
          const values = this._bloksExpressionItems(items[2]);
          if (keys[0] !== 'dkc' || values[0] !== 'dkc' || keys.length !== values.length) break;
          expression = '';
          for (let i = 1; i < keys.length; i++) {
            const key = keys[i];
            const value = values[i];
            if (!key.startsWith('"')) continue;
            const name = JSON.parse(key);
            // Contexts must be literal strings, never evaluated expressions.
            if (name === contextKey) return value.startsWith('"') ? JSON.parse(value) : '';
            // Only descend into the target app's static server parameters.
            if (name === 'server_params') expression = value;
          }
        }
      }
    }
    return '';
  }

  /** Open the CAA profile-code challenge entrypoint. */
  async bloksApTwoStepVerificationEntrypoint(this: Client, contextData: string, bloksVersioningId = '', domain: string | null = null): Promise<any> {
    const params = {
      client_input_params: {
        auth_secure_device_id: '',
        accounts_list: [],
        has_whatsapp_installed: 0,
        family_device_id: this.phoneId,
        machine_id: this.mid,
      },
      server_params: {
        use_open_instead_of_push: 0,
        context_data: contextData,
        INTERNAL__latency_qpl_marker_id: 36707139,
        INTERNAL__latency_qpl_instance_id: Date.now(),
        device_id: this.uuid,
        use_close_instead_of_back: 0,
      },
    };
    return this.bloksAsyncAction(AP_2SV_ENTRYPOINT, params, bloksVersioningId, domain, null, true);
  }

  /** Open the profile-code input screen and obtain its submit context. */
  async bloksApTwoStepVerificationCodeEntry(this: Client, contextData: string, bloksVersioningId = '', domain: string | null = null): Promise<any> {
    const params = {
      client_input_params: { aac: this.caaAac },
      server_params: {
        context_data: contextData,
        show_close_button: 0,
        device_id: this.uuid,
        INTERNAL_INFRA_screen_id: 'generic_code_entry',
        is_dismissable: 1,
      },
    };
    return this.bloksApp(AP_2SV_CODE_ENTRY, params, bloksVersioningId, domain, true);
  }

  /** Submit the one-time code and return the terminal login response. */
  async bloksApTwoStepVerificationSubmitCode(
    this: Client,
    contextData: string,
    code: string,
    bloksVersioningId = '',
    domain: string | null = null,
  ): Promise<any> {
    const params = {
      client_input_params: {
        auth_secure_device_id: '',
        aac: this.caaAac,
        code: String(code),
        family_device_id: this.phoneId,
        device_id: this.androidDeviceId,
        machine_id: this.mid,
      },
      server_params: {
        context_data: contextData,
        INTERNAL__latency_qpl_marker_id: 36707139,
        INTERNAL__latency_qpl_instance_id: Date.now(),
        device_id: this.uuid,
      },
    };
    return this.bloksAsyncAction(AP_2SV_CODE_ENTRY_ASYNC, params, bloksVersioningId, domain, null, true);
  }

  /** Drive the CAA profile-code challenge through its terminal step. */
  async bloksCaaResolveTwoStepVerification(
    this: Client,
    sendResult: any,
    verificationCode = '',
    domain: string | null = null,
  ): Promise<Record<string, any>> {
    const entryContext = this.bloksExtractContextData(sendResult, AP_2SV_ENTRYPOINT);
    if (!entryContext) return { logged_in: false, reason: 'missing entrypoint context_data' };
    const entryResult = await this.bloksApTwoStepVerificationEntrypoint(entryContext, '', domain);
    const codeContext = this.bloksExtractContextData(entryResult, AP_2SV_CODE_ENTRY);
    if (!codeContext) return { logged_in: false, reason: 'missing code_entry context_data' };
    const codeResult = await this.bloksApTwoStepVerificationCodeEntry(codeContext, '', domain);
    const submitContext = this.bloksExtractContextData(codeResult, AP_2SV_CODE_ENTRY_ASYNC);
    if (!submitContext) return { logged_in: false, reason: 'missing code_entry_async context_data' };
    const code = verificationCode || (await this.challengeCodeOrRaised(ChallengeChoice.EMAIL));
    let submitResult: any;
    try {
      submitResult = await this.bloksApTwoStepVerificationSubmitCode(submitContext, code, '', domain);
    } catch (exc: any) {
      if (exc instanceof ChallengeError) throw exc;
      if (exc instanceof ClientError) {
        throw new ChallengeError(`CAA profile-code submission failed: ${exc.message}`, { response: exc.response ?? null });
      }
      throw exc;
    }
    return { logged_in: this.bloksApplyLoginResponse(submitResult), reason: '', result: submitResult };
  }

  _findBloksValue(this: Client, data: any, key: string): any {
    if (isDict(data)) {
      const value = data[key];
      if (truthy(value)) return value;
      for (const child of Object.values(data)) {
        const v = this._findBloksValue(child, key);
        if (truthy(v)) return v;
      }
    } else if (Array.isArray(data)) {
      for (const child of data) {
        const v = this._findBloksValue(child, key);
        if (truthy(v)) return v;
      }
    } else if (typeof data === 'string' && data.length < 10000 && data.includes(key)) {
      let value: any = null;
      try {
        value = this._findBloksValue(JSON.parse(data), key);
      } catch {
        value = null;
      }
      if (truthy(value)) return value;
    }
    return null;
  }

  _extractFirstJsonString(this: Client, value: string, start: number): string {
    const quoteIndex = value.indexOf('"', start);
    if (quoteIndex < 0) return '';
    try {
      const [decoded] = rawDecode(value.slice(quoteIndex));
      return typeof decoded === 'string' ? decoded : '';
    } catch {
      return '';
    }
  }

  /**
   * Extract two_step_verification_context from a CAA/Bloks login result.
   * First checks normal JSON containers, then parses the action parameter map of
   * two_step_verification.entrypoint without returning any other sensitive fields.
   */
  bloksExtractTwoStepVerificationContext(this: Client, result: any): string {
    const value = this._findBloksValue(result, 'two_step_verification_context');
    if (typeof value === 'string' && value.trim()) return value.trim();
    const action = result?.layout?.bloks_payload?.action ?? '';
    if (typeof action !== 'string') return '';
    return this._bloksExtractContextValue({ action }, 'com.bloks.www.two_step_verification.entrypoint', 'two_step_verification_context').trim();
  }

  /**
   * Extract an embedded login response from a Bloks action payload.
   * Returns the decoded login_response, response headers, cookie values, raw cookie header text,
   * and raw embedded object, or {} if no payload is found.
   */
  bloksExtractLoginResponse(this: Client, result: any): Record<string, any> {
    const action = result?.layout?.bloks_payload?.action ?? '';
    if (typeof action !== 'string') return {};
    let index = 0;
    while (index < action.length) {
      if (action[index] !== '"') {
        index += 1;
        continue;
      }
      let value: any;
      let end: number;
      try {
        [value, end] = rawDecode(action.slice(index));
      } catch {
        index += 1;
        continue;
      }
      index += Math.max(end, 1);
      if (typeof value !== 'string' || !value.includes('login_response')) continue;
      let raw: any;
      let loginResponse: any;
      let headers: any;
      try {
        raw = JSON.parse(value);
        if (!isDict(raw) || !('login_response' in raw)) continue;
        loginResponse = JSON.parse(raw.login_response);
        headers = JSON.parse(raw.headers || '{}');
      } catch {
        continue;
      }
      const rawCookies = raw.cookies || '';
      const cookies = simpleCookieLoad(String(rawCookies).split('Set-Cookie: ').join(''));
      return { login_response: loginResponse, headers, cookies, raw_cookies: rawCookies, raw };
    }
    return {};
  }

  /**
   * Apply a parsed Bloks login response to the client session.
   * `result` may be the raw Bloks response or the dictionary returned by bloksExtractLoginResponse.
   * Returns true when authorization or session cookies were applied.
   */
  bloksApplyLoginResponse(this: Client, result: any): boolean {
    const parsed = isDict(result) && ('headers' in result || 'cookies' in result) ? result : this.bloksExtractLoginResponse(result);
    if (!truthy(parsed)) return false;
    const headers = parsed.headers || {};
    const cookies: Record<string, string> = parsed.cookies || {};
    const authorization = headers['IG-Set-Authorization'] || headers['ig-set-authorization'];
    if (authorization) {
      this.authorizationData = this.parseAuthorization(authorization);
      if (this.authorization) this.private.headers.set('Authorization', this.authorization);
    }
    for (const [name, value] of Object.entries(cookies)) this.private.cookies.set(name, value);
    if (cookies.sessionid) this.public.cookies.set('sessionid', cookies.sessionid);
    const igURur = headers['ig-set-ig-u-rur'] || headers['IG-Set-IG-U-RUR'];
    if (igURur) {
      this.setIgURur(igURur);
      this.private.headers.set('IG-U-RUR', igURur);
    }
    const igWwwClaim = headers['x-ig-set-www-claim'] || headers['X-IG-Set-WWW-Claim'];
    if (igWwwClaim) {
      this.setIgWwwClaim(igWwwClaim);
      this.private.headers.set('X-IG-WWW-Claim', igWwwClaim);
    }
    return Boolean(authorization || cookies.sessionid);
  }

  /** Performing actions for bloks, e.g. "com.instagram.challenge.navigation.take_challenge" */
  async bloksAction(this: Client, action: string, data: Record<string, any>): Promise<boolean> {
    const result = await this.privateRequest(`bloks/apps/${action}/`, this.withDefaultData(data));
    return result.status === 'ok';
  }

  /** Change password for challenge (challengeContext is sent back unchanged). */
  async bloksChangePassword(this: Client, password: string, challengeContext: string): Promise<boolean> {
    const encPassword = await this.passwordEncrypt(password);
    const result = await this.bloksChallengeTakeChallenge(challengeContext, null, 0, {
      enc_new_password1: encPassword,
      enc_new_password2: encPassword,
    });
    return result.status === 'ok';
  }
}
