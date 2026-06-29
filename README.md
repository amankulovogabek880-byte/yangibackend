# Omon CRM — Backend

Multi-tenant CRM tizimi — travel agentliklar uchun.

## Texnologiyalar
- **NestJS** — Backend framework
- **PostgreSQL** — Database
- **Prisma** — ORM
- **JWT** — Autentifikatsiya
- **Socket.io** — Real-time

## O'rnatish

### Talablar
- Node.js >= 18
- PostgreSQL >= 14
- npm >= 8

### 1. O'rnatish
```bash
npm install
```

### 2. .env sozlash
```bash
cp .env.example .env
# .env faylini to'ldiring (DATABASE_URL, JWT secrets, ENCRYPTION_KEY)
```

### 3. Database
```bash
npm run db:push    # Schema yaratish
npm run db:seed    # Demo ma'lumotlar
```

### 4. Ishga tushirish
```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Demo login
```
Owner:  owner@omoncrm.uz   / Owner@123456!
Admin:  admin@demo.uz      / Admin@123456!
Agent:  agent@demo.uz      / Agent@123456!
```

## API Documentation
- Swagger: `http://localhost:3000/api/docs`
- Health: `http://localhost:3000/health`

## Asosiy endpointlar
```
POST /api/v1/auth/login        — Kirish
GET  /api/v1/auth/me           — Profil
GET  /api/v1/clients           — Klientlar
GET  /api/v1/bookings          — Bookinglar
GET  /api/v1/dashboard         — Dashboard
```

## Production deploy (Ubuntu)

```bash
# 1. PM2 o'rnatish
npm install -g pm2

# 2. Build
npm run build

# 3. Ishga tushirish
pm2 start dist/src/main.js --name "omon-crm-api"
pm2 save
pm2 startup
```

## Nginx sozlash
```nginx
server {
    listen 80;
    server_name api.yourdomain.uz;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```
