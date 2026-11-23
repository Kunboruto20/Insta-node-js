// Copyright (c) 2017 https://github.com/ping
// This software is released under the MIT License. https://opensource.org/licenses/MIT
import * as Boom from '@hapi/boom';
import { copyFileSync, promises as fsp, statSync } from 'node:fs';
import sharp from 'sharp';
import { get as httpGet } from '../net/httpClient';
import { ffmpeg, makeTmpPath, probe } from './ffmpegRunner';
import { FFMPEG_HINT_MESSAGE } from './mp4Metadata';

export const VIDEO_EXTRA_MESSAGE = `prepareVideo() requires ffmpeg. ${FFMPEG_HINT_MESSAGE}`;

export type Size = [number, number];

/**
 * Calculate if resize is required based on the max size desired and the current size
 */
export function calcResize(maxSize: Size | null, currSize: Size, minSize: Size | null = [0, 0]): Size | undefined {
  const [maxWidth, maxHeight] = maxSize || [0, 0];
  const [minWidth, minHeight] = minSize || [0, 0];
  if ((maxWidth && minWidth > maxWidth) || (maxHeight && minHeight > maxHeight)) throw Boom.badRequest('Invalid min / max sizes.');
  const [origWidth, origHeight] = currSize;
  if (maxWidth && maxHeight && (origWidth > maxWidth || origHeight > maxHeight)) {
    const f = Math.min((1.0 * maxWidth) / origWidth, (1.0 * maxHeight) / origHeight);
    return [Math.trunc(f * origWidth), Math.trunc(f * origHeight)];
  } else if (minWidth && minHeight && (origWidth < minWidth || origHeight < minHeight)) {
    const f = Math.max((1.0 * minWidth) / origWidth, (1.0 * minHeight) / origHeight);
    return [Math.trunc(f * origWidth), Math.trunc(f * origHeight)];
  }
  return undefined;
}

/**
 * Calculate if cropping is required based on the desired aspect ratio and the current size.
 * aspectRatios: single float value or [min_ratio, max_ratio]. Returns [left, top, right, bottom].
 */
export function calcCrop(aspectRatios: number | number[], currSize: Size): [number, number, number, number] | undefined {
  let minAspectRatio: number;
  let maxAspectRatio: number;
  if (Array.isArray(aspectRatios)) {
    if (aspectRatios.length !== 2) throw Boom.badRequest('Invalid aspect ratios');
    minAspectRatio = Number(aspectRatios[0]);
    maxAspectRatio = Number(aspectRatios[1]);
  } else {
    // not a min-max range
    minAspectRatio = maxAspectRatio = Number(aspectRatios);
  }
  const currAspectRatio = (1.0 * currSize[0]) / currSize[1];
  if (!(minAspectRatio <= currAspectRatio && currAspectRatio <= maxAspectRatio)) {
    const [currWidth, currHeight] = currSize;
    let newWidth: number;
    let newHeight: number;
    if (currAspectRatio > maxAspectRatio) {
      // media is too wide
      newHeight = currHeight;
      newWidth = maxAspectRatio * newHeight;
    } else {
      // media is too tall
      newWidth = currWidth;
      newHeight = newWidth / minAspectRatio;
    }
    return [
      Math.trunc((currWidth - newWidth) / 2),
      Math.trunc((currHeight - newHeight) / 2),
      Math.trunc((currWidth + newWidth) / 2),
      Math.trunc((currHeight + newHeight) / 2),
    ];
  }
  return undefined;
}

/** Detect if media specified is a url */
export function isRemote(media: string): boolean {
  return /^https?:\/\//.test(media);
}

async function loadInput(img: string | Buffer): Promise<Buffer | string> {
  if (typeof img === 'string' && isRemote(img)) return (await httpGet(img, { timeout: 5 })).content;
  return img;
}

/**
 * Prepares an image file for posting.
 * Defaults for size and aspect ratio from https://help.instagram.com/1469029763400082
 * Returns [jpegBuffer, [width, height]].
 */
export async function prepareImage(
  img: string | Buffer,
  maxSize: Size | null = [1080, 1350],
  aspectRatios: number | number[] | null = [4.0 / 5.0, 90.0 / 47.0],
  savePath: string | null = null,
  opts: { minSize?: Size } = {},
): Promise<[Buffer, Size]> {
  const minSize = opts.minSize ?? [320, 167];
  let im = sharp(await loadInput(img)).rotate();
  let meta = await sharp(await im.toBuffer()).metadata();
  let size: Size = [meta.width!, meta.height!];
  let buf = await im.toBuffer();
  if (aspectRatios) {
    const cropBox = calcCrop(aspectRatios, size);
    if (cropBox) {
      const [l, t, r, b] = cropBox;
      buf = await sharp(buf).extract({ left: l, top: t, width: r - l, height: b - t }).toBuffer();
      size = [r - l, b - t];
    }
  }
  const newSize = calcResize(maxSize, size, minSize);
  if (newSize) {
    buf = await sharp(buf).resize(newSize[0], newSize[1], { fit: 'fill' }).toBuffer();
    size = newSize;
  }
  // Removes transparency (alpha)
  im = sharp(buf).flatten({ background: { r: 255, g: 255, b: 255 } });
  buf = await im.toBuffer();
  if (savePath) await sharp(buf).toFile(savePath);
  const jpeg = await sharp(buf).jpeg({ quality: 75 }).toBuffer();
  meta = await sharp(jpeg).metadata();
  return [jpeg, [meta.width!, meta.height!]];
}

