/**
 * ffmpeg/ffprobe helpers (replacement for MoviePy in the python library).
 * Binary resolution: FFMPEG_PATH / IMAGEIO_FFMPEG_EXE env → optional `ffmpeg-static` package → `ffmpeg` on PATH.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export const FFMPEG_INSTALL_MESSAGE =
  'Video features need ffmpeg: install the optional "ffmpeg-static" and "ffprobe-static" packages ' +
  '(npm i ffmpeg-static ffprobe-static), or install ffmpeg on the system PATH, or set FFMPEG_PATH / FFPROBE_PATH.';

function optionalRequire(name: string): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(name);
  } catch {
    return null;
  }
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || process.env.IMAGEIO_FFMPEG_EXE || optionalRequire('ffmpeg-static') || 'ffmpeg';
}

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH || optionalRequire('ffprobe-static')?.path || 'ffprobe';
}

export class FfmpegUnavailableError extends Error {
  constructor(message = FFMPEG_INSTALL_MESSAGE) {
    super(message);
    this.name = 'FfmpegUnavailableError';
  }
}

export function run(bin: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new FfmpegUnavailableError());
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    child.on('error', (e: any) => reject(e?.code === 'ENOENT' ? new FfmpegUnavailableError() : e));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}: ${err.slice(-2000)}`));
    });
  });
}

export function ffmpeg(args: string[]) {
  return run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

export interface ProbeInfo {
  width: number;
  height: number;
  duration: number;
  fps: number | null;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const info = JSON.parse(stdout.toString());
  const video = (info.streams || []).find((s: any) => s.codec_type === 'video');
  if (!video) throw new Error('No video stream found');
  let width = Number(video.width);
  let height = Number(video.height);
  const rotate = Number(video.tags?.rotate || video.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rotate) === 90 || Math.abs(rotate) === 270) [width, height] = [height, width];
  const [num, den] = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
  return {
    width,
    height,
    duration: Number(info.format?.duration ?? video.duration ?? 0),
    fps: den ? num / den : null,
    hasAudio: (info.streams || []).some((s: any) => s.codec_type === 'audio'),
  };
}

/** tempfile.mkstemp(suffix) equivalent: creates the file and returns its path */
export function makeTmpPath(suffix: string, prefix = 'tmp'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'insta-node-'));
  const p = path.join(dir, `${prefix}${randomBytes(6).toString('hex')}${suffix}`);
  closeSync(openSync(p, 'w'));
  return p;
}
