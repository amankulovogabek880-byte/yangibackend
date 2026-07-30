/**
 * ═══════════════════════════════════════════════════════════════
 * MOSLASHTIRILADIGAN RUXSATLAR (Custom Permissions) — v17
 * ═══════════════════════════════════════════════════════════════
 * Mavjud rol ierarxiyasi (roles.guard.ts) ni ALMASHTIRMAYDI — uni
 * TO'LDIRADI. Masalan: standart holatda faqat TENANT_ADMIN/MANAGER
 * eksport qila oladi, lekin admin xohlasa muayyan bitta AGENT'ga
 * ham "eksport qilish" ruxsatini alohida bera oladi — boshqa
 * agentlarga esa bermay qo'yishi mumkin.
 *
 * Har bir foydalanuvchi uchun `User.permissions` (Json) maydonida
 * faqat FARQ (override) saqlanadi: { "export_data": true } kabi.
 * Agar kalit ko'rsatilmagan bo'lsa — pastdagi ROLE_DEFAULTS'dan rol
 * bo'yicha standart qiymat olinadi.
 */

export type PermissionKey =
  | 'export_data'          // Excel/PDF eksport qilish
  | 'view_all_clients'     // Faqat o'ziga tegishli emas, BARCHA mijozlarni ko'rish
  | 'view_salaries'        // Boshqa agentlarning maosh/komissiyasini ko'rish
  | 'manage_users'         // Xodim qo'shish/o'chirish/tahrirlash
  | 'view_audit_log'       // Audit jurnalini ko'rish
  | 'manage_settings'      // Tizim sozlamalarini o'zgartirish (telefoniya, integratsiyalar)
  | 'delete_records';       // Mijoz/booking kabi yozuvlarni o'chirish

export const PERMISSION_DEFS: { key: PermissionKey; label: string; description: string }[] = [
  { key: 'export_data', label: 'Eksport qilish', description: "Excel/PDF hisobot yuklab olish" },
  { key: 'view_all_clients', label: 'Barcha mijozlarni ko\'rish', description: "Faqat o'ziga tegishli emas, boshqa agentlarning mijozlarini ham ko'rish" },
  { key: 'view_salaries', label: 'Maoshlarni ko\'rish', description: "Boshqa xodimlarning maosh/komissiya ma'lumotini ko'rish" },
  { key: 'manage_users', label: 'Xodimlarni boshqarish', description: "Yangi xodim qo'shish, tahrirlash, o'chirish" },
  { key: 'view_audit_log', label: 'Audit jurnalini ko\'rish', description: "Tizimdagi barcha o'zgarishlar tarixini ko'rish" },
  { key: 'manage_settings', label: 'Sozlamalarni boshqarish', description: "Telefoniya, integratsiyalar va boshqa tizim sozlamalarini o'zgartirish" },
  { key: 'delete_records', label: "Yozuvlarni o'chirish", description: "Mijoz, booking va boshqa yozuvlarni butunlay o'chirish" },
];

// Har bir rol uchun STANDART (override qilinmagan holatdagi) ruxsatlar.
// TENANT_ADMIN va PLATFORM_OWNER doim hammasiga ruxsatli — override kerak emas.
const ROLE_DEFAULTS: Record<string, PermissionKey[]> = {
  PLATFORM_OWNER: PERMISSION_DEFS.map((p) => p.key),
  TENANT_ADMIN: PERMISSION_DEFS.map((p) => p.key),
  MANAGER: ['export_data', 'view_all_clients', 'view_salaries', 'view_audit_log'],
  AGENT: [],
  ACCOUNTANT: ['export_data', 'view_salaries'],
};

/**
 * Foydalanuvchining muayyan ruxsatga ega yoki yo'qligini aniqlaydi.
 * Tartib: 1) TENANT_ADMIN/PLATFORM_OWNER — doim true.
 *         2) user.permissions ichida aniq belgilangan bo'lsa — o'sha qiymat.
 *         3) aks holda — rol bo'yicha standart qiymat.
 */
export function hasPermission(
  user: { role?: string; permissions?: Record<string, boolean> | null },
  key: PermissionKey,
): boolean {
  if (!user?.role) return false;
  if (user.role === 'TENANT_ADMIN' || user.role === 'PLATFORM_OWNER') return true;

  const override = user.permissions?.[key];
  if (typeof override === 'boolean') return override;

  return (ROLE_DEFAULTS[user.role] || []).includes(key);
}

export function effectivePermissions(user: { role?: string; permissions?: Record<string, boolean> | null }) {
  const result: Record<PermissionKey, boolean> = {} as any;
  for (const def of PERMISSION_DEFS) {
    result[def.key] = hasPermission(user, def.key);
  }
  return result;
}