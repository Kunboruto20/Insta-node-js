import { ClientGraphqlError } from '../exceptions';
import { Note, Track, makeNote, makeUserShort } from '../types';
import { dumps } from '../utils/serialization';
import { pyAssert } from '../utils/validation';
import type { Client } from '../client';

export const INBOX_TRAY_CLIENT_DOC_ID = '26838444193647008103482058049';
export const INBOX_TRAY_FRIENDLY_NAME = 'InboxTrayRequest';
export const INBOX_TRAY_ROOT_FIELD = 'xdt_get_inbox_tray_items';
export const CREATE_INBOX_TRAY_ITEM_CLIENT_DOC_ID = '3510400299951610199199089856';
export const CREATE_INBOX_TRAY_ITEM_FRIENDLY_NAME = 'CreateInboxTrayItemRequest';

export enum NoteAudience {
  MUTUAL_FOLLOWERS = 0,
  CLOSE_FRIENDS = 1,
}

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class NoteMixin {
  _noteAudienceValue(this: Client, audience: NoteAudience): number {
    pyAssert(
      audience === NoteAudience.MUTUAL_FOLLOWERS || audience === NoteAudience.CLOSE_FRIENDS,
      `Invalid audience parameter=${audience} (must be NoteAudience.MUTUAL_FOLLOWERS or NoteAudience.CLOSE_FRIENDS)`,
    );
    return Number(audience);
  }

  _noteFromNoteDict(this: Client, data: Record<string, any>): Note {
    const noteId = data.note_id || data.id;
    const author = data.author || {};
    const userId = String(data.author_id || author.pk || author.id || '');
    const createdAt = Math.trunc(Number(data['1lcreated_at'] || data.created_at || 0));
    let expiresAt = data['1lexpires_at'] || data.expires_at;
    // Inbox tray GraphQL omits expires_at in current web responses; Notes expire after 24 hours.
    if (expiresAt === null || expiresAt === undefined) expiresAt = createdAt + 86400;
    const user = makeUserShort({
      pk: String(author.pk || author.id || userId),
      username: author.username ?? null,
      full_name: author.full_name || '',
      profile_pic_url: author.profile_pic_url ?? null,
      is_private: author.is_private ?? null,
    });
    return makeNote({
      id: String(noteId),
      text: data.text || '',
      user_id: userId,
      user,
      audience: Math.trunc(Number(data.audience ?? 0)),
      created_at: new Date(createdAt * 1000),
      expires_at: new Date(Math.trunc(Number(expiresAt)) * 1000),
      is_emoji_only: Boolean(data.is_emoji_only ?? false),
      has_translation: Boolean(data.has_translation ?? false),
      note_style: Math.trunc(Number(data.note_style ?? 0)),
    });
  }

  _userFromInboxTrayItem(this: Client, item: Record<string, any>, userId: string): Record<string, any> {
    const users = (item.pog_info || {}).pog_users || [];
    for (const user of users) if (String(user.id || user.pk) === String(userId)) return user;
    return users.length ? users[0] : {};
  }

  _noteDictFromInboxTrayItem(this: Client, item: Record<string, any>): Record<string, any> {
    const noteDict: Record<string, any> = { ...(item.note_dict || {}) };
    if (!Object.keys(noteDict).length) return {};
    if (!('note_id' in noteDict)) noteDict.note_id = item.inbox_tray_item_id || item.id;
    const author = noteDict.author || {};
    const userId = String(noteDict.author_id || author.pk || author.id || '');
    if (!Object.keys(author).length) {
      const user = this._userFromInboxTrayItem(item, userId);
      if (Object.keys(user).length) {
        noteDict.author = {
          pk: user.pk || user.id,
          username: user.username,
          full_name: user.full_name || '',
          profile_pic_url: user.profile_pic_url,
          is_private: user.is_private,
        };
      }
    }
    return noteDict;
  }

  _noteDictFromCreateInboxTrayItem(this: Client, result: Record<string, any>): Record<string, any> {
    for (const payload of Object.values(result.data || {}) as any[]) {
      if (!isDict(payload) || !payload.success) continue;
      const item = payload.inbox_tray_item;
      const noteDict = isDict(item) ? item.note_dict : null;
      if (isDict(noteDict) && Object.keys(noteDict).length) return noteDict;
    }
    throw new ClientGraphqlError('Failed to create Note');
  }

  _inboxTrayFromGraphqlResult(this: Client, result: Record<string, any>): Record<string, any> {
    for (const payload of Object.values(result.data || {}) as any[]) if (isDict(payload) && 'inbox_tray_items' in payload) return payload;
    throw new ClientGraphqlError('Failed to retrieve Notes in Direct');
  }

  /** Retrieves Notes in Direct */
  async getNotes(this: Client): Promise<Note[]> {
    const result = await this.privateGraphqlQueryRequest(
      INBOX_TRAY_FRIENDLY_NAME,
      INBOX_TRAY_ROOT_FIELD,
      {
        should_fetch_friend_map_user: true,
        should_fetch_friend_map_entrypoint: false,
        should_fetch_comment_info: false,
        request: { include_quicksnap_pog: false, include_friend_map_pog: false, inbox_tray_item_ids_on_client: [] },
        is_saved_media_on_map_enabled: false,
        is_location_likes_v2_enabled: true,
      },
      INBOX_TRAY_CLIENT_DOC_ID,
      'u=3, i',
    );
    const inboxTray = this._inboxTrayFromGraphqlResult(result);
    const notes: Note[] = [];
    for (const item of inboxTray.inbox_tray_items || []) {
      const noteDict = this._noteDictFromInboxTrayItem(item);
      if (Object.keys(noteDict).length) notes.push(this._noteFromNoteDict(noteDict));
    }
    return notes;
  }

  /** Retrieve a Note for a given username from a notes list. */
  getNoteByUser(this: Client, notes: Note[], username: string): Note | null {
    const u = String(username).toLowerCase();
    for (const note of notes) if (note.user && note.user.username && note.user.username.toLowerCase() === u) return note;
    return null;
  }

  /** Retrieve note text for a given username from a notes list. */
  getNoteTextByUser(this: Client, notes: Note[], username: string): string | null {
    const note = this.getNoteByUser(notes, username);
    return note ? note.text : null;
  }

  /** Updating your Notes last seen */
  async lastSeenUpdateNote(this: Client): Promise<boolean> {
    const result = await this.privateRequest('notes/update_notes_last_seen_timestamp/', { _uuid: this.uuid });
    return (result.status ?? '') === 'ok';
  }

  /** Delete one of your personal notes */
  async deleteNote(this: Client, noteId: string | number): Promise<boolean> {
    const result = await this.privateRequest('notes/delete_note/', { id: noteId, _uuid: this.uuid });
    return (result.status ?? '') === 'ok';
  }

  /** Retrieve music candidates for Instagram Notes (raw music/notes_audio_browser/ response). */
  async notesMusicBrowser(this: Client): Promise<any> {
    const result = await this.privateRequest('music/notes_audio_browser/', { product: 'music_notes', _uuid: this.uuid }, { withSignature: false });
    pyAssert((result.status ?? '') === 'ok', 'Failed to retrieve Notes music');
    return result;
  }

  _createNoteData(this: Client, variables: Record<string, any>): Record<string, any> {
    return {
      client_doc_id: CREATE_INBOX_TRAY_ITEM_CLIENT_DOC_ID,
      method: 'post',
      pretty: 'false',
      format: 'json',
      server_timestamps: 'true',
      fb_api_req_friendly_name: CREATE_INBOX_TRAY_ITEM_FRIENDLY_NAME,
      variables: dumps(variables),
      enable_canonical_naming: 'true',
      enable_canonical_variable_overrides: 'true',
      enable_canonical_naming_ambiguous_type_prefixing: 'true',
      locale: this.locale,
    };
  }

  /** Create personal Note */
  async createNote(this: Client, text: string, audience: NoteAudience = NoteAudience.MUTUAL_FOLLOWERS): Promise<Note> {
    pyAssert(this.userId, 'Login required');
    const audienceValue = this._noteAudienceValue(audience);
    const variables = {
      should_fetch_content_note_stack_video_info: false,
      request: {
        inbox_tray_item_type: 'note',
        audience: audienceValue,
        additional_params: { note_create_params: { text, note_style: 0 } },
      },
    };
    const result = await this.privateGraphqlRequest(this._createNoteData(variables), {
      'X-Root-Field-Name': 'xdt_create_inbox_tray_item',
      'X-GraphQL-Client-Library': 'pando',
    });
    return this._noteFromNoteDict(this._noteDictFromCreateInboxTrayItem(result));
  }

  /** Create personal Note with attached music (track from notesMusicBrowser() or a compatible dict). */
  async createMusicNote(
    this: Client,
    track: Track | Record<string, any>,
    text = '',
    audience: NoteAudience = NoteAudience.MUTUAL_FOLLOWERS,
    startTime: number | null = null,
    duration = 30000,
    browseSessionId: string | null = null,
    alacornSessionId: string | null = null,
  ): Promise<Note> {
    pyAssert(this.userId, 'Login required');
    const audienceValue = this._noteAudienceValue(audience);
    const audioAssetId = this._trackValue(track, 'audio_asset_id') || this._trackValue(track, 'id');
    const audioClusterId = this._trackValue(track, 'audio_cluster_id');
    pyAssert(audioAssetId, 'track.audio_asset_id or track.id is required');
    pyAssert(audioClusterId, 'track.audio_cluster_id is required');
    if (startTime === null || startTime === undefined) startTime = this._trackHighlightStart(track);
    if (!browseSessionId) browseSessionId = this.generateUuid();
    if (!alacornSessionId) alacornSessionId = (await this.notesMusicBrowser()).alacorn_session_id;
    pyAssert(alacornSessionId, 'alacorn_session_id is required');
    const variables = {
      should_fetch_content_note_stack_video_info: false,
      request: {
        inbox_tray_item_type: 'note',
        audience: audienceValue,
        additional_params: {
          note_create_params: {
            text,
            note_style: 1,
            note_create_info: {
              music_note_create_info: {
                start_time: Math.trunc(startTime),
                is_reshare_eligible: false,
                selected_lyrics: null,
                audio_asset_id: String(audioAssetId),
                duration: Math.trunc(duration),
                original_note_id: null,
                original_author_id: null,
                audio_cluster_id: String(audioClusterId),
                browse_session_id: browseSessionId,
                alacorn_session_id: alacornSessionId,
              },
            },
          },
        },
      },
    };
    const result = await this.privateGraphqlRequest(this._createNoteData(variables), {
      'X-Root-Field-Name': 'xdt_create_inbox_tray_item',
      'X-GraphQL-Client-Library': 'pando',
    });
    return this._noteFromNoteDict(this._noteDictFromCreateInboxTrayItem(result));
  }
}
