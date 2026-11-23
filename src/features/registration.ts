import { randomBytes, randomUUID } from 'node:crypto';
import {
  AgeEligibilityError,
  CaptchaChallengeRequired,
  ChallengeRequired,
  ClientError,
  EmailInvalidError,
  EmailNotAvailableError,
  EmailVerificationSendError,
  FeedbackRequired,
  SignupSpamError,
} from '../core/errorClasses';
import { extractUserShort } from '../parsing/responseParsers';
import { UserShort } from '../models/schemas';
import { rawDecode } from '../helpers/bigJson';
import { dumps, reprValue } from '../helpers/encoding';
import { randomInt, sleep } from '../helpers/delays';
import { ChallengeChoice } from './securityChallenge';
import type { Client } from '../core/instaClient';

export const CHOICE_EMAIL = 1;
export const LEGACY_SIGNUP_WARNING =
  "signup() uses Instagram's legacy account-create flow and should be treated as experimental. " +
  'Modern Instagram signup often requires additional official-app device trust checks that this library does not currently generate.';
export const CAA_REG_GRAPHQL_DOC_ID = '356548512614739681018024088968';
export const CAA_REG_CONTACTPOINT_DOC_ID = '253360298312778871684788706414';
export const CAA_REG_CONTACTPOINT_APPS = new Set([
  'com.bloks.www.bloks.caa.reg.contactpoint_phone',
  'com.bloks.www.bloks.caa.reg.contactpoint_email',
  'com.bloks.www.bloks.caa.reg.transition',
]);
export const CAA_REG_FLOW_INFO = { flow_name: 'new_to_family_ig_default', flow_type: 'ntf' };
export const CAA_REG_OFFLINE_EXPERIMENT_GROUP = 'caa_iteration_v3_perf_ig_4';
export const CAA_REG_LAYERED_HOMEPAGE_EXPERIMENT_GROUP = 'Deploy: Not in Experiment';
export const CAA_REG_VM_TOKEN_RE = /\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/g;
export const CAA_REG_REJECTION_MESSAGE_KEYWORDS = [
  'sorry',
  'went wrong',
  'try again',
  'not eligible',
  'unavailable',
  'too many',
  'invalid',
  'error',
  'problem',
];
export const CAA_REG_GENERIC_REJECTION_RE = /(?:We(?:'|\\'|\u2019)re|We are) sorry, but something went wrong\. Please try again\./i;

let signupWarned = false;

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function rand15(): number {
  return randomInt(100000000000000, 999999999999999);
}
function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

export class SignUpFeature {
  _safeChallengeApiPath(this: Client, apiPath: any, fieldName = 'api_path'): string {
    if (typeof apiPath !== 'string' || !apiPath) throw new ClientError(`Malformed challenge data from Instagram (missing ${fieldName}).`);
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(apiPath);
    const hasNetloc = apiPath.startsWith('//');
    const hasControlChars = Array.from(apiPath).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    if (hasScheme || hasNetloc || !apiPath.startsWith('/') || apiPath.startsWith('//') || apiPath.includes('\\') || hasControlChars) {
      throw new ClientError(`Unsafe challenge path from Instagram: ${fieldName}`);
    }
    return apiPath;
  }

  _challengeUrl(this: Client, apiPath: any, prefix = '', fieldName = 'api_path'): string {
    return `https://i.instagram.com${prefix}${this._safeChallengeApiPath(apiPath, fieldName)}`;
  }

  *_caaStringValues(this: Client, value: any): Generator<string> {
    if (isDict(value)) for (const item of Object.values(value)) yield* this._caaStringValues(item);
    else if (Array.isArray(value)) for (const item of value) yield* this._caaStringValues(item);
    else if (typeof value === 'string') yield value;
  }

