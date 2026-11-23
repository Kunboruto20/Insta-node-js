import * as Boom from '@hapi/boom';
import { guardMethods } from '../core/boomErrors';
import { existsSync } from 'node:fs';
import { loadSharp } from './sharpLoader';
import { StoryBuild, StoryMention, StorySticker, makeStoryBuild, makeStorySticker } from '../models/schemas';
import { FfmpegUnavailableError, ffmpeg, makeTmpPath, probe } from './ffmpegRunner';
import { FFMPEG_HINT_MESSAGE } from './mp4Metadata';
import { ensure } from '../helpers/assertions';

export const STORY_BUILDER_VIDEO_EXTRA_MESSAGE = `StoryBuilder requires ffmpeg. ${FFMPEG_HINT_MESSAGE}`;

/** A media "clip" (video file or still image) */
export interface StoryClip {
  kind: 'video' | 'image';
  path: string;
  size: [number, number];
  duration: number | null;
  hasAudio?: boolean;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render a text label into a PNG, returns [path, [w, h]] */
async function renderText(
  text: string,
  font: string,
  fontSize: number,
  color: string,
  bgColor: string | null = null,
): Promise<{ path: string; size: [number, number] }> {
  const markup = `<span foreground="${xmlEscape(color)}"${bgColor ? ` background="${xmlEscape(bgColor)}"` : ''}>${xmlEscape(text)}</span>`;
  const png = await loadSharp()({ text: { text: markup, font: `${font} ${fontSize}`, dpi: 72, rgba: true } }).png().toBuffer();
  const meta = await loadSharp()(png).metadata();
  const file = makeTmpPath('.png', 'text_');
  await loadSharp()(png).toFile(file);
  return { path: file, size: [meta.width!, meta.height!] };
}

async function resizePng(file: string, width: number): Promise<{ path: string; size: [number, number] }> {
  const out = makeTmpPath('.png', 'text_');
  await loadSharp()(file).resize({ width }).png().toFile(out);
  const meta = await loadSharp()(out).metadata();
  return { path: out, size: [meta.width!, meta.height!] };
}

function round7(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}

/** Helpers for Story building */
export class StoryBuilder {
  width = 720;
  height = 1280;
  path: string;
  caption: string;
  mentions: StoryMention[];
  bgpath: string | null;

  static _fitSize(sourceSize: [number, number], canvasSize: [number, number]): [number, number] {
    const [sw, sh] = sourceSize;
    const [cw, ch] = canvasSize;
    const scale = Math.min(cw / sw, ch / sh);
    return [Math.trunc(sw * scale), Math.trunc(sh * scale)];
  }

  /**
   * @param path Path for a file
   * @param caption Media caption, default value is ""
   * @param mentions List of mentions to be tagged on this upload
   * @param bgpath Path for a background image
   */
  constructor(path: string, caption = '', mentions: StoryMention[] = [], bgpath: string | null = null) {
    this.path = path;
    this.caption = caption;
    this.mentions = mentions;
    this.bgpath = bgpath || null;
  }

