import type { Client } from '../core/instaClient';

/** Helpers for the fundraisers. */
export class FundraiserFeature {
  /** Get fundraiser info. */
  async standaloneFundraiserInfoV1(this: Client, userId: string | number): Promise<any> {
    userId = String(userId);
    return this.privateRequest(`fundraiser/${userId}/standalone_fundraiser_info/`);
  }
}
