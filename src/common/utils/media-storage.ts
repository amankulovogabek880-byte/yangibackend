/**
 * v14: Umumiy media saqlash yordamchisi.
 *
 * MUAMMO: kiruvchi Telegram media (mijoz yuborgan ovoz/rasm/video/fayl) avval
 * MAHALLIY diskka (`./uploads`) yozilib, `${API_BASE_URL}/uploads/...` URL
 * qaytarilardi. Render/serverless muhitida bu disk VAQTINCHA (deploy/restartda
 * o'chadi) va ko'pincha URL umuman yetib bormaydi — shu sabab kiruvchi ovoz
 * "0:00" bo'lib eshitilmas, kiruvchi rasm esa umuman ochilmasdi.
 *
 * YECHIM: chiquvchi fayllar kabi kiruvchilarni ham Supabase Storage'ga
 * yuklaymiz (doimiy, ochiq, to'g'ri Content-Type bilan URL). Supabase
 * sozlanmagan bo'lsa — mahalliy diskka tushib qolamiz (fallback).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'documents';

let supabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

function safeName(name: string): string {
  const clean = (name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${clean}`;
}

/**
 * Buffer'ni doimiy saqlashga yuklaydi va ochiq URL qaytaradi.
 * Supabase bo'lsa — Supabase'ga; bo'lmasa — mahalliy /uploads ga.
 */
export async function uploadBufferToStorage(
  buf: Buffer,
  fileName: string,
  contentType: string,
): Promise<string> {
  const path = safeName(fileName);

  if (supabase) {
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(path, buf, { contentType, upsert: false });
    if (!error) {
      const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
      return pub.publicUrl;
    }
    // Supabase xato bersa — pastdagi mahalliy fallback'ga o'tamiz
  }

  // Fallback: mahalliy disk
  const fs = require('fs');
  const nodePath = require('path');
  const uploadDir = process.env.UPLOAD_DIR || './uploads';
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(nodePath.join(uploadDir, path), buf);
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  return `${baseUrl}/uploads/${path}`;
}