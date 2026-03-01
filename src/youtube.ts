import ytdlp from 'yt-dlp-exec';
import { logger } from './logger.js';

export interface VideoInfo {
  title: string;
  duration: number;
  transcript: string | null;
  description: string;
}

export async function getYouTubeInfo(url: string): Promise<VideoInfo> {
  const info = await ytdlp(url, {
    dumpSingleJson: true,
    noCheckCertificate: true,
    noWarnings: true,
    skipDownload: true,
  }) as {
    title: string;
    duration: number;
    description: string;
    automatic_captions?: Record<string, Array<{ url: string }>>;
  };

  let transcript: string | null = null;

  // Try to get English auto-captions
  const captionUrl = info.automatic_captions?.en?.[0]?.url;
  if (captionUrl) {
    try {
      const resp = await fetch(captionUrl);
      const text = await resp.text();
      const json = JSON.parse(text);
      transcript = json.events
        ?.filter((e: { segs?: unknown }) => e.segs)
        .map((e: { segs: Array<{ utf8: string }> }) => e.segs.map(s => s.utf8).join(''))
        .join(' ')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || null;
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch YouTube captions');
    }
  }

  return {
    title: info.title,
    duration: info.duration,
    transcript,
    description: info.description || '',
  };
}
