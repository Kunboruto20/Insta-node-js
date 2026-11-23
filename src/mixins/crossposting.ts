import { randomUUID } from 'node:crypto';
import * as config from '../config';
import { ClientError, ClientGraphqlError } from '../exceptions';
import type { Client } from '../client';

export const FB_CROSSPOSTING_UNIFIED_CONFIG_CLIENT_DOC_ID = '216179630714134719310007237117';
export const FB_CROSSPOSTING_UNIFIED_CONFIG_FRIENDLY_NAME = 'CrosspostingUnifiedConfigsQuery';
export const FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD = 'xcxp_unified_crossposting_configs_root';
export const FB_CONNECTED_SERVICES_CLIENT_DOC_ID = '21631519911413744205623093060';
export const FB_CONNECTED_SERVICES_FRIENDLY_NAME = 'FxIgConnectedServicesInfoQuery';
export const FB_CONNECTED_SERVICES_ROOT_FIELD = 'fx_service_cache';
export const FB_STORY_CROSSPOSTING_SURFACE = { source_surface: 'STORY', destination_app: 'FB', destination_surface: 'STORY' };
export const FB_FEED_CROSSPOSTING_SURFACE = { source_surface: 'FEED', destination_app: 'FB', destination_surface: 'FEED' };
export const FB_REELS_CROSSPOSTING_SURFACE = { source_surface: 'REELS', destination_app: 'FB', destination_surface: 'REELS' };
export const FB_CROSSPOSTING_SURFACES = [FB_STORY_CROSSPOSTING_SURFACE, FB_FEED_CROSSPOSTING_SURFACE, FB_REELS_CROSSPOSTING_SURFACE];
export const THREADS_LINKED_PROFILE_CLIENT_DOC_ID = '1294688273527445410149299611';
export const THREADS_LINKED_PROFILE_FRIENDLY_NAME = 'LinkedBarcelonaProfileQuery';
export const THREADS_LINKED_PROFILE_ROOT_FIELD = 'xcxp_fetch_linked_threads_profile';

export type FbDestinationType = 'USER' | 'PAGE';

export interface CrosspostingOptions {
  shareToFacebook?: boolean;
  shareToThreads?: boolean;
  fbDestinationId?: string | null;
  fbDestinationType?: FbDestinationType | null;
  fbValidationBypass?: string[] | null;
  threadsDestinationId?: string | null;
  threadsValidationBypass?: string[] | null;
}

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function* iterDicts(value: any): Generator<Record<string, any>> {
  if (isDict(value)) {
    yield value;
    for (const child of Object.values(value)) yield* iterDicts(child);
  } else if (Array.isArray(value)) {
    for (const child of value) yield* iterDicts(child);
  }
}

/** Helpers shared by feed and Reel cross-post upload flows. */
export class CrossPostingMixin {
  /** Get Android's unified cross-posting configuration. */
  async mediaShareToFbUnifiedConfig(this: Client, crosspostAppSurfaceList: Array<Record<string, string>> | null = null): Promise<any> {
    const variables = {
      configs_request: { source_app: 'IG', crosspost_app_surface_list: crosspostAppSurfaceList || FB_CROSSPOSTING_SURFACES },
    };
    const result = await this.privateGraphqlWwwRequest(
      FB_CROSSPOSTING_UNIFIED_CONFIG_FRIENDLY_NAME,
      variables,
      FB_CROSSPOSTING_UNIFIED_CONFIG_CLIENT_DOC_ID,
      config.API_DOMAIN,
      { 'X-Root-Field-Name': FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD, Priority: 'u=3, i', 'X-FB-RMD': 'state=URL_ELIGIBLE' },
      null,
    );
    if (!('status' in result)) result.status = 'ok';
    return result;
  }

