import * as Boom from '@hapi/boom';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { FFMPEG_INSTALL_MESSAGE, FfmpegUnavailableError, ffmpeg, probe } from './ffmpeg';

export { FFMPEG_INSTALL_MESSAGE };
export const FFMPEG_HINT_MESSAGE = `${FFMPEG_INSTALL_MESSAGE} Make sure ffmpeg is executable or set FFMPEG_PATH.`;
export const THUMBNAIL_FFMPEG_MESSAGE = `Could not generate video thumbnail. Pass thumbnail=... or install ffmpeg. ${FFMPEG_HINT_MESSAGE}`;
export const METADATA_FFMPEG_MESSAGE =
  'Could not read video metadata with the MP4 parser and ffmpeg/ffprobe is unavailable. ' +
  `Use a standard MP4 file, or install ffmpeg. ${FFMPEG_HINT_MESSAGE}`;

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
}

interface TrackMetadata {
  width: number | null;
  height: number | null;
  duration: number | null;
  handlerType: string | null;
}

function* iterBoxes(data: Buffer): Generator<[string, Buffer]> {
  let pos = 0;
  const end = data.length;
  while (pos + 8 <= end) {
    let size = data.readUInt32BE(pos);
    const boxType = data.toString('latin1', pos + 4, pos + 8);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) throw Boom.badData('Invalid MP4 box with incomplete extended size');
      size = Number(data.readBigUInt64BE(pos + 8));
      headerSize = 16;
    } else if (size === 0) size = end - pos;
    if (size < headerSize || pos + size > end) throw Boom.badData('Invalid MP4 box size');
    const boxEnd = pos + size;
    yield [boxType, data.subarray(pos + headerSize, boxEnd)];
    pos = boxEnd;
  }
}

function readMoov(file: string): Buffer {
  const fileSize = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    let pos = 0;
    const header = Buffer.alloc(16);
    while (pos + 8 <= fileSize) {
      const boxStart = pos;
      if (readSync(fd, header, 0, 8, pos) < 8) break;
      let size = header.readUInt32BE(0);
      const boxType = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (readSync(fd, header, 8, 8, pos + 8) < 8) throw Boom.badData('Invalid MP4 box with incomplete extended size');
        size = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) size = fileSize - boxStart;
      if (size < headerSize || boxStart + size > fileSize) throw Boom.badData('Invalid MP4 box size');
      const payloadSize = size - headerSize;
      if (boxType === 'moov') {
        const buf = Buffer.alloc(payloadSize);
        readSync(fd, buf, 0, payloadSize, boxStart + headerSize);
        return buf;
      }
      pos = boxStart + size;
    }
  } finally {
    closeSync(fd);
  }
  throw Boom.badData("MP4 metadata box 'moov' was not found");
}

function parseMvhd(data: Buffer): number | null {
  if (!data.length) return null;
  const version = data[0];
  let timescale: number;
  let duration: number;
  if (version === 0) {
    if (data.length < 20) return null;
    timescale = data.readUInt32BE(12);
    duration = data.readUInt32BE(16);
  } else if (version === 1) {
    if (data.length < 32) return null;
    timescale = data.readUInt32BE(20);
    duration = Number(data.readBigUInt64BE(24));
  } else return null;
  if (!timescale) return null;
  return duration / timescale;
}

function parseTkhd(data: Buffer): [number | null, number | null] {
  if (!data.length) return [null, null];
  const version = data[0];
  const offset = version === 0 ? 76 : version === 1 ? 88 : null;
  if (offset === null || data.length < offset + 8) return [null, null];
  const width = Math.round(data.readUInt32BE(offset) / 65536);
  const height = Math.round(data.readUInt32BE(offset + 4) / 65536);
  if (width <= 0 || height <= 0) return [null, null];
  return [width, height];
}

function parseHdlr(data: Buffer): string | null {
  if (data.length < 12) return null;
  return data.toString('latin1', 8, 12);
}

function parseTrak(data: Buffer): TrackMetadata {
  const track: TrackMetadata = { width: null, height: null, duration: null, handlerType: null };
  for (const [boxType, payload] of iterBoxes(data)) {
    if (boxType === 'tkhd') [track.width, track.height] = parseTkhd(payload);
    else if (boxType === 'mdia') {
      for (const [t, p] of iterBoxes(payload)) {
        if (t === 'mdhd') track.duration = parseMvhd(p);
        else if (t === 'hdlr') track.handlerType = parseHdlr(p);
      }
    }
  }
  return track;
}

/** Read MP4 width, height, and duration without invoking ffmpeg. */
export function readVideoMetadata(file: string): VideoMetadata {
  const moov = readMoov(file);
  let movieDuration: number | null = null;
  const tracks: TrackMetadata[] = [];
  for (const [boxType, payload] of iterBoxes(moov)) {
    if (boxType === 'mvhd') movieDuration = parseMvhd(payload);
    else if (boxType === 'trak') tracks.push(parseTrak(payload));
  }
  let videoTrack = tracks.find((t) => t.handlerType === 'vide' && t.width !== null && t.height !== null);
  if (!videoTrack) videoTrack = tracks.find((t) => t.width !== null && t.height !== null);
  if (!videoTrack) throw Boom.badData('MP4 video track dimensions were not found');
  const duration = movieDuration !== null ? movieDuration : videoTrack.duration;
  if (duration === null) throw Boom.badData('MP4 video duration was not found');
  return { width: videoTrack.width!, height: videoTrack.height!, duration: Number(duration) };
}

export async function readVideoMetadataWithFfprobe(file: string): Promise<VideoMetadata> {
  try {
    const info = await probe(file);
    return { width: info.width, height: info.height, duration: info.duration };
  } catch (e) {
    if (e instanceof FfmpegUnavailableError) throw Boom.failedDependency(METADATA_FFMPEG_MESSAGE);
    throw e;
  }
}

export async function readVideoMetadataWithFallback(file: string): Promise<VideoMetadata> {
  try {
    return readVideoMetadata(file);
  } catch {
    return readVideoMetadataWithFfprobe(file);
  }
}

export async function generateVideoThumbnail(
  file: string,
  thumbnail: string,
  duration: number | null = null,
  cropThumbnail: ((p: string) => boolean | Promise<boolean>) | null = null,
): Promise<void> {
  try {
    const frameTime = duration !== null ? duration : (await probe(file)).duration;
    await ffmpeg(['-ss', String(frameTime / 2), '-i', file, '-frames:v', '1', '-q:v', '2', thumbnail]);
  } catch (e) {
    if (e instanceof FfmpegUnavailableError) throw Boom.failedDependency(THUMBNAIL_FFMPEG_MESSAGE);
    throw e;
  }
  if (cropThumbnail) await cropThumbnail(thumbnail);
}

/** Returns [thumbnail, width, height, duration] */
export async function analyzeVideoForUpload(
  file: string,
  thumbnail: string | null = null,
  label = 'video',
  cropThumbnail: ((p: string) => boolean | Promise<boolean>) | null = null,
): Promise<[string, number, number, number]> {
  console.log(`Analyzing ${label} file "${file}"`);
  const metadata = await readVideoMetadataWithFallback(file);
  if (thumbnail === null || thumbnail === undefined) {
    thumbnail = `${file}.jpg`;
    console.log(`Generating thumbnail "${thumbnail}"...`);
    await generateVideoThumbnail(file, thumbnail, metadata.duration, cropThumbnail);
  }
  return [thumbnail, metadata.width, metadata.height, metadata.duration];
}
