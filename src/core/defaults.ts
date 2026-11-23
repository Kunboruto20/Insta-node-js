export const API_DOMAIN = 'i.instagram.com';

// Instagram 449.0.0.52.84
// Android (34/14;
// 480dpi; 1344x2992; Google/google;
// Pixel 8 Pro; husky; husky; en_US; 1079242191)
export const USER_AGENT_BASE =
  'Instagram {app_version} ' +
  'Android ({android_version}/{android_release}; ' +
  '{dpi}; {resolution}; {manufacturer}; ' +
  '{model}; {device}; {cpu}; {locale}; {version_code})';

export interface DeviceSettings {
  android_version?: number;
  android_release?: string;
  dpi?: string;
  resolution?: string;
  manufacturer?: string;
  device?: string;
  model?: string;
  cpu?: string;
  app_version?: string;
  version_code?: string;
  bloks_versioning_id?: string;
  [key: string]: any;
}

// Default device profile (hardware/system) and app version settings.
export const DEVICE_SETTINGS: DeviceSettings = {
  android_version: 34,
  android_release: '14',
  dpi: '480dpi',
  resolution: '1344x2992',
  manufacturer: 'Google/google',
  device: 'husky',
  model: 'Pixel 8 Pro',
  cpu: 'husky',
};

export const DEFAULT_APP_VERSION = '449.0.0.52.84';

export interface AppSettings {
  app_version: string;
  version_code: string;
  bloks_versioning_id: string;
}

export const APP_SETTINGS: Record<string, AppSettings> = {
  [DEFAULT_APP_VERSION]: {
    app_version: DEFAULT_APP_VERSION,
    version_code: '1079242191',
    bloks_versioning_id: '799db3e387d7a21a19c72918b8698b6cd28a1516ade363792c100ed45a0f9f0b',
  },
  '448.0.0.0.20': {
    app_version: '448.0.0.0.20',
    version_code: '1065560286',
    bloks_versioning_id: '0bc46a03e177bfc9bc8d611918815acf248fa9c77754d807d6a5951dc9ce9432',
  },
  '446.0.0.49.77': {
    app_version: '446.0.0.49.77',
    version_code: '385211303',
    bloks_versioning_id: '935a519904e9017324cdedb64a283a3c2c1a3d5b0bbc698b451f5aef72cc11df',
  },
  '428.0.0.47.67': {
    app_version: '428.0.0.47.67',
    version_code: '961145276',
    bloks_versioning_id: '7189b949425f9bf80ea8bd880cf5a3080b292d9b1c4b38a18d112f7c4b71e7a8',
  },
  '364.0.0.35.86': {
    app_version: '364.0.0.35.86',
    version_code: '374010953',
    bloks_versioning_id: '8ccf54aad76788a6ca03ddfc33afcdcf692f2f5a3ba814ea73d5facba7fa2c2d',
  },
  '385.0.0.47.74': {
    app_version: '385.0.0.47.74',
    version_code: '378906843',
    bloks_versioning_id: 'a8973d49a9cc6a6f65a4997c10216ce2a06f65a517010e64885e92029bb19221',
  },
};

// Instagram 76.0.0.15.395 (iPhone9,2; iOS 10_0_2; en_US; en-US; scale=2.61; 1080x1920) AppleWebKit/420+
// Instagram 208.0.0.32.135 (iPhone; iOS 14_7_1; en_US; en-US; scale=2.61; 1080x1920) AppleWebKit/605.1.15

export const SOFTWARE = '{model}-user+{android_release}+OPR1.170623.032+V10.2.3.0.OAGMIXM+release-keys';

export const LOGIN_EXPERIMENTS =
  'ig_android_reg_nux_headers_cleanup_universe,' +
  'ig_android_device_detection_info_upload,' +
  'ig_android_nux_add_email_device,' +
  'ig_android_gmail_oauth_in_reg,' +
  'ig_android_device_info_foreground_reporting,' +
  'ig_android_device_verification_fb_signup,' +
  'ig_android_direct_main_tab_universe_v2,' +
  'ig_android_passwordless_account_password_creation_universe,' +
  'ig_android_direct_add_direct_to_android_native_photo_share_sheet,' +
  'ig_growth_android_profile_pic_prefill_with_fb_pic_2,' +
  'ig_account_identity_logged_out_signals_global_holdout_universe,' +
  'ig_android_quickcapture_keep_screen_on,' +
  'ig_android_device_based_country_verification,' +
  'ig_android_login_identifier_fuzzy_match,' +
  'ig_android_reg_modularization_universe,' +
  'ig_android_security_intent_switchoff,' +
  'ig_android_device_verification_separate_endpoint,' +
  'ig_android_suma_landing_page,' +
  'ig_android_sim_info_upload,' +
  'ig_android_smartlock_hints_universe,' +
  'ig_android_fb_account_linking_sampling_freq_universe,' +
  'ig_android_retry_create_account_universe,' +
  'ig_android_caption_typeahead_fix_on_o_universe';

export const SUPPORTED_CAPABILITIES = [
  {
    value:
      '119.0,120.0,121.0,122.0,123.0,124.0,125.0,126.0,127.0,128.0,' +
      '129.0,130.0,131.0,132.0,133.0,134.0,135.0,136.0,137.0,138.0,' +
      '139.0,140.0,141.0,142.0',
    name: 'SUPPORTED_SDK_VERSIONS',
  },
  { value: '14', name: 'FACE_TRACKER_VERSION' },
  { value: 'ETC2_COMPRESSION', name: 'COMPRESSION' },
  { value: 'gyroscope_enabled', name: 'gyroscope' },
];

/** Replace `{name}` placeholders with values from `data`. */
import * as Boom from '@hapi/boom';
export function formatTemplate(template: string, data: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in data)) throw Boom.badRequest(`Missing template value: ${key}`);
    return String(data[key]);
  });
}