  /** Get Android's connected Facebook destination service cache. */
  async mediaShareToFbConnectedServicesConfig(this: Client): Promise<any> {
    const variables = {
      service_names: ['CROSS_POSTING_SETTING'],
      custom_partner_params: [
        { value: 'FB', key: 'CROSSPOSTING_DESTINATION_APP' },
        { value: '', key: 'CROSSPOSTING_SHARE_TO_SURFACE' },
        { value: 'true', key: 'OVERRIDE_USER_VALIDATION_WITH_CXP_ELIGIBILITY_RULE' },
      ],
      client_caller_name: 'ig_android_service_cache_crossposting_setting',
      caller_name: 'fx_product_foundation_client_FXOnline_client_cache',
    };
    const result = await this.privateGraphqlWwwRequest(
      FB_CONNECTED_SERVICES_FRIENDLY_NAME,
      variables,
      FB_CONNECTED_SERVICES_CLIENT_DOC_ID,
      config.API_DOMAIN,
      { Priority: 'u=3, i', 'X-FB-RMD': 'state=URL_ELIGIBLE', 'X-Root-Field-Name': FB_CONNECTED_SERVICES_ROOT_FIELD },
      null,
    );
    if (!('status' in result)) result.status = 'ok';
    return result;
  }

  _crosspostingIterDicts(this: Client, value: any): Generator<Record<string, any>> {
    return iterDicts(value);
  }

