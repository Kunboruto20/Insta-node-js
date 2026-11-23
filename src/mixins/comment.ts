import { ClientError, ClientNotFoundError, CommentNotFound, MediaNotFound } from '../exceptions';
import { extractComment } from '../extractors';
import { Comment } from '../types';
import { generateJazoest } from '../utils/auth';
import { dumps } from '../utils/serialization';
import { ensure } from '../utils/validation';
import { GQL_STUFF } from './graphql';
import type { Client } from '../client';

export const MEDIA_COMMENTS_DOC_ID = '6974885689225067';

function firstCommentsKey(data: Record<string, any>): string | null {
  let key: string | null = null;
  for (key of Object.keys(data)) if (key.includes('comments')) break;
  return key;
}

/** Helpers for managing comments on a Media */
export class CommentMixin {
  _mediaNotFoundWrap(this: Client, e: unknown, mediaId: string): never {
    if (e instanceof ClientNotFoundError) throw new MediaNotFound(e, { ...this.lastJson, media_id: mediaId });
    if (e instanceof ClientError && String(e.message).includes('Media not found')) throw new MediaNotFound(e, { ...this.lastJson, media_id: mediaId });
    throw e;
  }

  /** Get threaded comments on a media. Returns [comments, end_cursor] */
  async mediaCommentsThreadedGqlChunk(this: Client, mediaPk: string | number, commentPk: string | number, endCursor = ''): Promise<[any[], string | null]> {
    const docId = '7171917939589632';
    const comments: any[] = [];
    const pk = String(this.mediaPk(mediaPk));
    const variables = {
      after: endCursor || null,
      before: null,
      first: 50,
      last: null,
      media_id: pk,
      parent_comment_id: String(commentPk),
      is_chronological: null,
    };
    const data = {
      variables: dumps(variables),
      doc_id: docId,
      fb_dtsg: await this.getFbDtsg(),
      jazoest: generateJazoest(this.phoneId),
      ...GQL_STUFF,
    };
    const resp = await this.graphqlRequest({ data });
    const respData = resp.data;
    if (respData && Object.keys(respData).length) {
      const key = firstCommentsKey(respData)!;
      const item = respData[key];
      const edges = item.edges || [];
      if (!edges.length) throw new CommentNotFound({ ...respData });
      for (const edge of edges) comments.push(edge.node);
      const pageInfo = item.page_info || {};
      return [comments, pageInfo.has_next_page ? pageInfo.end_cursor ?? null : null];
    }
    return [[], ''];
  }

  /** Get threaded comments on a media */
  async mediaCommentsThreadedGql(this: Client, mediaPk: string | number, commentPk: string | number, amount = 0): Promise<any[]> {
    let endCursor: string | null = '';
    let comments: any[] = [];
    while (true) {
      let items: any[];
      [items, endCursor] = await this.mediaCommentsThreadedGqlChunk(mediaPk, commentPk, endCursor || '');
      comments.push(...items);
      if (!endCursor || items.length === 0) break;
      if (amount && comments.length >= amount) break;
    }
    if (amount) comments = comments.slice(0, amount);
    return comments;
  }

  /** Get comments on a media (public doc_id GraphQL). Returns [comments, end_cursor] */
  async mediaCommentsGqlChunk(this: Client, mediaPk: string | number, endCursor = ''): Promise<[any[], string]> {
    const pk = String(this.mediaPk(mediaPk));
    const shortcode = this.mediaCodeFromPk(pk);
    const comments: any[] = [];
    const variables = { after: endCursor || null, before: null, first: 50, last: null, media_id: pk, sort_order: 'popular' };
    const data = await this.publicDocIdGraphqlRequest(MEDIA_COMMENTS_DOC_ID, variables, { referer: `https://www.instagram.com/p/${shortcode}/` });
    if (data && Object.keys(data).length) {
      const key = firstCommentsKey(data)!;
      const item = data[key];
      for (const edge of item.edges || []) comments.push(edge.node);
      const pageInfo = item.page_info || {};
      return [comments, pageInfo.has_next_page ? String(pageInfo.end_cursor || '') : ''];
    }
    return [[], ''];
  }

  /** Get comments on a media (public GraphQL) */
  async mediaCommentsGql(this: Client, mediaPk: string | number, amount = 50, maxRequests = 0): Promise<any[]> {
    const pk = this.mediaPk(mediaPk);
    let endCursor = '';
    let comments: any[] = [];
    let i = 0;
    while (true) {
      i += 1;
      if (maxRequests && i > maxRequests) break;
      let items: any[];
      [items, endCursor] = await this.mediaCommentsGqlChunk(pk, endCursor);
      comments.push(...items);
      if (!endCursor || items.length === 0) break;
      if (amount && comments.length >= amount) break;
    }
    if (amount) comments = comments.slice(0, amount);
    return comments;
  }

