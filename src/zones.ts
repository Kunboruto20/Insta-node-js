/** Timezone helpers (port of instagrapi.zones). Offsets in hours. */
export const CET = { utcoffset: () => 1, dst: () => 2 };
export const UTC = { utcoffset: () => 0, dst: () => 0 };
