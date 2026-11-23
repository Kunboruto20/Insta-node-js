import * as Boom from '@hapi/boom';
export const COAUTHOR_EXTRA_DATA_KEYS = ['invite_coauthor_user_ids', 'invite_coauthor_user_id'] as const;

export function withCoauthorUserIds(
  extraData: Record<string, any> | null | undefined,
  coauthorUserIds: Array<string | number> | null | undefined,
): Record<string, any> {
  const data: Record<string, any> = { ...(extraData || {}) };
  if (coauthorUserIds === null || coauthorUserIds === undefined) return data;
  if (!Array.isArray(coauthorUserIds)) throw Boom.badRequest('coauthorUserIds must be a list of user IDs.');
  for (const key of COAUTHOR_EXTRA_DATA_KEYS) {
    if (key in data) throw Boom.badRequest(`Use either coauthorUserIds or extraData['${key}'], not both.`);
  }
  data.invite_coauthor_user_ids = coauthorUserIds.map((id) => String(id));
  return data;
}