  _caaCleanRejectionMessage(this: Client, value: string): string | null {
    const text = value.trim().replace(/\s+/g, ' ');
    if (!text) return null;
    const genericMatch = CAA_REG_GENERIC_REJECTION_RE.exec(text);
    if (genericMatch) return genericMatch[0].replace(/\\'/g, "'");
    if (text.length > 300 || text.startsWith('{') || text.startsWith('[') || text.startsWith('(')) return null;
    const lower = text.toLowerCase();
    if (!CAA_REG_REJECTION_MESSAGE_KEYWORDS.some((k) => lower.includes(k))) return null;
    if (['bk.action', 'bloks', 'optimistic vf', 'tr62rb'].some((m) => lower.includes(m))) return null;
    return text;
  }

  _caaExtractRejectionMessage(this: Client, response: any): string | null {
    const payloads: any[] = [response];
    const seen = new Set<any>();
    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i];
      if (seen.has(payload)) continue;
      seen.add(payload);
      for (const value of this._caaStringValues(payload)) {
        const message = this._caaCleanRejectionMessage(value);
        if (message) return message;
        if (value.includes('bloks_bundle_action') || value.includes('bloks_payload') || value.includes('registration_response')) {
          for (const decoded of this._caaJsonObjectsFromString(value)) {
            if (decoded && typeof decoded === 'object') payloads.push(decoded);
          }
        }
      }
    }
    return null;
  }

  _caaParseVmAtom(this: Client, token: string): any {
    if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
      try {
        return JSON.parse(token);
      } catch {
        return token.slice(1, -1);
      }
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^\s*[+-]?\d+\s*$/.test(token)) {
      const n = Number(token);
      return Number.isSafeInteger(n) ? n : BigInt(token.trim()).toString();
    }
    return token;
  }

  _caaParseVm(this: Client, value: string): any[] {
    const root: any[] = [];
    const stack: any[][] = [root];
    for (const m of value.matchAll(CAA_REG_VM_TOKEN_RE)) {
      const token = m[0];
      if (token === '(') {
        const child: any[] = [];
        stack[stack.length - 1].push(child);
        stack.push(child);
        continue;
      }
      if (token === ')') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      stack[stack.length - 1].push(this._caaParseVmAtom(token));
    }
    return root;
  }

  *_caaIterVmLists(this: Client, value: any): Generator<any[]> {
    if (Array.isArray(value)) {
      yield value;
      for (const item of value) yield* this._caaIterVmLists(item);
    }
  }

  *_caaExtractDkcMaps(this: Client, value: string): Generator<Record<string, any>> {
    if (!value.includes('(dkc')) return;
    let parsed: any[];
    try {
      parsed = this._caaParseVm(value);
    } catch {
      return;
    }
    for (const item of this._caaIterVmLists(parsed)) {
      if (
        item.length >= 3 &&
        item[0] === 'f4i' &&
        Array.isArray(item[1]) &&
        Array.isArray(item[2]) &&
        item[1][0] === 'dkc' &&
        item[2][0] === 'dkc'
      ) {
        const keys = item[1].slice(1);
        const values = item[2].slice(1);
        const out: Record<string, any> = {};
        keys.forEach((key: any, index: number) => {
          if (typeof key === 'string' && index < values.length) out[key] = values[index];
        });
        yield out;
      }
    }
  }

  *_caaJsonObjectsFromString(this: Client, value: string): Generator<any> {
    const stripped = value.trim();
    if (stripped.startsWith('{') || stripped.startsWith('[')) {
      try {
        yield JSON.parse(stripped);
      } catch {
        /* JSONDecodeError */
      }
    }
    let index = 0;
    while (true) {
      index = value.indexOf('"{', index);
      if (index < 0) break;
      let decoded: any;
      let consumed: number;
      try {
        [decoded, consumed] = rawDecode(value.slice(index));
      } catch {
        index += 2;
        continue;
      }
      if (typeof decoded === 'string' && (decoded.startsWith('{') || decoded.startsWith('['))) {
        try {
          yield JSON.parse(decoded);
        } catch {
          /* JSONDecodeError */
        }
      }
      index += Math.max(consumed, 1);
    }
  }

  _caaExtractRegistrationResponse(this: Client, value: any): Record<string, any> | null {
    if (isDict(value)) {
      if ('registration_response' in value) {
        const response = value.registration_response;
        if (typeof response === 'string') {
          let parsed: any;
          try {
            parsed = JSON.parse(response);
          } catch {
            return null;
          }
          // Only a dict is usable downstream; a JSON array/scalar from an error payload must not flow through.
          return isDict(parsed) ? parsed : null;
        }
        if (isDict(response)) return response;
      }
      if (value.account_created !== null && value.account_created !== undefined && 'created_user' in value) return value;
      for (const item of Object.values(value)) {
        const r = this._caaExtractRegistrationResponse(item);
        if (r && Object.keys(r).length) return r;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const r = this._caaExtractRegistrationResponse(item);
        if (r && Object.keys(r).length) return r;
      }
    }
    return null;
  }

  _caaExtractState(this: Client, response: any): Record<string, any> {
    const state: Record<string, any> = {};
    const payloads: any[] = [response];
    for (const payload of [...payloads]) {
      for (const value of this._caaStringValues(payload)) {
        if (value.includes('bloks_bundle_action') || value.includes('bloks_payload') || value.includes('registration_response')) {
          for (const decoded of this._caaJsonObjectsFromString(value)) if (decoded && typeof decoded === 'object') payloads.push(decoded);
        }
      }
    }
    for (const payload of payloads) {
      let registrationResponse = this._caaExtractRegistrationResponse(payload);
      if (registrationResponse && Object.keys(registrationResponse).length) state.registration_response = registrationResponse;
      for (const value of this._caaStringValues(payload)) {
        if (!['reg_info', 'reg_context', 'email_token', 'created_user'].some((k) => value.includes(k))) continue;
        for (const dkcMap of this._caaExtractDkcMaps(value)) {
          for (const key of ['reg_info', 'reg_context', 'email_token', 'created_user_id', 'created_userid']) {
            if (!(key in dkcMap) || dkcMap[key] === null || dkcMap[key] === '') continue;
            if (['reg_info', 'reg_context', 'email_token'].includes(key) && typeof dkcMap[key] !== 'string') continue;
            state[key] = dkcMap[key];
          }
        }
        for (const decoded of this._caaJsonObjectsFromString(value)) {
          registrationResponse = this._caaExtractRegistrationResponse(decoded);
          if (registrationResponse && Object.keys(registrationResponse).length) state.registration_response = registrationResponse;
        }
      }
    }
    return state;
  }

  _caaUpdateState(this: Client, state: Record<string, any>, response: any): Record<string, any> {
    for (const [key, value] of Object.entries(this._caaExtractState(response))) {
      if (value !== null && value !== undefined && value !== '') state[key] = value;
    }
    return state;
  }

  _caaInitialState(this: Client, email = ''): Record<string, any> {
    const deviceId = this.androidDeviceId || `android-${randomBytes(8).toString('hex')}`;
    const familyDeviceId = this.phoneId || randomUUID();
    const qeDeviceId = this.uuid || randomUUID();
    const waterfallId = this.waterfallId || randomUUID();
    const machineId = this.mid || '';
    const registrationFlowId = randomUUID();
    const regInfo = {
      first_name: null,
      last_name: null,
      full_name: null,
      contactpoint: email || null,
      ar_contactpoint: null,
      contactpoint_type: email ? 'email' : null,
      confirmation_code: null,
      birthday: null,
      encrypted_password: null,
      username: null,
      username_prefill: null,
      device_id: deviceId,
      ig4a_qe_device_id: qeDeviceId,
      family_device_id: familyDeviceId,
      machine_id: machineId || null,
      registration_flow_id: registrationFlowId,
      caa_reg_flow_source: 'login_home_native_integration_point',
      is_caa_perf_enabled: true,
      is_preform: true,
      screen_visited: [],
    };
    return {
      device_id: deviceId,
      family_device_id: familyDeviceId,
      qe_device_id: qeDeviceId,
      waterfall_id: waterfallId,
      machine_id: machineId,
      flow_info: dumps(CAA_REG_FLOW_INFO),
      reg_info: dumps(regInfo),
    };
  }

  _caaCommonClientInput(this: Client, state: Record<string, any>): Record<string, any> {
    return {
      aac: dumps({ aac_init_timestamp: Math.trunc(Date.now() / 1000), aacjid: randomUUID(), aaccs: '' }),
      device_id: state.device_id,
      family_device_id: state.family_device_id,
      machine_id: state.machine_id ?? '',
      lois_settings: { lois_token: '' },
      cloud_trust_token: null,
      zero_balance_state: '',
      network_bssid: null,
      qe_device_id: state.qe_device_id,
    };
  }

  _caaNetworkInfo(this: Client): Record<string, any> {
    return {
      active_subscriptions_info: null,
      default_subscription_info: {
        network_type: 13,
        is_data_roaming: 1,
        is_esim: null,
        is_gsm_roaming: 0,
        is_sim_sms_capable: null,
        is_mobile_data_enabled: 1,
        sim_carrier_id: 1,
        sim_carrier_id_name: 'T-Mobile - US',
        sim_state: 5,
        sim_operator: '310270',
        sim_operator_name: 'T-Mobile',
        signal_strength: 4,
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

  /**
   * Version 0 (plaintext envelope) is intentional here: the current Android CAA registration flow sends
   * encrypted_password as "#PWD_INSTAGRAM:0:", not the ":4:" sealed-box used by login/legacy signup.
   */
  _caaPassword(this: Client, password: string): string {
    return `#PWD_INSTAGRAM:0:${Math.trunc(Date.now() / 1000)}:${password}`;
  }

  _caaRegInfoValue(this: Client, state: Record<string, any>, key: string, def: any = null): any {
    let regInfo: any;
    try {
      regInfo = JSON.parse(state.reg_info || '{}');
    } catch {
      return def;
    }
    return regInfo && key in regInfo ? regInfo[key] : def;
  }

  _caaCommonServerParams(this: Client, state: Record<string, any>, currentStep = 0): Record<string, any> {
    const serverParams: Record<string, any> = {
      event_request_id: randomUUID(),
      is_from_logged_out: 0,
      layered_homepage_experiment_group: CAA_REG_LAYERED_HOMEPAGE_EXPERIMENT_GROUP,
      device_id: state.device_id,
      login_surface: 'login_home',
      waterfall_id: state.waterfall_id,
      INTERNAL__latency_qpl_instance_id: rand15(),
      flow_info: state.flow_info,
      is_platform_login: 0,
      login_entry_point: 'logged_out',
      INTERNAL__latency_qpl_marker_id: 36707139,
      reg_info: state.reg_info,
      family_device_id: state.family_device_id,
      offline_experiment_group: CAA_REG_OFFLINE_EXPERIMENT_GROUP,
      access_flow_version: 'pre_mt_behavior',
      is_from_logged_in_switcher: 0,
      current_step: currentStep,
      qe_device_id: state.qe_device_id,
    };
    if (state.reg_context) serverParams.reg_context = state.reg_context;
    return serverParams;
  }

  _caaParams(
    this: Client,
    state: Record<string, any>,
    currentStep = 0,
    clientInputParams: Record<string, any> | null = null,
    serverParams: Record<string, any> | null = null,
  ): Record<string, any> {
    const clientInputs = { ...this._caaCommonClientInput(state), ...(clientInputParams || {}) };
    const servers = { ...this._caaCommonServerParams(state, currentStep), ...(serverParams || {}) };
    for (const k of Object.keys(servers)) if (servers[k] === null || servers[k] === undefined) delete servers[k];
    return { client_input_params: clientInputs, server_params: servers };
  }

  async caaRegGraphql(
    this: Client,
    app: string,
    state: Record<string, any> | null = null,
    currentStep = 0,
    clientInputParams: Record<string, any> | null = null,
    serverParams: Record<string, any> | null = null,
    clientDocId: string | null = null,
  ): Promise<any> {
    const st = state || this._caaInitialState();
    const params = this._caaParams(st, currentStep, clientInputParams, serverParams);
    const docId = clientDocId || (CAA_REG_CONTACTPOINT_APPS.has(app) ? CAA_REG_CONTACTPOINT_DOC_ID : CAA_REG_GRAPHQL_DOC_ID);
    return this.bloksGraphqlApp(app, params, docId, '', 'b.i.instagram.com', st.qe_device_id);
  }

  async caaRegAsyncAction(
    this: Client,
    action: string,
    state: Record<string, any> | null = null,
    currentStep = 0,
    clientInputParams: Record<string, any> | null = null,
    serverParams: Record<string, any> | null = null,
  ): Promise<any> {
    const st = state || this._caaInitialState();
    const params = this._caaParams(st, currentStep, clientInputParams, serverParams);
    return this.bloksAsyncAction(action, params, '', 'b.i.instagram.com');
  }

  /** Register a new account through the current Android CAA (Bloks) email flow. */
  async signupCaaEmail(
    this: Client,
    username: string,
    password: string,
    email: string,
    fullName = '',
    year: number | null = null,
    month: number | null = null,
    day: number | null = null,
    attempts = 10,
    waitSeconds: number | null = null,
  ): Promise<UserShort> {
    if (!email) throw new ClientError('email is required for CAA signup');
    const y = year || randomInt(1980, 1995);
    const m = month || randomInt(1, 12);
    const d = day || randomInt(1, 28);
    const wait = waitSeconds === null || waitSeconds === undefined ? this.waitSeconds : waitSeconds;
    const state = this._caaInitialState(email);

    let response = await this.caaRegGraphql(
      'com.bloks.www.bloks.caa.reg.aymh_create_account_button.async',
      state,
      0,
      { accounts_list: [], device_emails: [], device_phone_numbers: [] },
      { reg_flow_source: 'login_home_native_integration_point', entrypoint: 'login_home' },
    );
    this._caaUpdateState(state, response);
    response = await this.caaRegAsyncAction('com.bloks.www.bloks.caa.reg.async.expose_ntm_experiment.async', state, 0, {
      si_device_param_network_info: '',
    });
    this._caaUpdateState(state, response);
    response = await this.caaRegGraphql('com.bloks.www.bloks.caa.reg.async.contactpoint_prefill.async', state, 0, {
      accounts_list: [],
      si_device_param_network_info: '',
    });
    this._caaUpdateState(state, response);
    response = await this.caaRegGraphql('com.bloks.www.bloks.caa.reg.contactpoint_phone', state, 0, null, {
      INTERNAL_INFRA_screen_id: randomUUID(),
    });
    this._caaUpdateState(state, response);
    response = await this.caaRegGraphql('com.bloks.www.bloks.caa.reg.contactpoint_email', state, 0, null, {
      root_screen_id: 'CAA_REG_CONTACT_POINT_PHONE',
      INTERNAL_INFRA_screen_id: randomUUID(),
      reg_context: null,
    });
    this._caaUpdateState(state, response);
    response = await this.caaRegAsyncAction(
      'com.bloks.www.bloks.caa.reg.async.contactpoint_email_new.async',
      state,
      0,
      {
        accounts_list: [],
        email,
        email_prefilled: 0,
        confirmed_cp_and_code: {},
        is_from_device_emails: 0,
        prefetch_version: 11,
        si_device_param_network_info: this._caaNetworkInfo(),
        block_store_machine_id: '',
        fb_ig_device_id: [],
      },
      { cp_funnel: 0, cp_source: 0, prefetch_on_field: 1, text_input_id: rand15(), reg_context: null },
    );
    this._caaUpdateState(state, response);
    response = await this.caaRegAsyncAction(
      'com.bloks.www.bloks.caa.reg.send_confirmation_email.async',
      state,
      0,
      { email_token: state.email_token ?? '' },
      { is_from_unified_cp_screen: false, is_direct_from_conf: false, accounts_list: [] },
    );
    this._caaUpdateState(state, response);

    let code: string | null | undefined = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      code = await this.challengeCodeHandler(username, CHOICE_EMAIL);
      if (code) break;
      // Skip the backoff after the final attempt: no further poll follows it.
      if (wait && attempt < attempts - 1) await sleep(wait * (attempt + 1));
    }
    if (!code) throw new ClientError('email confirmation code is required for CAA signup');

    response = await this.caaRegGraphql(
      'com.bloks.www.bloks.caa.reg.confirmation.async',
      state,
      3,
      { code, confirmed_cp_and_code: { contactpoint: email, code } },
      { text_input_id: randomUUID(), wa_timer_id: randomUUID() },
    );
    this._caaUpdateState(state, response);
    response = await this.caaRegGraphql(
      'com.bloks.www.bloks.caa.reg.password.async',
      state,
      4,
      {
        encrypted_password: this._caaPassword(password),
        spi_action: 1,
        whatsapp_installed_on_client: false,
        safetynet_token: this._caaRegInfoValue(state, 'safetynet_token', ''),
        safetynet_response: this._caaRegInfoValue(state, 'safetynet_response', 'GOOGLE_PLAY_UNAVAILABLE: SERVICE_INVALID'),
        system_permissions_status: {
          READ_CONTACTS: 'DENIED',
          GET_ACCOUNTS: 'DENIED',
          READ_PHONE_STATE: 'DENIED',
          READ_PHONE_NUMBERS: 'DENIED',
        },
      },
      { flow_modifier: state.flow_info, si_device_param_network_info: '' },
    );
    this._caaUpdateState(state, response);
    const birthday = `${pad(d, 2)}-${pad(m, 2)}-${pad(y, 4)}`;
    response = await this.caaRegGraphql(
      'com.bloks.www.bloks.caa.reg.birthday.async',
      state,
      6,
      {
        accounts_list: [],
        client_timezone: this.timezoneOffset ?? 0,
        birthday_or_current_date_string: birthday,
        birthday_timestamp: Math.trunc(Date.now() / 1000),
        os_age_range: 'o18',
        should_skip_youth_tos: false,
        is_youth_regulation_flow_complete: false,
      },
      { si_device_param_network_info: '' },
    );
    this._caaUpdateState(state, response);
    response = await this.caaRegAsyncAction(
      'com.bloks.www.bloks.caa.reg.name_vtwo.async',
      state,
      7,
      { accounts_list: [], name: fullName || username },
      { si_device_param_network_info: '' },
    );
    this._caaUpdateState(state, response);
    response = await this.caaRegGraphql(
      'com.bloks.www.bloks.caa.reg.username.async',
      state,
      8,
      { validation_text: username },
      { action: 1, post_tos: 0, text_input_id: rand15(), suggestions_container_id: rand15(), screen_id: rand15(), input_id: rand15() },
    );
    this._caaUpdateState(state, response);
    response = await this.caaRegGraphql(
      'com.bloks.www.bloks.caa.reg.create.account.async',
      state,
      9,
      {
        passkey_eligible_device: 0,
        ck_error: '',
        failed_birthday_year_count: '',
        headers_last_infra_flow_id: '',
        ig_partially_created_account_nonce_expiry: 0,
        should_ignore_existing_login: 0,
        reached_from_tos_screen: 1,
        ig_partially_created_account_nonce: '',
        has_dismissed_suma_pre_conf: 0,
        ck_nonce: '',
        force_sessionless_nux_experience: 0,
        ig_partially_created_account_user_id: 0,
        ck_id: '',
        no_contact_perm_email_oauth_token: '',
        encrypted_msisdn: '',
      },
      { sa_prefetch_callback_id: '', should_ignore_suma_check: 0, bloks_controller_source: 'bk_caa_reg_tos_screen', app_id: 0 },
    );
    this._caaUpdateState(state, response);
    const registrationResponse = state.registration_response;
    if (!registrationResponse || !registrationResponse.created_user) {
      const rejectionMessage = this._caaExtractRejectionMessage(response);
      if (rejectionMessage) throw new ClientError(`CAA signup was rejected by Instagram: ${rejectionMessage}`);
      throw new ClientError('CAA signup did not return created_user');
    }
    if (registrationResponse.account_created === false) {
      throw new ClientError(`CAA signup did not create an account: ${reprValue(registrationResponse)}`);
    }
    return extractUserShort(registrationResponse.created_user);
  }

  /** Legacy signup flow (experimental, see LEGACY_SIGNUP_WARNING). */
  async signup(
    this: Client,
    username: string,
    password: string,
    email = '',
    phoneNumber = '',
    fullName = '',
    year: number | null = null,
    month: number | null = null,
    day: number | null = null,
  ): Promise<UserShort> {
    if (!(email || phoneNumber)) throw new ClientError('Use email or phone_number for signup');
    if (!signupWarned) {
      process.emitWarning(LEGACY_SIGNUP_WARNING, 'RuntimeWarning');
      signupWarned = true;
    }
    await this.getSignupConfig();
    const extraArgs: Record<string, any> = { username, password, full_name: fullName, year, month, day };
    if (email) {
      const check = await this.checkEmail(email);
      if (!check.valid) throw new EmailInvalidError(`Email not valid: ${check.error_title ?? reprValue(check)}`);
      if (!check.available) throw new EmailNotAvailableError(`Email not available: ${check.feedback_message ?? reprValue(check)}`);
      const sent = await this.sendVerifyEmail(email);
      if (!sent.email_sent) throw new EmailVerificationSendError(`Failed to send verification email: ${reprValue(sent)}`);
      // Date of Birth (DOB) Age Eligibility Check
      if (year && month && day) {
        const ageCheckResult = await this.checkAgeEligibility(year, month, day);
        // IG returns "eligible_to_register"; keep "eligible" as a fallback
        const eligible = 'eligible_to_register' in ageCheckResult ? ageCheckResult.eligible_to_register : ageCheckResult.eligible;
        if (!eligible) throw new AgeEligibilityError(`Account not eligible based on age criteria: ${reprValue(ageCheckResult)}`);
      }
      // send code confirmation
      let code: string | null | undefined = '';
      let attempt = 1;
      for (attempt = 1; attempt < 11; attempt++) {
        code = await this.challengeCodeHandler(username, CHOICE_EMAIL);
        if (code) break;
        await sleep(this.waitSeconds * attempt);
      }
      console.log(`Enter code "${code}" for ${username} (${Math.min(attempt, 10)} attempts, by ${this.waitSeconds} seconds)`);
      const signupCode = (await this.checkConfirmationCode(email, code || '')).signup_code;
      extraArgs.email = email;
      extraArgs.signup_code = signupCode;
    }
    if (phoneNumber && !email) {
      extraArgs.phone_number = phoneNumber;
      const check = await this.checkPhoneNumber(phoneNumber);
      if (check.status !== 'ok' && !check.valid) throw new ClientError(`Phone number not valid (${reprValue(check)})`);
      const sms = await this.sendSignupSmsCode(phoneNumber);
      if (sms.status !== 'ok') throw new ClientError(`Error when verify phone number (${reprValue(sms)})`);
      let attempt = 1;
      let code: string | null | undefined;
      if ('verification_code' in sms) code = sms.verification_code;
      else {
        code = '';
        for (attempt = 1; attempt < 11; attempt++) {
          code = await this.challengeCodeHandler(username, ChallengeChoice.SMS);
          if (code) break;
          await sleep(this.waitSeconds * attempt);
        }
      }
      console.log(`Enter code "${code}" for ${username} (${Math.min(attempt, 10)} attempts, by ${this.waitSeconds} seconds)`);
      extraArgs.phone_code = code;
    }
    let retries = 0;
    let data: any;
    while (retries < 3) {
      data = await this.accountsCreate(extraArgs);
      if (data.message !== 'challenge_required') break;
      if (await this.challengeFlow(data.challenge, phoneNumber, username)) Object.assign(extraArgs, { suggestedUsername: '', sn_result: 'MLA' });
      retries += 1;
    }
    return extractUserShort(data.created_user);
  }

  async getSignupConfig(this: Client): Promise<any> {
    return this.privateRequest('consent/get_signup_config/', null, { params: { guid: this.uuid, main_account_selected: false } });
  }

  /** Check available (free, not registred) email */
  async checkEmail(this: Client, email: string): Promise<any> {
    return this.privateRequest('users/check_email/', {
      android_device_id: this.androidDeviceId,
      login_nonce_map: '{}',
      login_nonces: '[]',
      email,
      qe_id: randomUUID(),
      waterfall_id: this.waterfallId,
    });
  }

  async checkUsername(this: Client, username: string): Promise<any> {
    return this.privateRequest('users/check_username/', { username, _uuid: this.uuid });
  }

  async checkPhoneNumber(this: Client, phoneNumber: string): Promise<any> {
    return this.privateRequest('accounts/check_phone_number/', {
      phone_id: this.phoneId,
      login_nonce_map: '{}',
      phone_number: phoneNumber.replace(/ /g, '+'),
      guid: this.uuid,
      device_id: this.androidDeviceId,
      prefill_shown: 'False',
    });
  }

  async sendSignupSmsCode(this: Client, phoneNumber: string): Promise<any> {
    return this.privateRequest('accounts/send_signup_sms_code/', {
      phone_id: this.phoneId,
      phone_number: phoneNumber.replace(/ /g, '+'),
      guid: this.uuid,
      device_id: this.androidDeviceId,
      android_build_type: 'release',
      waterfall_id: this.waterfallId,
    });
  }

  /** Send request to receive code to email */
  async sendVerifyEmail(this: Client, email: string): Promise<any> {
    return this.privateRequest('accounts/send_verify_email/', {
      phone_id: this.phoneId,
      device_id: this.androidDeviceId,
      email,
      waterfall_id: this.waterfallId,
      auto_confirm_only: 'false',
    });
  }

  /** Enter code from email */
  async checkConfirmationCode(this: Client, email: string, code: string): Promise<any> {
    return this.privateRequest('accounts/check_confirmation_code/', {
      code,
      device_id: this.androidDeviceId,
      email,
      waterfall_id: this.waterfallId,
    });
  }

  async checkAgeEligibility(this: Client, year: number, month: number, day: number): Promise<any> {
    return this.privateRequest('consent/check_age_eligibility/', { _csrftoken: this.token, day, year, month }, { withSignature: false });
  }

  async accountsCreate(this: Client, opts: Record<string, any>): Promise<any> {
    const {
      username,
      password,
      email = '',
      signup_code: signupCode = '',
      phone_number: phoneNumber = '',
      phone_code: phoneCode = '',
      full_name: fullName = '',
      year = null,
      month = null,
      day = null,
      ...extraArgs
    } = opts;
    if (!(email || phoneNumber)) throw new ClientError('Use email or phone_number for signup');
    const data: Record<string, any> = {
      jazoest: String(randomInt(22300, 22399)), // "22341",
      tos_version: 'row',
      suggestedUsername: '',
      sn_result: '',
      do_not_auto_login_if_credentials_match: 'false',
      phone_id: this.phoneId,
      enc_password: await this.passwordEncrypt(password),
      username: String(username),
      first_name: String(fullName),
      adid: this.adid,
      guid: this.uuid,
      day,
      month,
      year,
      device_id: this.androidDeviceId,
      _uuid: this.uuid,
      waterfall_id: this.waterfallId,
      one_tap_opt_in: 'true',
      ...extraArgs,
    };
    let endpoint: string;
    let domain: string | null;
    if (email && !phoneNumber) {
      endpoint = 'accounts/create/';
      domain = 'www.instagram.com';
      const nonceBytes = randomBytes(24);
      const bytesRepr = "b'" + Array.from(nonceBytes, (b) => (b >= 32 && b < 127 && b !== 39 && b !== 92 ? String.fromCharCode(b) : '\\x' + b.toString(16).padStart(2, '0'))).join('') + "'";
      Object.assign(data, {
        email,
        force_sign_up_code: signupCode,
        qs_stamp: '',
        sn_nonce: `${email}|${Math.trunc(Date.now() / 1000)}|${bytesRepr}`,
      });
    } else {
      endpoint = 'accounts/create_validated/';
      domain = null;
      Object.assign(data, { phone_number: phoneNumber, verification_code: phoneCode, force_sign_up_code: '', has_sms_consent: 'true' });
      if (data.logged_in_user_id) data.is_secondary_account_creation = 'true';
    }
    try {
      return await this.privateRequest(endpoint, data, { domain });
    } catch (exc: any) {
      if (exc instanceof FeedbackRequired && exc.spam) {
        const details: Record<string, any> = { ...exc };
        delete details.message;
        delete details.name;
        throw new SignupSpamError(
          'Instagram rejected the legacy signup flow as spam. ' +
            'Modern app signup uses additional device trust checks that this library does not currently generate.',
          details,
        );
      }
      throw exc;
    }
  }

  async challengeFlow(this: Client, data: any, phoneNumber = '', username = '', waitSeconds: number | null = null, attempts = 10): Promise<boolean> {
    data = await this.challengeApi(data);
    const wait = waitSeconds === null || waitSeconds === undefined ? this.waitSeconds : waitSeconds;
    username = username || this.username || '';
    for (let i = 0; i < 10; i++) {
      if (data.status === 'ok') return true;
      if (data.message === 'challenge_required') {
        data = await this.challengeCaptcha(data.challenge);
        continue;
      }
      if (data.challengeType === 'SubmitPhoneNumberForm') {
        if (!phoneNumber) throw new ClientError('phone_number is required for signup SMS challenge');
        data = await this.challengeSubmitPhoneNumber(data, phoneNumber);
        continue;
      }
      if (data.challengeType === 'VerifySMSCodeFormForSMSCaptcha') {
        let securityCode: string | null | undefined = '';
        for (let attempt = 0; attempt < attempts; attempt++) {
          securityCode = await this.challengeCodeHandler(username, ChallengeChoice.SMS);
          if (securityCode) break;
          if (wait) await sleep(wait * (attempt + 1));
        }
        if (!securityCode) throw new ChallengeRequired('SMS code required for signup challenge');
        data = await this.challengeVerifySmsCaptcha(data, securityCode);
        continue;
      }
      throw new ClientError(`Unsupported signup challenge step: ${reprValue(data)}`);
    }
    throw new ClientError(`Signup challenge flow did not complete: ${reprValue(data)}`);
  }

  async challengeApi(this: Client, data: any): Promise<any> {
    const resp = await this.private.get(this._challengeUrl(data.api_path, '/api/v1'), {
      params: { guid: this.uuid, device_id: this.androidDeviceId, challenge_context: data.challenge_context },
    });
    return resp.json();
  }

  async challengeCaptcha(this: Client, challengeJsonData: any): Promise<any> {
    const apiPath = challengeJsonData.api_path;
    const siteKey = (challengeJsonData.fields || {}).sitekey;
    const challengeType = challengeJsonData.challengeType; // For logging/context
    if (!siteKey || !apiPath) {
      this.logger.error(`Malformed captcha challenge data from Instagram: site_key=${siteKey}, api_path=${apiPath}`);
      throw new ClientError('Malformed captcha challenge data from Instagram (missing site_key or api_path).');
    }
    const challengePostUrl = this._challengeUrl(apiPath);
    const captchaDetailsForSolver = {
      site_key: siteKey,
      challenge_type: challengeType,
      raw_challenge_json: challengeJsonData,
      page_url: 'https://www.instagram.com/accounts/emailsignup/', // Common page for signup captcha
    };
    let gRecaptchaResponse: string;
    try {
      gRecaptchaResponse = await this.captchaResolve(captchaDetailsForSolver);
    } catch (e: any) {
      if (e instanceof CaptchaChallengeRequired) {
        this.logger.warning('Captcha solution was required by Instagram but not provided/resolved by any configured handler.');
        throw e; // Re-raise for the user of the library to handle or be informed.
      }
      this.logger.error(`An unexpected error occurred during the captcha resolution process: ${e?.message ?? e}`);
      throw new ClientError(`Captcha resolution process failed: ${e?.message ?? e}`); // Wrap other errors
    }
    // Proceed to POST the g_recaptcha_response:
    const resp = await this.private.post(challengePostUrl, { data: { 'g-recaptcha-response': gRecaptchaResponse } });
    return resp.json();
  }

  async challengeSubmitPhoneNumber(this: Client, data: any, phoneNumber: string): Promise<any> {
    const apiPath = (data.navigation || {}).forward;
    const resp = await this.private.post(this._challengeUrl(apiPath, '', 'navigation.forward'), {
      data: { phone_number: phoneNumber, challenge_context: data.challenge_context },
    });
    return resp.json();
  }

  async challengeVerifySmsCaptcha(this: Client, data: any, securityCode: string): Promise<any> {
    const apiPath = (data.navigation || {}).forward;
    const resp = await this.private.post(this._challengeUrl(apiPath, '', 'navigation.forward'), {
      data: { security_code: securityCode, challenge_context: data.challenge_context },
    });
    return resp.json();
  }
}
