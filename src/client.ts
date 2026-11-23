/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { ClientBase, ClientOptions } from './base';
import { PublicRequestMixin, TopSearchesPublicMixin, ProfilePublicMixin } from './mixins/public';
import { PrivateRequestMixin } from './mixins/private';
import { PrivateGraphQLRequestMixin } from './mixins/graphql';
import { LoginMixin, PreLoginFlowMixin, PostLoginFlowMixin } from './mixins/auth';

/**
 * Instagram Private API client (port of instagrapi.Client).
 *
 * All mixin methods are installed on the prototype; the interface merge below gives
 * full typing (`client.userInfo(...)`, `client.directSend(...)`, ...).
 */
// prettier-ignore
export interface Client extends PublicRequestMixin,
  PrivateRequestMixin,
  PrivateGraphQLRequestMixin,
  TopSearchesPublicMixin,
  ProfilePublicMixin,
  LoginMixin,
  PreLoginFlowMixin,
  PostLoginFlowMixin {}

export class Client extends ClientBase {
  constructor(options: ClientOptions = {}) {
    super(options);
  }
}

export const MIXINS = [
  PublicRequestMixin,
  PrivateRequestMixin,
  PrivateGraphQLRequestMixin,
  TopSearchesPublicMixin,
  ProfilePublicMixin,
  LoginMixin,
  PreLoginFlowMixin,
  PostLoginFlowMixin,
];

// Python MRO: the first mixin defining a name wins, so install in reverse order.
for (const mixin of [...MIXINS].reverse()) {
  for (const name of Object.getOwnPropertyNames(mixin.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(Client.prototype, name, Object.getOwnPropertyDescriptor(mixin.prototype, name)!);
  }
}

export default Client;