  /** Build clip (composite the media, caption, link sticker; write mp4) */
  async buildMain(clip: StoryClip, maxDuration = 0, font = 'Arial', fontsize = 100, color = 'white', link = ''): Promise<StoryBuild> {
    const inputs: string[] = [];
    const overlays: Array<{ idx: number; x: number; y: number; fade?: boolean; scale?: [number, number] }> = [];
    const stickers: StorySticker[] = [];
    let inputIndex = 0;
    // Background
    if (this.bgpath) {
      ensure(existsSync(this.bgpath), `Wrong path to background ${this.bgpath}`);
      inputs.push('-loop', '1', '-i', this.bgpath);
      overlays.push({ idx: inputIndex++, x: 0, y: 0 });
    }
    // Media clip
    const clipLeft = (this.width - clip.size[0]) / 2;
    let clipTop = (this.height - clip.size[1]) / 2;
    if (clipTop > 90) clipTop -= 50;
    if (clip.kind === 'image') inputs.push('-loop', '1', '-i', clip.path);
    else inputs.push('-i', clip.path);
    const mediaIdx = inputIndex++;
    overlays.push({ idx: mediaIdx, x: clipLeft, y: clipTop, scale: clip.size });
    let mention: StoryMention | null = this.mentions.length ? this.mentions[0] : null;
    // Text clip
    let caption = this.caption;
    let textClipTop = 0;
    let textSize: [number, number] = [0, 0];
    if (this.mentions.length) {
      mention = this.mentions[0];
      if (mention.user) caption = `@${mention.user.username}`;
    }
    if (caption) {
      const text = await renderText(caption, font, fontsize, color);
      const textClipLeft = (this.width - 600) / 2;
      textClipTop = clipTop + clip.size[1] + 50;
      const offset = textClipTop + text.size[1] - this.height;
      if (offset > 0) textClipTop -= offset + 90;
      const resized = await resizePng(text.path, 600);
      textSize = resized.size;
      inputs.push('-loop', '1', '-i', resized.path);
      overlays.push({ idx: inputIndex++, x: textClipLeft, y: textClipTop, fade: true });
    }
    if (link) {
      const url = new URL(link);
      const linkText = await renderText(url.host, font, 32, 'blue', 'white');
      const linkClipLeft = (this.width - 400) / 2;
      const linkClipTop = clip.size[1] / 2;
      const resized = await resizePng(linkText.path, 400);
      stickers.push(
        makeStorySticker({
          // x=160.0, y=641.0, z=0, width=400.0, height=88.0,
          x: round7(linkClipLeft / this.width), // e.g. 0.49953705
          y: round7(linkClipTop / this.height), // e.g. 0.5
          z: 0,
          width: round7(resized.size[0] / this.width), // e.g. 0.50912
          height: round7(resized.size[1] / this.height), // e.g. 0.06875
          rotation: 0.0,
          // id="link_sticker_default",
          type: 'story_link',
          extra: { link_type: 'web', url: String(link), tap_state_str_id: 'link_sticker_default' },
        }),
      );
      inputs.push('-loop', '1', '-i', resized.path);
      overlays.push({ idx: inputIndex++, x: linkClipLeft, y: linkClipTop, fade: true });
    }
    // Mentions
    let mentions: StoryMention[] = [];
    if (mention) {
      mention.x = 0.49892962; // approximately center
      mention.y = (textClipTop + textSize[1] / 2) / this.height;
      mention.width = textSize[0] / this.width;
      mention.height = textSize[1] / this.height;
      mentions = [mention];
    }
    let duration = maxDuration;
    if (clip.duration) {
      if (duration > Math.trunc(clip.duration) || !duration) duration = Math.trunc(clip.duration);
    }
    const destination = makeTmpPath('.mp4');
    // compose
    const chain: string[] = [`color=c=black:s=${this.width}x${this.height}:r=24:d=${duration}[base0]`];
    let last = 'base0';
    overlays.forEach((o, i) => {
      let src = `[${o.idx}:v]`;
      const pre: string[] = [];
      if (o.scale) pre.push(`scale=${Math.round(o.scale[0])}:${Math.round(o.scale[1])}`);
      if (o.fade) pre.push('format=rgba', 'fade=t=in:st=0:d=3:alpha=1');
      if (pre.length) {
        chain.push(`${src}${pre.join(',')}[ov${i}]`);
        src = `[ov${i}]`;
      }
      chain.push(`[${last}]${src}overlay=x=${Math.round(o.x)}:y=${Math.round(o.y)}:shortest=0:eof_action=pass[base${i + 1}]`);
      last = `base${i + 1}`;
    });
    chain.push(`[${last}]format=yuv420p[vout]`);
    const args = [...inputs, '-filter_complex', chain.join(';'), '-map', '[vout]'];
    if (clip.kind === 'video' && clip.hasAudio) args.push('-map', `${mediaIdx}:a?`, '-c:a', 'aac');
    args.push('-t', String(duration), '-r', '24', '-c:v', 'libx264', destination);
    await runFfmpeg(args);
    const paths: string[] = [];
    if (duration > 15) {
      const parts = Math.floor(duration / 15) + (duration % 15 ? 1 : 0);
      for (let i = 0; i < parts; i++) {
        const p = makeTmpPath('.mp4');
        const start = i * 15;
        const rest = duration - start;
        const end = start + (rest < 15 ? rest : 15);
        await runFfmpeg(['-ss', String(start), '-i', destination, '-t', String(end - start), '-c:v', 'libx264', '-c:a', 'aac', p]);
        paths.push(p);
      }
    }
    return makeStoryBuild({ mentions, path: destination, paths, stickers });
  }