  _crosspostingCandidateValue(this: Client, cfg: Record<string, any>, keys: string[]): any {
    for (const key of keys) {
      const value = cfg[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }

  _crosspostingGraphqlRoot(this: Client, cfg: Record<string, any>, rootField: string): any {
    const c = cfg || {};
    const data = c.data;
    if (isDict(data)) {
      const root = data[rootField];
      if (root !== null && root !== undefined) return root;
      for (const [key, value] of Object.entries(data)) if (String(key).includes(rootField)) return value;
    }
    const root = c[rootField];
    if (root !== null && root !== undefined) return root;
    for (const [key, value] of Object.entries(c)) if (String(key).includes(rootField)) return value;
    return c;
  }

  _crosspostingHasGraphqlRoot(this: Client, cfg: any, rootField: string): boolean {
    if (!isDict(cfg)) return false;
    const data = cfg.data;
    if (isDict(data) && Object.keys(data).some((k) => k.includes(rootField))) return true;
    return Object.keys(cfg).some((k) => k.includes(rootField));
  }

  _mediaShareToFbFeedCandidate(this: Client, cfg: Record<string, any>): boolean {
    const sourceSurface = String(cfg.source_surface || '').toUpperCase();
    const destinationSurface = String(cfg.destination_surface || '').toUpperCase();
    const destinationApp = String(cfg.destination_app || '').toUpperCase();
    if (sourceSurface && sourceSurface !== 'FEED') return false;
    if (destinationSurface && destinationSurface !== 'FEED') return false;
    if (destinationApp && destinationApp !== 'FB' && destinationApp !== 'FACEBOOK') return false;
    return sourceSurface === 'FEED' || destinationSurface === 'FEED';
  }

  *_mediaShareToFbUnifiedDestinationCandidates(this: Client, cfg: Record<string, any>): Generator<Record<string, any>> {
    const root = this._crosspostingGraphqlRoot(cfg, FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD);
    for (const service of iterDicts(root)) {
      const identityMappings = service.identity_mapping;
      if (!Array.isArray(identityMappings)) continue;
      const customServiceData = service.custom_service_data;
      const surfaceConfig = isDict(customServiceData) ? customServiceData : service;
      let any = false;
      for (const candidate of iterDicts(surfaceConfig)) {
        if (this._mediaShareToFbFeedCandidate(candidate)) {
          any = true;
          break;
        }
      }
      if (!any) continue;
      for (const identityMapping of identityMappings) {
        if (!isDict(identityMapping)) continue;
        const destinationIdentities = identityMapping.destination_identities;
        if (!Array.isArray(destinationIdentities)) continue;
        for (const destination of destinationIdentities) {
          if (isDict(destination)) yield { source_surface: 'FEED', destination_app: 'FB', destination_surface: 'FEED', ...destination };
        }
      }
    }
    for (const candidate of iterDicts(root)) {
      if (!this._mediaShareToFbFeedCandidate(candidate)) continue;
      const merged: Record<string, any> = { ...candidate };
      for (const key of ['destination', 'fb_destination', 'feed_destination', 'crosspost_destination', 'crossposting_destination', 'xpost_destination']) {
        const nested = candidate[key];
        if (isDict(nested)) Object.assign(merged, nested);
      }
      yield merged;
    }
  }

  /** Yield eligible Facebook destinations from Android's Fx service cache. */
  *_fbConnectedServicesDestinationCandidates(this: Client, cfg: Record<string, any>, surface: string): Generator<Record<string, any>> {
    const root = this._crosspostingGraphqlRoot(cfg, FB_CONNECTED_SERVICES_ROOT_FIELD);
    if (!isDict(root)) return;
    const services = root.services;
    if (!Array.isArray(services)) return;
    surface = surface.toUpperCase();
    for (const service of services) {
      if (!isDict(service)) continue;
      let audienceType: any = null;
      if (surface === 'REELS') {
        const customServiceData = service.custom_service_data;
        if (isDict(customServiceData)) {
          const privacyData = customServiceData.fb_reels_privacy_setting_service_data;
          if (isDict(privacyData)) audienceType = privacyData.fb_reels_audience ?? null;
        }
      }
      const identityMappings = service.identity_mapping;
      if (!Array.isArray(identityMappings)) continue;
      for (const identityMapping of identityMappings) {
        if (!isDict(identityMapping)) continue;
        const destinationIdentities = identityMapping.destination_identities;
        if (!Array.isArray(destinationIdentities)) continue;
        for (const destination of destinationIdentities) {
          if (!isDict(destination)) continue;
          const eligibilities = destination.surface_to_xpost_eligibilities;
          const matching = Array.isArray(eligibilities)
            ? eligibilities.filter((e: any) => isDict(e) && String(e.surface || '').toUpperCase() === surface)
            : [];
          if (matching.some((e: any) => e.is_eligible === false)) continue;
          const candidate: Record<string, any> = { source_surface: surface, destination_app: 'FB', destination_surface: surface, ...destination };
          if (audienceType) candidate.destination_audience_type = audienceType;
          yield candidate;
        }
      }
    }
  }

  async *_mediaShareToFbUnifiedConfigVariants(this: Client): AsyncGenerator<any> {
    yield await this.mediaShareToFbUnifiedConfig();
    yield await this.mediaShareToFbUnifiedConfig([FB_FEED_CROSSPOSTING_SURFACE]);
  }

  /** Resolve a confirmed Facebook Feed destination from unified config. */
  async mediaShareToFbUnifiedDestination(this: Client, cfg: Record<string, any> | null = null): Promise<Record<string, any>> {
    const configs: AsyncIterable<any> | any[] = cfg !== null && cfg !== undefined ? [cfg] : this._mediaShareToFbUnifiedConfigVariants();
    for await (const unifiedConfig of configs as AsyncIterable<any>) {
      for (const candidate of this._mediaShareToFbUnifiedDestinationCandidates(unifiedConfig || {})) {
        try {
          return await this.mediaShareToFbDestination(candidate, null, null, null, false);
        } catch (e) {
          if (e instanceof ClientError) continue;
          throw e;
        }
      }
    }
    if (cfg === null || cfg === undefined) {
      const connectedServicesConfig = await this.mediaShareToFbConnectedServicesConfig();
      for (const candidate of this._fbConnectedServicesDestinationCandidates(connectedServicesConfig, 'FEED')) {
        try {
          return await this.mediaShareToFbDestination(candidate, null, null, null, false);
        } catch (e) {
          if (e instanceof ClientError) continue;
          throw e;
        }
      }
    }
    throw new ClientError('Facebook Feed cross-posting config has no confirmed Facebook destination');
  }

  _crosspostingValidationBypass(this: Client, value: any): string[] | null {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return null;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = [value];
      }
    }
    if (value instanceof Set) value = Array.from(value);
    if (!Array.isArray(value)) value = [value];
    return value.map((item: any) => (typeof item === 'string' ? item : JSON.stringify(item) === undefined ? String(item) : String(item)));
  }

