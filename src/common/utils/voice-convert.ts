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
 * v19: Qo'ng'iroq yozuvini (PBX'dan kelgan audio) Whisper (OpenAI) uchun
 * "tozalab" qayta kodlaydi.
 *
 * MUAMMO: OnlinePBX (va boshqa ATS'lar) ba'zan audio yozuvni HALI TO'LIQ
 * yozib bo'lmagan holatda (stream davom etayotganda) yoki nostandart/buzuq
 * sarlavha (header) bilan qaytaradi — fayl brauzerda "audio" elementida
 * ijro etilishi mumkin (chunki brauzer ba'zi xatolarga chidamli), lekin
 * Whisper API buni qat'iy tekshiradi va "duration":0 xatosini beradi.
 *
 * YECHIM: yuklab olingan audio baytlarini ffmpeg orqali QAYTA KODLAYMIZ
 * (mono, 16kHz, mp3) — bu haqiqiy formatni kontent orqali aniqlaydi
 * (fayl kengaytmasiga qaramaydi), buzuq/streaming sarlavhalarni to'g'ri
 * o'qib, YANGI, to'g'ri sarlavhali fayl chiqaradi. Natijada Whisper
 * har doim to'g'ri formatdagi, aniq davomiyligi bor faylni oladi.
 *
 * Bonus: ffmpeg stderr'idan haqiqiy davomiylikni (`Duration: HH:MM:SS`)
 * o'qib olamiz — shu orqali Whisper'ga yuborishdan OLDIN, agar yozuv
 * chindan ham bo'sh (0 soniya) bo'lsa, buni ANIQ bilib, ma'noli xabar
 * bilan to'xtaymiz (Whisper'ning tushunarsiz JSON xatosi o'rniga).
 */
function parseFfmpegDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '');
  if (!m) return null;
  const h = Number(m[1]);
  const mnt = Number(m[2]);
  const s = Number(m[3]);
  if (![h, mnt, s].every((n) => Number.isFinite(n))) return null;
  return h * 3600 + mnt * 60 + s;
}

export function normalizeAudioForWhisper(
  input: Buffer,
): Promise<{ buffer: Buffer; durationSec: number } | { error: string }> {
  return new Promise((resolve) => {
    const tmp = os.tmpdir();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Kirish fayli uchun kengaytma muhim emas — ffmpeg formatni kontent
    // (magic bytes) orqali avtomatik aniqlaydi.
    const inPath = path.join(tmp, `wsin-${id}.audio`);
    const outPath = path.join(tmp, `wsout-${id}.mp3`);
    try {
      fs.writeFileSync(inPath, input);
    } catch (e: any) {
      return resolve({ error: `Vaqtinchalik faylni yozib bo'lmadi: ${e?.message}` });
    }
    const cleanup = () => {
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    };
    // -ar 16000 -ac 1 -> nutq uchun yetarli, fayl hajmi kichik (Whisper 25MB limiti)
    execFile(
      getFfmpegPath(),
      ['-y', '-i', inPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', outPath],
      { timeout: 60000 },
      (err, _stdout, stderrBuf) => {
        const stderr = String(stderrBuf || '');
        const durationSec = parseFfmpegDuration(stderr);
        if (err) {
          cleanup();
          return resolve({ error: `Audio faylni o'qib bo'lmadi (buzuq yoki noma'lum format): ${err.message}` });
        }
        try {
          const out = fs.readFileSync(outPath);
          cleanup();
          if (!out || out.length < 200) {
            return resolve({ error: "Konvertatsiyadan keyin audio bo'sh chiqdi" });
          }
          if (durationSec != null && durationSec < 1) {
            return resolve({ error: "Yozuv 0 soniya — PBX yozuvni hali to'liq tayyorlamagan bo'lishi mumkin" });
          }
          resolve({ buffer: out, durationSec: durationSec ?? 0 });
        } catch (e: any) {
          cleanup();
          resolve({ error: `Natija faylni o'qib bo'lmadi: ${e?.message}` });
        }
      },
    );
  });
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