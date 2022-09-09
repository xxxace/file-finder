import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

export interface ScreenshotsOptions {
  timestamps: Array<number | string>;
  filename: string;
  folder: string;
  size?: string;
}

export function mkthumbnial(path: string, options: ScreenshotsOptions) {
  return new Promise((resolve) => {
    ffmpeg(path)
      .screenshots(options)
      .on('end', function () {
        resolve(true);
      }).on('error', function (e) {
        console.log(e);
        resolve(false);
      });
  });
}