/** Prepare an image for a Story without cropping the source media. */
export async function prepareStoryImageFit(
  img: string | Buffer,
  maxSize: Size = [1080, 1920],
  backgroundColor: string | [number, number, number] = 'black',
  savePath: string | null = null,
): Promise<[Buffer, Size]> {
  const source = sharp(await loadInput(img)).rotate().ensureAlpha();
  const fitted = await source.resize(maxSize[0], maxSize[1], { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' }).png().toBuffer();
  const meta = await sharp(fitted).metadata();
  const left = Math.trunc((maxSize[0] - meta.width!) / 2);
  const top = Math.trunc((maxSize[1] - meta.height!) / 2);
  const background = Array.isArray(backgroundColor) ? { r: backgroundColor[0], g: backgroundColor[1], b: backgroundColor[2] } : backgroundColor;
  const canvas = sharp({ create: { width: maxSize[0], height: maxSize[1], channels: 3, background } }).composite([{ input: fitted, left, top }]);
  const rgb = await canvas.png().toBuffer();
  if (savePath) await sharp(rgb).toFile(savePath);
  return [await sharp(rgb).jpeg({ quality: 75 }).toBuffer(), [maxSize[0], maxSize[1]]];
}

export interface PrepareVideoOptions {
  minSize?: Size;
  progressBar?: boolean;
  /** return only the path to the saved video file. Requires savePath be set. */
  saveOnly?: boolean;
  /** ffmpeg x264 preset: ultrafast ... placebo */
  preset?: string;
}

/**
 * Prepares a video file for posting.
 * Defaults for size and aspect ratio from https://help.instagram.com/1469029763400082
 * Returns [videoContent (Buffer, or path when saveOnly), [width, height], duration, thumbnailJpeg]
 */
export async function prepareVideo(
  vid: string,
  thumbnailFrameTs = 0.0,
  maxSize: Size | null = [1080, 1350],
  aspectRatios: number | number[] | null = [4.0 / 5.0, 90.0 / 47.0],
  maxDuration = 60.0,
  savePath: string | null = null,
  skipReencoding = false,
  opts: PrepareVideoOptions = {},
): Promise<[Buffer | string, Size, number, Buffer]> {
  const minSize = opts.minSize ?? [612, 320];
  const saveOnly = opts.saveOnly ?? false;
  const preset = opts.preset ?? 'medium';
  if (saveOnly && !savePath) throw Boom.badRequest('"savePath" cannot be empty.');
  if (savePath && !savePath.toLowerCase().endsWith('.mp4')) throw Boom.badRequest('You must specify a .mp4 save path');
  let vidIsModified = false; // flag to track if re-encoding can be skipped
  const tempVideoFile = makeTmpPath('.mp4', 'ipae_');
  let videoSrcFilename: string;
  if (isRemote(vid)) {
    const res = await httpGet(vid, { timeout: 5 });
    await fsp.writeFile(tempVideoFile, res.content);
    videoSrcFilename = tempVideoFile;
  } else {
    copyFileSync(vid, tempVideoFile);
    videoSrcFilename = vid;
  }
  let info;
  try {
    info = await probe(tempVideoFile);
  } catch (e: any) {
    if (e?.name === 'FfmpegUnavailableError') throw Boom.failedDependency(VIDEO_EXTRA_MESSAGE);
    throw e;
  }
  let duration = info.duration;
  let size: Size = [info.width, info.height];
  const filters: string[] = [];
  if (duration < 3 * 1.0) throw Boom.badRequest('Duration is too short');
  if (duration > maxDuration * 1.0) {
    duration = maxDuration;
    vidIsModified = true;
  }
  if (thumbnailFrameTs > duration) throw Boom.badRequest('Invalid thumbnail frame');
  if (aspectRatios) {
    const cropBox = calcCrop(aspectRatios, size);
    if (cropBox) {
      const [x1, y1, x2, y2] = cropBox;
      filters.push(`crop=${x2 - x1}:${y2 - y1}:${x1}:${y1}`);
      size = [x2 - x1, y2 - y1];
      vidIsModified = true;
    }
  }
  if (maxSize || minSize) {
    const newSize = calcResize(maxSize, size, minSize);
    if (newSize) {
      filters.push(`scale=${newSize[0]}:${newSize[1]}`);
      size = newSize;
      vidIsModified = true;
    }
  }
  const tempVidOutputFile = makeTmpPath('.mp4', 'ipae_');
  if (vidIsModified || !skipReencoding) {
    // write out
    const args = ['-i', tempVideoFile, '-t', String(duration)];
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', tempVidOutputFile);
    await ffmpeg(args);
  } else {
    // no reencoding
    copyFileSync(videoSrcFilename, tempVidOutputFile);
  }
  if (savePath) copyFileSync(tempVidOutputFile, savePath);
  // Temp thumbnail img filename
  const tempThumbnailFile = makeTmpPath('.jpg', 'ipae_');
  await ffmpeg(['-ss', String(thumbnailFrameTs), '-i', tempVidOutputFile, '-frames:v', '1', '-q:v', '2', tempThumbnailFile]);
  const videoThumbnailContent = await fsp.readFile(tempThumbnailFile);
  let videoContent: Buffer | string;
  let videoContentLen: number;
  if (!saveOnly) {
    videoContentLen = statSync(tempVidOutputFile).size;
    videoContent = await fsp.readFile(tempVidOutputFile);
  } else {
    videoContentLen = statSync(savePath!).size;
    videoContent = savePath!; // return the file path instead
  }
  if (videoContentLen > 50 * 1024 * 1000) throw Boom.entityTooLarge('Video file is too big.');
  return [videoContent, size, duration, videoThumbnailContent];
}