  /** Build composite video from source video */
  async video(maxDuration = 0, font = 'Arial', fontsize = 100, color = 'white', link = ''): Promise<StoryBuild> {
    const info = await probeOrThrow(this.path);
    const clip: StoryClip = { kind: 'video', path: this.path, size: [info.width, info.height], duration: info.duration, hasAudio: info.hasAudio };
    return this.buildMain(clip, maxDuration, font, fontsize, color, link);
  }

  /** Build a Story video canvas that fits the full source video without cropping. */
  async videoFit(maxDuration = 0, backgroundColor: [number, number, number] = [0, 0, 0]): Promise<StoryBuild> {
    const info = await probeOrThrow(this.path);
    let duration = Number(info.duration || maxDuration || 0);
    if (maxDuration && duration > maxDuration) duration = Number(maxDuration);
    const [fitWidth, fitHeight] = StoryBuilder._fitSize([info.width, info.height], [this.width, this.height]);
    const clipLeft = Math.trunc((this.width - fitWidth) / 2);
    const clipTop = Math.trunc((this.height - fitHeight) / 2);
    const fps = info.fps || 24;
    const hex = backgroundColor.map((c) => c.toString(16).padStart(2, '0')).join('');
    const destination = makeTmpPath('.mp4');
    const vf = `scale=${fitWidth}:${fitHeight},pad=${this.width}:${this.height}:${clipLeft}:${clipTop}:color=0x${hex},fps=${fps},format=yuv420p`;
    const args = ['-i', this.path, '-t', String(duration), '-vf', vf, '-c:v', 'libx264'];
    if (info.hasAudio) args.push('-c:a', 'aac');
    args.push(destination);
    await runFfmpeg(args);
    return makeStoryBuild({ mentions: [], path: destination, paths: [], stickers: [] });
  }

  /** Build composite video from source photo */
  async photo(maxDuration = 0, font = 'Arial', fontsize = 100, color = 'white', link = ''): Promise<StoryBuild> {
    const meta = await loadSharp()(this.path).metadata();
    const imageWidth = meta.width!;
    const imageHeight = meta.height!;
    const widthReductionPercent = this.width / imageWidth;
    const heightInRatio = Math.trunc(imageHeight * widthReductionPercent);
    const resized = makeTmpPath('.png', 'photo_');
    await loadSharp()(this.path).resize(this.width, heightInRatio, { fit: 'fill' }).png().toFile(resized);
    const clip: StoryClip = { kind: 'image', path: resized, size: [this.width, heightInRatio], duration: null };
    return this.buildMain(clip, maxDuration || 15, font, fontsize, color, link);
  }
}

async function probeOrThrow(file: string) {
  try {
    return await probe(file);
  } catch (e) {
    if (e instanceof FfmpegUnavailableError) throw Boom.failedDependency(STORY_BUILDER_VIDEO_EXTRA_MESSAGE);
    throw e;
  }
}

async function runFfmpeg(args: string[]) {
  try {
    await ffmpeg(args);
  } catch (e) {
    if (e instanceof FfmpegUnavailableError) throw Boom.failedDependency(STORY_BUILDER_VIDEO_EXTRA_MESSAGE);
    throw e;
  }
}

// Every error thrown by StoryBuilder is a Boom error.
guardMethods(StoryBuilder.prototype);
