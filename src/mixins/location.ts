import { LocationNotFound, WrongCursorError } from '../exceptions';
import { extractGuideV1, extractLocation, extractMediaV1 } from '../extractors';
import { Guide, Location, Media } from '../types';
import { parseJson } from '../utils/json';
import { pyInt, pyJsonDumps } from '../utils/serialization';
import { pyAssert } from '../utils/validation';
import type { Client } from '../client';

export const tabKeysV1 = ['ranked', 'recent'] as const;
export type LocationTab = (typeof tabKeysV1)[number];

function positiveId(v: any): boolean {
  if (v === null || v === undefined) return false;
  try {
    return BigInt(String(v)) > 0n;
  } catch {
    return false;
  }
}

/** Helper class to get location */
export class LocationMixin {
  /** Get locations using lat and long */
  async locationSearch(this: Client, lat: number, lng: number): Promise<Location[]> {
    const params = {
      latitude: lat,
      longitude: lng,
      // rankToken=c544eea5-726b-4091-a916-a71a35a76474 - self.uuid?
      // fb_access_token=EAABwzLixnjYBABK2YBFkT...pKrjju4cijEGYtcbIyCSJ0j4ZD
    };
    const result = await this.privateRequest('location_search/', null, { params });
    const locations: Location[] = [];
    for (const venue of result.venues) {
      if (!('lat' in venue)) {
        venue.lat = lat;
        venue.lng = lng;
      }
      locations.push(extractLocation(venue)!);
    }
    return locations;
  }

  /** Get locations using a location name. */
  async locationSearchName(this: Client, name: string): Promise<Location[]> {
    const result = await this.topSearch(name);
    const locations: Location[] = [];
    for (const place of result.places || []) {
      const location = extractLocation(place);
      if (location) locations.push(location);
    }
    return locations;
  }

  /** Resolve a location using its exact pk. */
  async locationSearchPk(this: Client, locationPk: string | number): Promise<Location> {
    const pk = String(locationPk);
    const info = await this.locationInfo(pk);
    if (String(info.pk) === pk && positiveId(info.external_id) && info.external_id_source) return info;
    for (const location of await this.locationSearchName(info.name)) if (String(location.pk) === pk) return location;
    return info;
  }

  /** Smart complete of location (fills lat/lng/external ids) */
  async locationComplete(this: Client, location: Location): Promise<Location> {
    pyAssert(location && typeof location === 'object' && 'name' in location, `Location is wrong "${location}" (${typeof location})`);
    if (location.pk && !location.lat) {
      // search lat and lng
      const info = await this.locationInfo(location.pk);
      location.lat = info.lat;
      location.lng = info.lng;
    }
    if (location.pk && !location.external_id) {
      const resolved = await this.locationSearchPk(location.pk);
      location.external_id = resolved.external_id;
      location.external_id_source = resolved.external_id_source;
    } else if (!location.external_id && location.lat) {
      // search extrernal_id and external_id_source
      const venues = await this.locationSearch(location.lat, location.lng!);
      if (venues.length) {
        location.external_id = venues[0].external_id;
        location.external_id_source = venues[0].external_id_source;
      }
    }
    if (!location.pk && location.external_id) {
      const info = await this.locationInfo(location.external_id);
      if (info.name === location.name || (info.lat === location.lat && info.lng === location.lng)) location.pk = location.external_id;
    }
    return location;
  }

  /** Build correct location data (JSON string) */
  async locationBuild(this: Client, location: Location | null | undefined): Promise<string> {
    if (!location) return '{}';
    if (location.pk && !location.external_id) location = await this.locationSearchPk(location.pk);
    else if (!location.external_id && location.lat) {
      const venues = await this.locationSearch(location.lat, location.lng!);
      if (venues.length) location = venues[0];
    }
    const data = {
      name: location.name,
      address: location.address,
      lat: location.lat,
      lng: location.lng,
      external_source: location.external_id_source,
      facebook_places_id: location.external_id === null || location.external_id === undefined ? null : pyInt(location.external_id),
    };
    return pyJsonDumps(data, true);
  }

  /** Build location id for story sticker tap models. */
  locationStoryStickerId(this: Client, location: Location | null | undefined): string {
    if (!location) return '';
    return String(location.external_id || location.pk || '');
  }

