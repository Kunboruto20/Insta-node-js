import * as Boom from '@hapi/boom';
import { randomUUID } from 'node:crypto';
import { LoginRequired, SecondaryAccountError } from '../exceptions';
import { extractUserShort } from '../extractors';
import { APPS, DOC_ID, FLOW, continuation, registration } from '../secondary';
import { SecondaryAccount, makeSecondaryAccount } from '../types';
import { deepcopy } from '../utils/serialization';
import type { Client } from '../client';

/** Helpers for multiple accounts. */
export class MultipleAccountsMixin {
  async featuredAccountsV1(this: Client, targetUserId: string | number): Promise<any> {
    return this.privateRequest('multiple_accounts/get_featured_accounts/', null, { params: { target_user_id: String(targetUserId) } });
  }

  async getAccountFamilyV1(this: Client): Promise<any> {
    return this.privateRequest('multiple_accounts/get_account_family/');
  }

  /**
   * Create a linked additional profile, leaving this client's session unchanged.
   *
   * Returns a typed user and separate session settings. Creating an account accepts Instagram's
   * terms for that account. Only the observed Accounts Center flow is supported; verification/unknown
   * screens stop the method. A failed final submission may have created an account: do not retry it
   * automatically. Legacy getAccountFamilyV1 may remain empty.
   */
  async createSecondaryAccount(this: Client, username: string, opts: { linkToMainAccount?: boolean } = {}): Promise<SecondaryAccount> {
    const linkToMainAccount = opts.linkToMainAccount ?? true;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.]{1,30}$/.test(username)) {
      throw Boom.badRequest('username must contain 1-30 ASCII letters, digits, underscores or periods');
    }
    if (linkToMainAccount !== true) throw Boom.notImplemented('Only linked Accounts Center creation is supported');
    const timeout = this.readTimeout;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) throw Boom.badRequest('readTimeout must be a finite positive number');
    const parentId = String(this.userId || '');
    const parentAuth = this.authorization;
    if (!parentId || !parentAuth) throw new LoginRequired('An authenticated main account is required');

    // Lazy import to avoid the Client/mixin import cycle. Do not reuse this client's transport/cookie jar.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client: ClientCls } = require('../client');
    const source = this.getSettings();
    const keys = [
      'uuids', 'mid', 'device_settings', 'user_agent', 'country', 'country_code', 'locale', 'timezone_offset',
      'timezone_name', 'push_disabled', 'request_timeout', 'private_transport', 'public_transport',
      'public_transport_impersonate', 'tls_verify', 'usdid',
    ];
    const settings: Record<string, any> = deepcopy(Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]])));
    Object.assign(settings, { cookies: {}, authorization_data: {}, session_retry_total: 0 });
    let worker: Client | null = null;
    let stage = 'setup';
    let submitted = false;
    let completed = false;
    try {
      worker = new ClientCls({ settings, proxy: this.proxy, overrideAppVersion: this.overrideAppVersion }) as Client;
      const w = worker;
      w.readTimeout = timeout;
      stage = 'entry';
      const state = w._caaInitialState();
      state.waterfall_id = randomUUID();
      const entry = {
        logged_out_user: '',
        qpl_join_id: String(Date.now()),
        family_device_id: w.phoneId,
        reg_info: JSON.stringify({ device_id: w.androidDeviceId, soap_creation_source: 'profile_switcher' }),
        device_id: w.androidDeviceId,
        offline_experiment_group: 'caa_iteration_v3_perf_ig_4',
        waterfall_id: state.waterfall_id,
        logout_source: '',
        auth_token: parentAuth,
        flow_info: JSON.stringify(FLOW),
        qe_device_id: w.uuid,
      };
      const send = (name: string, params: any, entryRequest = false) => {
        const variables = {
          params: {
            params: entryRequest ? JSON.stringify(params) : JSON.stringify({ params: JSON.stringify(params) }),
            bloks_versioning_id: w.bloksVersioningId,
            infra_params: { device_id: w.uuid },
            app_id: APPS[name],
          },
          bk_context: { is_flipper_enabled: false, theme_params: [], debug_tooling_metadata_token: null },
        };
        return w.privateGraphqlWwwRequest(`IGBloksAppRootQuery-${APPS[name]}`, variables, DOC_ID, undefined, null, 'fetch', {
          allowRedirects: false,
          timeout: w.readTimeout,
        });
      };
      let response = await send(stage, entry, true);
      for (stage of ['username', 'optin', 'create']) {
        const servers = continuation(response, stage);
        const common = w._caaCommonClientInput(state);
        const inputs: Record<string, any> = {};
        for (const k of ['aac', 'lois_settings', 'cloud_trust_token', 'network_bssid']) inputs[k] = common[k];
        if (stage === 'username') {
          for (const k of ['device_id', 'family_device_id', 'qe_device_id']) inputs[k] = common[k];
          Object.assign(inputs, { validation_text: username, zero_balance_state: '', si_device_param_network_info: w._caaNetworkInfo() });
        } else if (stage === 'optin') {
          inputs.spc_disco_allow_suggestions = 1;
        } else {
          Object.assign(inputs, {
            passkey_eligible_device: 0,
            ck_error: '',
            device_id: w.androidDeviceId,
            waterfall_id: servers.waterfall_id,
            zero_balance_state: '',
            failed_birthday_year_count: '',
            headers_last_infra_flow_id: '',
            ig_partially_created_account_nonce_expiry: 0,
            machine_id: w.mid || '',
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
          });
        }
        servers.INTERNAL__latency_qpl_instance_id = Date.now() * 1000;
        servers.INTERNAL__latency_qpl_marker_id = 36707139;
        if (stage === 'create') submitted = true;
        response = await send(stage, { client_input_params: inputs, server_params: servers });
      }
      const [user, auth, headers, cookies] = registration(response, parentId, username);
      const resultSettings = w.getSettings();
      Object.assign(resultSettings, { authorization_data: auth, cookies, last_login: Date.now() / 1000 });
      for (const [setting, header] of [
        ['mid', 'ig-set-x-mid'],
        ['ig_u_rur', 'ig-set-ig-u-rur'],
        ['ig_www_claim', 'x-ig-set-www-claim'],
      ]) {
        const value = headers[header];
        if (typeof value === 'string') resultSettings[setting] = value;
      }
      const result = makeSecondaryAccount({ user: extractUserShort(user), settings: deepcopy(resultSettings) });
      completed = true;
      return result;
    } catch {
      // Never expose embedded credentials or raw Bloks bodies in errors.
      throw new SecondaryAccountError(stage, submitted);
    } finally {
      const errors: unknown[] = [];
      if (worker) {
        for (const session of [worker.private, worker.public, worker.graphql]) {
          if (!session) continue;
          try {
            session.close();
          } catch (error) {
            errors.push(error); // Close every owned session, including after interruption.
          }
        }
      }
      if (completed && errors.length) throw new SecondaryAccountError('cleanup', submitted);
    }
  }
}