  /** Get one public GraphQL comments page by media shortcode. */
  async mediaCommentsPublicGqlChunk(this: Client, code: string, endCursor = ''): Promise<[any[], string]> {
    return this.mediaCommentsGqlChunk(this.mediaPkFromCode(code), endCursor);
  }

  /** Get public GraphQL comments by media shortcode. */
  async mediaCommentsPublicGql(this: Client, code: string, amount = 50, maxRequests = 0): Promise<any[]> {
    return this.mediaCommentsGql(this.mediaPkFromCode(code), amount, maxRequests);
  }

  /** Get stream comments on a media. Returns [comments, min_id, max_id] */
  async mediaStreamCommentsV1Chunk(this: Client, mediaId: string, minId = '', maxId = ''): Promise<[Comment[], string, string]> {
    const params: Record<string, any> = {
      can_support_threading: 'true',
      inventory_source: 'explore_story',
      analytics_module: 'comments_v2_feed_timeline',
      is_carousel_bumped_post: 'false',
      feed_position: '1',
    };
    if (minId) params.min_id = minId;
    if (maxId) params.max_id = maxId;
    const result = await this.privateRequest(`media/${mediaId}/stream_comments/`, null, { params });
    const comments: Comment[] = [];
    const rows = result.stream_rows && result.stream_rows.length ? result.stream_rows : [result];
    for (const row of rows) for (const c of row.comments) comments.push(extractComment(c));
    return [comments, result.next_min_id || (result.min_id ?? ''), result.next_max_id || (result.max_id ?? '')];
  }

  /** Bulk-fetch comment summaries for one or more media items. */
  async mediaCommentInfos(this: Client, mediaIds: Array<string | number> | string): Promise<any> {
    const joined = Array.isArray(mediaIds) ? mediaIds.map(String).join(',') : String(mediaIds);
    return this.privateRequest('media/comment_infos/', null, { params: { can_support_carousel_mentions: 'false', media_ids: joined } });
  }

  /** Get comments on a media by Private Mobile API. Returns [comments, min_id, max_id] */
  async mediaCommentsV1Chunk(this: Client, mediaId: string, minId: string | null = '', maxId: string | null = ''): Promise<[Comment[], string, string]> {
    const params: Record<string, any> = { can_support_threading: 'true', permalink_enabled: 'false' };
    if (minId) params.min_id = minId;
    if (maxId) params.max_id = maxId;
    const result = await this.privateRequest(`media/${mediaId}/comments/`, null, { params });
    const comments = (result.comments || []).map((c: any) => extractComment(c));
    return [comments, result.next_min_id || (result.min_id ?? ''), result.next_max_id || (result.max_id ?? '')];
  }

  /** Get comments on a media by Private Mobile API. */
  async mediaCommentsV1(this: Client, mediaId: string, amount = 20): Promise<Comment[]> {
    let comments: Comment[] = [];
    let minId: string | null = null;
    let maxId: string | null = null;
    try {
      while (true) {
        let items: Comment[];
        [items, minId, maxId] = await this.mediaCommentsV1Chunk(mediaId, minId, maxId);
        comments.push(...items);
        if (items.length === 0) break;
        if (amount && comments.length > amount) break;
      }
    } catch (e) {
      this._mediaNotFoundWrap(e, mediaId);
    }
    if (amount) comments = comments.slice(0, amount);
    return comments;
  }

  /** Get comments on a media (amount=0 → all) */
  async mediaComments(this: Client, mediaId: string | number, amount = 20): Promise<Comment[]> {
    // TODO: to public or private
    const id = await this.mediaId(mediaId);
    let comments: Comment[] = [];
    const getComments = (result: any) => {
      if (result.comments && result.comments.length) for (const c of result.comments) comments.push(extractComment(c));
    };
    let params: Record<string, any> | null = null;
    // NOTE: `params` is sent as the request body
    let result = await this.privateRequest(`media/${id}/comments/`, params);
    getComments(result);
    while ((result.has_more_comments && result.next_max_id) || (result.has_more_headload_comments && result.next_min_id)) {
      try {
        if (result.has_more_comments) params = { max_id: result.next_max_id };
        else params = { min_id: result.next_min_id };
        if (!(result.next_max_id || result.next_min_id || (result.comments && result.comments.length))) break;
        result = await this.privateRequest(`media/${id}/comments/`, params);
        getComments(result);
      } catch (e) {
        this._mediaNotFoundWrap(e, id);
      }
      if (amount && comments.length >= amount) break;
    }
    if (amount) comments = comments.slice(0, amount);
    return comments;
  }