  /** Get a location using location pk */
  async locationInfoV1(this: Client, locationPk: string | number): Promise<Location> {
    const result = await this.privateRequest(`locations/${locationPk}/location_info/`);
    // Sorry, this page isn't available.
    if (!result.name) throw new LocationNotFound({ ...result, location_pk: locationPk });
    // Only the explicit Facebook field identifies its provider. Generic
    // external IDs and explicitly supplied source fields keep their meaning.
    const facebookId = result.facebook_places_id;
    const inferFacebookSource =
      !result.external_id &&
      (typeof facebookId === 'string' || (typeof facebookId === 'number' && Number.isInteger(facebookId))) &&
      !('external_id_source' in result) &&
      !('external_source' in result);
    const location = extractLocation(result)!;
    if (inferFacebookSource && positiveId(location.external_id)) location.external_id_source = 'facebook_places';
    return location;
  }

  /** Get a location using location pk */
  async locationInfo(this: Client, locationPk: string | number): Promise<Location> {
    return this.locationInfoV1(locationPk);
  }

  /** Get chunk of medias for a location and max_id (cursor) by Private Mobile API. Returns [medias, next cursor] */
  async locationMediasV1Chunk(
    this: Client,
    locationPk: string | number,
    maxAmount = 63,
    tabKey: LocationTab = 'ranked',
    maxId: string | null = null,
  ): Promise<[Media[], string | null]> {
    void maxAmount;
    pyAssert((tabKeysV1 as readonly string[]).includes(tabKey), `You must specify one of the options for "tab_key" ${tabKeysV1}`);
    const data: Record<string, any> = { _uuid: this.uuid, session_id: this.clientSessionId, tab: tabKey };
    if (maxId) {
      let decoded: any;
      try {
        decoded = parseJson(Buffer.from(maxId, 'base64').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 3) throw new Error('bad cursor');
      } catch {
        throw new WrongCursorError();
      }
      const [mId, pageId, nmIds] = decoded;
      data.max_id = mId;
      data.page = pageId;
      data.next_media_ids = nmIds;
    }
    const medias: Media[] = [];
    const result = await this.privateRequest(`locations/${locationPk}/sections/`, data);
    let nextMaxId: string | null = null;
    if (result.next_page && result.next_max_id) {
      nextMaxId = Buffer.from(pyJsonDumps([result.next_max_id, result.next_page, result.next_media_ids ?? null])).toString('base64');
    }
    for (const section of result.sections || []) {
      const layoutContent = section.layout_content || {};
      for (const node of layoutContent.medias || []) medias.push(extractMediaV1(node.media));
    }
    return [medias, nextMaxId];
  }

  /** Get medias for a location by Private Mobile API */
  async locationMediasV1(this: Client, locationPk: string | number, amount = 63, tabKey: LocationTab = 'ranked'): Promise<Media[]> {
    pyAssert((tabKeysV1 as readonly string[]).includes(tabKey), `You must specify one of the options for "tab_key" ${tabKeysV1}`);
    let medias: Media[] = [];
    let maxId: string | null = null;
    while (true) {
      let items: Media[];
      [items, maxId] = await this.locationMediasV1Chunk(locationPk, amount, tabKey, maxId);
      medias.push(...items);
      if (amount && medias.length >= amount) break;
      if (!maxId) break;
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Get top medias for a location (Private API) */
  async locationMediasTopV1(this: Client, locationPk: string | number, amount = 21): Promise<Media[]> {
    return this.locationMediasV1(locationPk, amount, 'ranked');
  }

  /** Get top medias for a location */
  async locationMediasTop(this: Client, locationPk: string | number, amount = 27): Promise<Media[]> {
    return this.locationMediasTopV1(locationPk, amount);
  }

  /** Get recent medias for a location (Private API) */
  async locationMediasRecentV1(this: Client, locationPk: string | number, amount = 63): Promise<Media[]> {
    return this.locationMediasV1(locationPk, amount, 'recent');
  }

  /** Get recent medias for a location */
  async locationMediasRecent(this: Client, locationPk: string | number, amount = 63): Promise<Media[]> {
    return this.locationMediasRecentV1(locationPk, amount);
  }

  /** Get guides by location_pk */
  async locationGuidesV1(this: Client, locationPk: string | number): Promise<Guide[]> {
    const pk = BigInt(String(locationPk)).toString();
    const result = await this.privateRequest(`guides/location/${pk}/`);
    return (result.guides || []).map((g: any) => extractGuideV1(g));
  }
}