  /** Resolve the Facebook destination used by Feed configure requests. */
  async mediaShareToFbDestination(
    this: Client,
    cfg: Record<string, any> | null = null,
    destinationId: string | null = null,
    destinationType: FbDestinationType | null = null,
    validationBypass: string[] | null = null,
    useUnifiedConfig = true,
  ): Promise<Record<string, any>> {
    const explicitDestination = Boolean(destinationId || destinationType);
    const completeExplicitDestination = Boolean(destinationId && destinationType);
    const hasConnectedServicesRoot = Boolean(cfg && this._crosspostingHasGraphqlRoot(cfg, FB_CONNECTED_SERVICES_ROOT_FIELD));
    if (cfg !== null && cfg !== undefined && hasConnectedServicesRoot && !completeExplicitDestination) {
      for (const candidate of this._fbConnectedServicesDestinationCandidates(cfg, 'FEED')) {
        try {
          return await this.mediaShareToFbDestination(candidate, destinationId, destinationType, validationBypass, false);
        } catch (e) {
          if (e instanceof ClientError) continue;
          throw e;
        }
      }
      throw new ClientError('Facebook connected-services config has no eligible Feed destination');
    }
    const hasUnifiedRoot = Boolean(cfg && this._crosspostingHasGraphqlRoot(cfg, FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD));
    if (cfg !== null && cfg !== undefined && hasUnifiedRoot && !completeExplicitDestination) {
      const candidates = Array.from(this._mediaShareToFbUnifiedDestinationCandidates(cfg));
      for (const candidate of candidates) {
        try {
          return await this.mediaShareToFbDestination(candidate, destinationId, destinationType, validationBypass, false);
        } catch (e) {
          if (e instanceof ClientError) continue;
          throw e;
        }
      }
    }
    const fbConfig = cfg || {};
    if (!Object.keys(fbConfig).length && !explicitDestination && useUnifiedConfig) return this.mediaShareToFbUnifiedDestination();
    if (fbConfig.enabled === false || fbConfig.is_account_linked === false) {
      throw new ClientError('Facebook Feed sharing is not enabled or no Facebook account is linked');
    }
    const destId =
      destinationId ||
      this._crosspostingCandidateValue(fbConfig, [
        'share_to_fb_destination_id',
        'obfuscated_identity_id',
        'identity_id',
        'feed_destination_id',
        'crosspost_destination_id',
        'crossposting_destination_id',
        'xpost_destination_id',
        'destination_id',
      ]);
    const destinationTypeValue =
      destinationType ||
      this._crosspostingCandidateValue(fbConfig, [
        'share_to_fb_destination_type',
        'identity_type',
        'crosspost_destination_type',
        'crossposting_destination_type',
        'xpost_destination_type',
        'destination_type',
        'posting_type',
      ]);
    let destinationTypeText = destinationTypeValue !== null && destinationTypeValue !== undefined ? String(destinationTypeValue).toUpperCase() : '';
    if (destinationTypeText.startsWith('FB_')) destinationTypeText = destinationTypeText.slice(3);
    let bypass: any = validationBypass;
    if (bypass === null || bypass === undefined) {
      bypass = this._crosspostingCandidateValue(fbConfig, ['share_to_facebook_validation_bypass', 'validation_bypass']);
    }
    bypass = this._crosspostingValidationBypass(bypass);
    if (!destId) {
      throw new ClientError(
        'Facebook Feed sharing configuration has no destination. Link a Facebook account/page in the Instagram app or pass destination_id.',
      );
    }
    if (!destinationTypeText) {
      throw new ClientError('Facebook Feed sharing configuration has no destination type. Pass destination_type as USER or PAGE.');
    }
    if (destinationTypeText !== 'USER' && destinationTypeText !== 'PAGE') throw new ClientError('Facebook Feed sharing destination type must be USER or PAGE');
    const destination: Record<string, any> = { destination_id: String(destId), destination_type: destinationTypeText };
    if (bypass && bypass.length) destination.validation_bypass = bypass;
    return destination;
  }

  /** Build Feed configure fields for sharing to Facebook. */
  async mediaShareToFbExtraData(
    this: Client,
    cfg: Record<string, any> | null = null,
    destinationId: string | null = null,
    destinationType: FbDestinationType | null = null,
    validationBypass: string[] | null = null,
    attemptId: string | null = null,
  ): Promise<Record<string, any>> {
    const destination = await this.mediaShareToFbDestination(cfg, destinationId, destinationType, validationBypass);
    const data: Record<string, any> = {
      share_to_facebook: '1',
      share_to_fb_destination_id: destination.destination_id,
      share_to_fb_destination_type: destination.destination_type,
      no_token_crosspost: '1',
      attempt_id: attemptId || randomUUID(),
    };
    if (destination.validation_bypass) data.share_to_facebook_validation_bypass = destination.validation_bypass;
    return data;
  }

