/**
 * v14: Ovozli xabarni haqiqiy Telegram "voice note" qilib yuborish uchun
 * konvertatsiya.
 *
 * MUAMMO: brauzer (Chrome) mikrofonda `audio/webm;codecs=opus` yozadi. Telegram
 * esa voice note sifatida FAQAT `ogg/opus` ni qabul qiladi — webm bo'lsa uni
 * oddiy HUJJAT ("papka" / unnamed.webm) qilib yuboradi. Codec bir xil (opus),
 * faqat konteyner boshqa (webm vs ogg), shuning uchun QAYTA KODLASHSIZ tez
 * remux qilib bo'ladi.
 *
 * Bu util webm/boshqa audioni ogg/opus'ga o'giradi. ffmpeg tizimda bo'lmasa
 * `@ffmpeg-installer/ffmpeg` bundlevel statik binary'dan foydalanadi.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function getFfmpegPath(): string {
  try {
    // Statik binary (Render/serverless'da tizim ffmpeg bo'lmasa ham ishlaydi)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer?.path) return installer.path;
  } catch {}
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * Audio buffer'ni ogg/opus'ga o'giradi (Telegram voice note uchun).
 * Muvaffaqiyatsiz bo'lsa null qaytaradi (chaqiruvchi eski buffer bilan davom etadi).
 */
export function toOggOpus(input: Buffer, inExt = 'webm'): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const tmp = os.tmpdir();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inPath = path.join(tmp, `voin-${id}.${inExt}`);
    const outPath = path.join(tmp, `voout-${id}.ogg`);
    try {
      fs.writeFileSync(inPath, input);
    } catch {
      return resolve(null);
    }
    const cleanup = () => {
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    };
    // -c:a libopus → ogg/opus; -b:a 48k -ac 1 → voice uchun yetarli va yengil
    execFile(
      getFfmpegPath(),
      ['-y', '-i', inPath, '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', outPath],
      { timeout: 30000 },
      (err) => {
        if (err) {
          cleanup();
          return resolve(null);
        }
        try {
          const out = fs.readFileSync(outPath);
          cleanup();
          resolve(out && out.length ? out : null);
        } catch {
          cleanup();
          resolve(null);
        }
      },
    );
  });
}