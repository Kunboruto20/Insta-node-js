import { pyAssert } from '../utils/validation';
import type { Client } from '../client';

export const MUTE_ALL_ITEMS = ['cancel', '15_minutes', '1_hour', '2_hour', '4_hour', '8_hour'] as const;
export const SETTING_VALUE_ITEMS = ['off', 'following_only', 'everyone'] as const;
export type MUTE_ALL = (typeof MUTE_ALL_ITEMS)[number];
export type SETTING_VALUE = (typeof SETTING_VALUE_ITEMS)[number];
export type NotificationSettingValue = SETTING_VALUE | MUTE_ALL;
export type NotificationContentType =
  | 'mute_all'
  | 'likes'
  | 'like_and_comment_on_photo_user_tagged'
  | 'user_tagged'
  | 'comments'
  | 'comment_likes'
  | 'first_post'
  | 'new_follower'
  | 'follow_request_accepted'
  | 'connection_notification'
  | 'tagged_in_bio'
  | 'pending_direct_share'
  | 'direct_share_activity'
  | 'direct_group_requests'
  | 'video_call'
  | 'rooms'
  | 'live_broadcast'
  | 'felix_upload_result'
  | 'view_count'
  | 'fundraiser_creator'
  | 'fundraiser_supporter'
  | 'notification_reminders'
  | 'announcements'
  | 'report_updated'
  | 'login_notification';

/** Helpers for notification settings */
export class NotificationMixin {
  async notificationSettings(this: Client, contentType: NotificationContentType, settingValue: NotificationSettingValue): Promise<boolean> {
    const data = { content_type: contentType, setting_value: settingValue, _uid: String(this.userId), _uuid: this.uuid };
    const result = await this.privateRequest('notifications/change_notification_settings/', data);
    return result.status === 'ok';
  }

  /** Disable All Notification */
  async notificationDisable(this: Client): Promise<boolean> {
    const notifications = ['notificationLikes', 'notificationLikeAndCommentOnPhotoUserTagged', 'notificationUserTagged', 'notificationComments', 'notificationCommentLikes', 'notificationFirstPost', 'notificationNewFollower', 'notificationFollowRequestAccepted', 'notificationConnection', 'notificationTaggedInBio', 'notificationPendingDirectShare', 'notificationDirectShareActivity', 'notificationDirectGroupRequests', 'notificationVideoCall', 'notificationRooms', 'notificationLiveBroadcast', 'notificationFelixUploadResult', 'notificationViewCount', 'notificationFundraiserCreator', 'notificationFundraiserSupporter', 'notificationReminders', 'notificationAnnouncements', 'notificationReportUpdated', 'notificationLogin'] as const;
    for (const name of notifications) if (!(await (this as any)[name]('off'))) return false;
    return true;
  }

  /** Manage Mute All Notification Settings */
  async notificationMuteAll(this: Client, settingValue: MUTE_ALL = '8_hour'): Promise<boolean> {
    pyAssert((MUTE_ALL_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${MUTE_ALL_ITEMS}`);
    return this.notificationSettings('mute_all', settingValue);
  }

  /** Manage Likes Notification Settings */
  async notificationLikes(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('likes', settingValue);
  }

  /** Manage Like And Comment On Photo User Tagged Settings */
  async notificationLikeAndCommentOnPhotoUserTagged(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('like_and_comment_on_photo_user_tagged', settingValue);
  }

  /** Manage User Tagged NotificationSettings */
  async notificationUserTagged(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('user_tagged', settingValue);
  }

  /** Manage Comments Notification Settings */
  async notificationComments(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('comments', settingValue);
  }

  /** Manage Comment Likes Notification Settings */
  async notificationCommentLikes(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('comment_likes', settingValue);
  }

  /** Manage First Post Notification Settings */
  async notificationFirstPost(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('first_post', settingValue);
  }

  /** Manage New Follower Notification Settings */
  async notificationNewFollower(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('new_follower', settingValue);
  }

  /** Manage Follow Request Accepted Notification Settings */
  async notificationFollowRequestAccepted(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('follow_request_accepted', settingValue);
  }

  /** Manage Connection Notification Settings */
  async notificationConnection(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('connection_notification', settingValue);
  }

  /** Manage Tagged In Bio Notification Settings */
  async notificationTaggedInBio(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('tagged_in_bio', settingValue);
  }

  /** Manage Pending Direct Share Notification Settings */
  async notificationPendingDirectShare(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('pending_direct_share', settingValue);
  }

  /** Manage Direct Share Activity Notification Settings */
  async notificationDirectShareActivity(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('direct_share_activity', settingValue);
  }

  /** Manage Direct Group Requests Notification Settings */
  async notificationDirectGroupRequests(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('direct_group_requests', settingValue);
  }

  /** Manage Video Call Notification Settings */
  async notificationVideoCall(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('video_call', settingValue);
  }

  /** Manage Rooms Notification Settings */
  async notificationRooms(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('rooms', settingValue);
  }

  /** Manage Live Broadcast Notification Settings */
  async notificationLiveBroadcast(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('live_broadcast', settingValue);
  }

  /** Manage Felix Upload Result Notification Settings */
  async notificationFelixUploadResult(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('felix_upload_result', settingValue);
  }

  /** Manage View Count Notification Settings */
  async notificationViewCount(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('view_count', settingValue);
  }

  /** Manage Fundraiser Creator Notification Settings */
  async notificationFundraiserCreator(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('fundraiser_creator', settingValue);
  }

  /** Manage Fundraiser Supporter Notification Settings */
  async notificationFundraiserSupporter(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('fundraiser_supporter', settingValue);
  }

  /** Manage Notification Reminders Settings */
  async notificationReminders(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('notification_reminders', settingValue);
  }

  /** Manage Announcements Notification Settings */
  async notificationAnnouncements(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('announcements', settingValue);
  }

  /** Manage Report Updated Notification Settings */
  async notificationReportUpdated(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('report_updated', settingValue);
  }

  /** Manage Login Notification Settings */
  async notificationLogin(this: Client, settingValue: SETTING_VALUE = 'off'): Promise<boolean> {
    pyAssert((SETTING_VALUE_ITEMS as readonly string[]).includes(settingValue), `Unsupported setting_value="${settingValue}" ${SETTING_VALUE_ITEMS}`);
    return this.notificationSettings('login_notification', settingValue);
  }
}
