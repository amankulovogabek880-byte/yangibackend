# Omon CRM — Deployment va O'rnatish

## Talablar
- Node.js >= 18.x  
- PostgreSQL >= 14
- npm >= 8

---

## 1. O'rnatish

```bash
cd OMON-BACKEND-FINAL

# Paketlarni o'rnating
npm install --legacy-peer-deps

# .env faylini yarating
cp .env.example .env
```

## 2. .env to'ldirish

`.env` faylini oching va to'ldiring:

```env
DATABASE_URL="postgresql://postgres:SIZNING_PAROLINGIZ@localhost:5432/tourcrm"
JWT_ACCESS_SECRET="kamida-32-belgili-kalit-bu-yerga"
JWT_REFRESH_SECRET="boshqa-32-belgili-kalit-bu-yerga"
ENCRYPTION_KEY="exactly-32-characters-key-here!!"
CORS_ORIGINS=*
```

**Secret key yaratish:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Database yaratish

```bash
# psql ga kiring
psql -U postgres

# Database yarating
CREATE DATABASE tourcrm;
\q
```

## 4. Schema va seed (MUHIM)

> ⚠️ **Har yangi deploy da shu ketma-ketlikni bajaring!**

```bash
# Jadvallarni yangilang (yangi columnlar uchun MUHIM!)
npx prisma db push

# Demo ma'lumotlar yuklash  
npm run db:seed
```

> 💡 **Round-Robin ishlamasa**: `npx prisma db push` qilmagan bo'lsangiz `lastAssignedAt` column DB da yo'q bo'ladi va leadlar tayinlanmaydi. Har doim `db push` → `db:seed` ketma-ketligini bajaring.

**Seed dan keyin login ma'lumotlari:**

| Rol            | Email              | Parol          |
|----------------|--------------------|----------------|
| Platform Owner | owner@omoncrm.uz   | Owner@123456!  |
| Tenant Admin   | admin@demo.uz      | Admin@123456!  |
| Agent          | aziz@demo.uz       | Agent@123456!  |
| Agent          | malika@demo.uz     | Agent@123456!  |

## 5. Ishga tushirish

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

---

## ⚠️ Login ishlamasa

**Sabab 1:** Ko'p marta noto'g'ri parol kiritilgan → hisob 15 daqiqa bloklangan.

**Yechim:** Seed ni qayta ishga tushiring:
```bash
npm run db:seed
```

**Sabab 2:** Database da eski parol hash bor.

**Yechim:** `npm run db:seed` — har safar seed ishlatilganda parollar yangilanadi.

**Sabab 3:** `.env` da `DATABASE_URL` noto'g'ri.

**Tekshirish:**
```bash
npx prisma db push
# Xato chiqmasa - database to'g'ri ulangan
```

---

## PM2 bilan Production

```bash
npm install -g pm2
npm run build
pm2 start dist/src/main.js --name "omon-crm"
pm2 startup && pm2 save
```

## Health Check

```bash
curl http://localhost:3000/health
# {"status":"ok","database":"connected",...}
```