  /** Get chunk of comments on a media and next min_id. Returns [comments, next_min_id] */
  async mediaCommentsChunk(this: Client, mediaId: string | number, maxAmount: number, minId: string | null = null): Promise<[Comment[], string | null]> {
    const id = await this.mediaId(mediaId);
    const comments: Comment[] = [];
    const getComments = (result: any) => {
      if (result.comments && result.comments.length) for (const c of result.comments) comments.push(extractComment(c));
    };
    let params: Record<string, any> | null = minId ? { min_id: minId } : null;
    let result = await this.privateRequest(`media/${id}/comments/`, params);
    getComments(result);
    while (result.has_more_headload_comments && result.next_min_id) {
      try {
        params = { min_id: result.next_min_id };
        if (!(result.next_min_id || (result.comments && result.comments.length))) break;
        result = await this.privateRequest(`media/${id}/comments/`, params);
        getComments(result);
      } catch (e) {
        this._mediaNotFoundWrap(e, id);
      }
      if (comments.length >= maxAmount) break;
    }
    return [comments, result.next_min_id ?? null];
  }

  /** Get replies for a media comment (amount=0 → all) */
  async mediaCommentReplies(this: Client, mediaId: string | number, commentId: string | number, amount = 0): Promise<Comment[]> {
    const id = await this.mediaId(mediaId);
    const cid = String(commentId);
    let params: Record<string, any> | null = null;
    let replies: Comment[] = [];
    while (true) {
      let result: any;
      try {
        result = await this.privateRequest(`media/${id}/comments/${cid}/inline_child_comments/`, params);
      } catch (e) {
        this._mediaNotFoundWrap(e, id);
      }
      replies.push(...(result.child_comments || []).map((c: any) => extractComment(c)));
      if (amount && replies.length >= amount) break;
      if (!(result.has_more_head_child_comments && result.next_min_child_cursor)) break;
      params = { min_id: result.next_min_child_cursor };
    }
    if (amount) replies = replies.slice(0, amount);
    return replies;
  }

  /** Get one chunk of replies for a media comment and next cursor. Returns [replies, next_min_child_cursor] */
  async mediaCommentRepliesChunk(
    this: Client,
    mediaId: string | number,
    commentId: string | number,
    maxAmount: number,
    minId: string | null = null,
  ): Promise<[Comment[], string | null]> {
    const id = await this.mediaId(mediaId);
    const cid = String(commentId);
    const params = minId ? { min_id: minId } : null;
    let result: any;
    try {
      result = await this.privateRequest(`media/${id}/comments/${cid}/inline_child_comments/`, params);
    } catch (e) {
      this._mediaNotFoundWrap(e, id);
    }
    const replies = (result.child_comments || []).map((c: any) => extractComment(c)).slice(0, maxAmount);
    return [replies, result.next_min_child_cursor ?? null];
  }

  /** Post a comment on a media (optionally as reply to repliedToCommentId) */
  async mediaComment(this: Client, mediaId: string | number, text: string, repliedToCommentId: string | number | null = null): Promise<Comment> {
    ensure(this.userId, 'Login required');
    const id = await this.mediaId(mediaId);
    const idempotenceToken = this.generateUuid();
    const data: Record<string, any> = {
      delivery_class: 'organic',
      feed_position: String(Math.floor(Math.random() * 7)),
      container_module: 'feed_timeline',
      media_id: id,
      _uid: String(this.userId),
      tap_source: 'button',
      is_2m_enabled: 'false',
      is_carousel_bumped_post: 'false',
      is_from_swipe: 'false',
      floating_context_items: '[]',
      media_pct_watched: '0',
      user_breadcrumb: this.genUserBreadcrumb(text.length),
      idempotence_token: idempotenceToken,
      comment_creation_key: idempotenceToken,
      include_e2ee_mentioned_user_list: 'true',
      include_media_code: 'true',
      comment_text: text,
    };
    if (repliedToCommentId) {
      const n = BigInt(String(repliedToCommentId));
      data.replied_to_comment_id = Number.isSafeInteger(Number(n)) ? Number(n) : n;
    }
    const result = await this.privateRequest(`media/${id}/comment/`, this.withActionData(data));
    return extractComment(result.comment);
  }