  /** Get the Threads profile linked to the current Instagram account. */
  async mediaShareToThreadsConfig(this: Client): Promise<any> {
    let result: any;
    try {
      result = await this.privateGraphqlWwwRequest(
        THREADS_LINKED_PROFILE_FRIENDLY_NAME,
        {},
        THREADS_LINKED_PROFILE_CLIENT_DOC_ID,
        config.API_DOMAIN,
        { 'X-Root-Field-Name': THREADS_LINKED_PROFILE_ROOT_FIELD, Priority: 'u=3, i', 'X-FB-RMD': 'state=URL_ELIGIBLE' },
        null,
      );
    } catch (e) {
      if (!(e instanceof ClientGraphqlError)) throw e;
      // Unlinked accounts can reject the current app transport instead of returning a null profile. Preserve the older null response.
      result = await this.privateGraphqlQueryRequest(
        THREADS_LINKED_PROFILE_FRIENDLY_NAME,
        THREADS_LINKED_PROFILE_ROOT_FIELD,
        {},
        THREADS_LINKED_PROFILE_CLIENT_DOC_ID,
        'u=3, i',
        { 'X-FB-RMD': 'state=URL_ELIGIBLE' },
      );
    }
    if (!('status' in result)) result.status = 'ok';
    return result;
  }

  /** Resolve the linked Threads profile used by configure requests. */
  async mediaShareToThreadsDestination(this: Client, cfg: Record<string, any> | null = null, destinationId: string | null = null): Promise<Record<string, any>> {
    let threadsConfig = cfg;
    if ((threadsConfig === null || threadsConfig === undefined) && (destinationId === null || destinationId === undefined)) {
      threadsConfig = await this.mediaShareToThreadsConfig();
    }
    let profile = threadsConfig !== null && threadsConfig !== undefined ? this._crosspostingGraphqlRoot(threadsConfig || {}, THREADS_LINKED_PROFILE_ROOT_FIELD) : {};
    if (!isDict(profile)) profile = {};
    const destId = destinationId || this._crosspostingCandidateValue(profile, ['id', 'strong_id__', 'destination_id', 'obfuscated_identity_id']);
    if (!destId) {
      throw new ClientError(
        'Threads sharing configuration has no linked Threads profile. Link a Threads profile in the Instagram app or pass destination_id.',
      );
    }
    const destination: Record<string, any> = { destination_id: String(destId) };
    for (const key of ['username', 'profile_pic_url']) if (profile[key]) destination[key] = String(profile[key]);
    return destination;
  }

  /** Build configure fields for sharing media to Threads. */
  async mediaShareToThreadsExtraData(
    this: Client,
    cfg: Record<string, any> | null = null,
    destinationId: string | null = null,
    validationBypass: string[] | null = null,
  ): Promise<Record<string, any>> {
    const destination = await this.mediaShareToThreadsDestination(cfg, destinationId);
    const data: Record<string, any> = { share_to_threads: '1', share_to_threads_destination_id: destination.destination_id };
    const bypass = this._crosspostingValidationBypass(validationBypass);
    if (bypass && bypass.length) data.share_to_threads_validation_bypass = bypass;
    return data;
  }

  async _mediaCrosspostingExtraData(this: Client, extraData: Record<string, any> | null = null, opts: CrosspostingOptions = {}): Promise<Record<string, any>> {
    const generated: Record<string, any> = {};
    if (opts.shareToFacebook) {
      Object.assign(generated, await this.mediaShareToFbExtraData(null, opts.fbDestinationId ?? null, opts.fbDestinationType ?? null, opts.fbValidationBypass ?? null));
    }
    if (opts.shareToThreads) {
      Object.assign(generated, await this.mediaShareToThreadsExtraData(null, opts.threadsDestinationId ?? null, opts.threadsValidationBypass ?? null));
    }
    return { ...generated, ...(extraData || {}) };
  }
}