  /** Checks if a comment text is offensive */
  async mediaCheckOffensiveComment(this: Client, mediaId: string | number, text: string): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = await this.mediaId(mediaId);
    const data = {
      // _uid, comment_session_id are not in this body?
      media_id: id,
      comment_text: text,
    };
    const result = await this.privateRequest('media/comment/check_offensive_comment/', this.withActionData(data));
    return result.is_offensive;
  }

  /** Lighter-weight variant of mediaCheckOffensiveComment — returns the full IG payload. */
  async mediaCheckOffensiveCommentV2(this: Client, mediaId: string, comment: string): Promise<any> {
    ensure(this.userId, 'Login required');
    return this.privateRequest('media/comment/check_offensive_comment/', { comment_text: comment, media_id: mediaId, _uuid: this.uuid });
  }

  /** Like a comment on a media (revert=true to unlike) */
  async commentLike(this: Client, commentPk: string | number, revert = false): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const pk = BigInt(String(commentPk)).toString();
    const data = {
      is_carousel_bumped_post: 'false',
      container_module: 'feed_contextual_self_profile',
      feed_position: String(Math.floor(Math.random() * 7)),
    };
    const name = revert ? 'unlike' : 'like';
    const result = await this.privateRequest(`media/${pk}/comment_${name}/`, this.withActionData(data));
    return result.status === 'ok';
  }

  /** Unlike a comment on a media */
  async commentUnlike(this: Client, commentPk: string | number): Promise<boolean> {
    return this.commentLike(commentPk, true);
  }

  /** Pin a comment on a media (revert=true to unpin) */
  async commentPin(this: Client, mediaId: string, commentPk: string | number, revert = false): Promise<boolean> {
    const data = this.withActionData({ _uid: this.userIdInt, _uuid: this.uuid });
    const name = revert ? 'unpin' : 'pin';
    const result = await this.privateRequest(`media/${mediaId}/${name}_comment/${commentPk}/`, data);
    return result.status === 'ok';
  }

  /** Unpin a comment on a media */
  async commentUnpin(this: Client, mediaId: string, commentPk: string | number): Promise<boolean> {
    return this.commentPin(mediaId, commentPk, true);
  }

  /** Delete comments on a media */
  async commentBulkDelete(this: Client, mediaId: string | number, commentPks: Array<string | number>): Promise<boolean> {
    const id = await this.mediaId(mediaId);
    const data = { comment_ids_to_delete: commentPks.map(String).join(','), container_module: 'self_comments_v2_newsfeed_you' };
    const result = await this.privateRequest(`media/${id}/comment/bulk_delete/`, this.withActionData(data));
    return result.status === 'ok';
  }

  /** Get users who liked a comment through the private mobile API. */
  async commentLikersV1(this: Client, commentPk: string | number, amount = 0): Promise<any[]> {
    const result = await this.privateRequest(`media/${commentPk}/comment_likers/`);
    const users = result.users || [];
    return amount ? users.slice(0, amount) : users;
  }

  /** Get users who liked a comment through the private mobile API. */
  async commentLikers(this: Client, commentPk: string | number, amount = 0): Promise<any[]> {
    return this.commentLikersV1(commentPk, amount);
  }

  /** Get likers of comment (public GraphQL). Returns [likers, end_cursor] */
  async commentLikersGqlChunk(this: Client, commentPk: string | number, endCursor = ''): Promise<[any[], string | null]> {
    const pk = String(commentPk);
    this.injectSessionidToPublic();
    const likers: any[] = [];
    const variables: Record<string, any> = { comment_id: pk, first: 50 };
    if (endCursor) variables.after = endCursor;
    const data = await this.publicGraphqlRequest(variables, { queryHash: '5f0b1f6281e72053cbc07909c8d154ae' });
    const comment = data.comment || {};
    const edgeLikedBy = comment.edge_liked_by || {};
    for (const edge of edgeLikedBy.edges || []) likers.push(edge.node);
    let cursor: string | null = '';
    if ('page_info' in edgeLikedBy) {
      const pageInfo = edgeLikedBy.page_info;
      cursor = pageInfo.has_next_page ? pageInfo.end_cursor : null;
    }
    return [likers, cursor];
  }

  /** Get likers of comment (public GraphQL) */
  async commentLikersGql(this: Client, commentPk: string | number, amount = 0): Promise<any[]> {
    let endCursor: string | null = '';
    let likers: any[] = [];
    while (true) {
      let items: any[];
      [items, endCursor] = await this.commentLikersGqlChunk(commentPk, endCursor || '');
      likers.push(...items);
      if (!endCursor || items.length === 0) break;
      if (amount && likers.length >= amount) break;
    }
    if (amount) likers = likers.slice(0, amount);
    return likers;
  }
}
