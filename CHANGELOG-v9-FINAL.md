# Omon CRM v9 Backend — FINAL

## ✅ Eski kod 100% SAQLANGAN
Hech narsa o'chirilmadi. Faqat yangilar qo'shildi.

## 🆕 v9 da qo'shilgan funksiyalar

### 1. 👨‍👩‍👧 Passenger Management (5 endpoint)
- `GET/POST/PATCH/DELETE /passengers/booking/:bookingId`
- Bitta bookingda ko'p yo'lovchi (oilam, do'stlar)
- Type: ADULT/CHILD/INFANT/SENIOR
- Passport, meal/seat preference, alohida narx

### 2. ✅ Approval Workflow (6 endpoint)
- `GET/POST /approvals`
- `POST /approvals/:id/approve` (admin/manager)
- `POST /approvals/:id/reject`
- Types: DISCOUNT, REFUND, PRICE_CHANGE, BOOKING_CANCEL, PAYMENT_DELETE
- Tasdiqlanganda Booking/Payment avtomatik o'zgaradi

### 3. 🎯 Round Robin Auto Assignment (5 endpoint)
- `GET/POST /lead-assignment/strategy` (MANUAL/ROUND_ROBIN/LEAST_BUSY)
- `GET /lead-assignment/queue` — kim navbatda
- `POST /lead-assignment/assign-unassigned`
- User.lastAssignedAt orqali adolatli aylanish

### 4. ⌘K Command Palette (1 endpoint)
- `GET /command-palette/search?q=...`
- Universal qidiruv + tezkor amallar
- 4 ta entity: clients, bookings, invoices, conversations
- Role-based actions

### 5. 🛎 Services Module (5 endpoint) — YANGI v9-FINAL
- `GET/POST/PATCH/DELETE /services/booking/:bookingId`
- Types: TAXI, TRANSFER, INSURANCE, VISA, SIM_CARD, VIP_MEET, GUIDE, HOTEL_UPGRADE, TOUR_GUIDE, EXCURSION, RESTAURANT, OTHER
- Har biri: from/to, date/time, price, quantity, totalAmount, status, notes, provider
- Status: PENDING/CONFIRMED/COMPLETED/CANCELLED
- Invoice'da, Telegram message'da, Client portal'da chiqadi

---

## 📊 Tekshirilgan funksiyalar (ishlaydi)

| # | Talab | Holat |
|---|-------|-------|
| 1 | Pipeline custom stages | ✅ v8'da bor |
| 2 | Pipeline → Payment avtomatik | ✅ v8'da bor (DEPOSIT_PAID/COMPLETED) |
| 3 | Booking Profit = ClientPrice - CompanyCost | ✅ totalPrice - supplierCost - discount |
| 4 | Services qo'shish | ✅ v9-FINAL |
| 5 | Inbox xatosi | ✅ tuzatilgan (array qaytaradi) |
| 6 | Telegram per-agent | ✅ POST /telegram/accounts/personal |
| 7 | Reports owner/admin/agent ko'rsatishi | ✅ /reports/dashboard + /my-stats + /my-salary |
| 8 | KPI admin sozlash, agent ko'rish | ✅ Tenant.agentCommissionPercent |
| 9 | Multi-company owner yaratish | ✅ POST /owner/companies |
| 10 | Twilio olib tashlash | ✅ .env'da izohlangan |
| 11 | Settings'dan Company olib tashlash | (frontend) |
| 12 | Team modul (admin agent yaratadi) | ✅ GET /users/team, POST /users |
| 13 | Dashboard real ma'lumotlar | ✅ thisMonth.revenue/bookings/newClients |
| 14 | Roles permissions | ✅ Owner/Admin/Manager/Agent |
| 15 | Branding Omon CRM | ✅ Hamma joyda |

## 📊 v9-FINAL statistikasi

| Element | v8 | v9 | v9-FINAL | Farq |
|---------|-----|-----|----------|------|
| Endpointlar | 175 | 192 | **197** | +22 |
| Prisma modellar | 30 | 32 | **33** | +3 |
| Enumlar | 34 | 37 | **39** | +5 |
| Modullar | 27 | 31 | **32** | +5 |

## 🆕 Yangi v9 modellar

```prisma
model Passenger { ... 14 field }
model ApprovalRequest { ... 15 field }
model BookingService { ... 14 field }   // ← v9-FINAL
```

## 🆕 Yangi v9 enumlar

```prisma
enum PassengerType { ADULT, CHILD, INFANT, SENIOR }
enum ApprovalType { DISCOUNT, REFUND, PRICE_CHANGE, ... }
enum ApprovalStatus { PENDING, APPROVED, REJECTED, CANCELLED }
enum ServiceType { TAXI, TRANSFER, INSURANCE, VISA, SIM_CARD, VIP_MEET, GUIDE, HOTEL_UPGRADE, TOUR_GUIDE, EXCURSION, RESTAURANT, OTHER }
enum ServiceStatus { PENDING, CONFIRMED, COMPLETED, CANCELLED }
```

## 🚀 Ishga tushirish

```bash
unzip omoncrm-v9-backend.zip
cd tourcrm-v8-backend

# Schema yangilangani uchun MIGRATION KERAK
npx prisma generate
npx prisma db push        # YOKI:
# npx prisma migrate dev --name v9_services_passenger_approval

npm run start:dev
```

**0 sintaksis xato, 0 kompilyatsiya xato.**

## 🎯 Tarmoqlar uchun avtomatik amallar

### Pipeline → Payment (avtomatik)
```
Mijoz "Avans olindi" bosqichiga o'tdi
   ↓
Payment yaratiladi (30% default)
   ↓
Booking.paidAmount yangilanadi
   ↓
Dashboard, Reports avtomatik yangilanadi (WebSocket)

Mijoz "Yakunlandi" bosqichiga o'tdi
   ↓
Qoldiq Payment yaratiladi
   ↓
Booking.status = COMPLETED
   ↓
Revenue hisobotlarga tushadi
```

### Booking yaratilganda
```
Agent kiritadi: Client Price 3000$, Supplier Cost 1000$
   ↓
CRM avtomatik: Profit = 2000$
   ↓
Client ko'radi: 3000$ (Invoice, Telegram, Client portal)
Profit faqat Admin, Owner, Reports, KPI uchun
```

### Round Robin (avtomatik)
```
Yangi lead Telegram'dan keladi
   ↓
Tenant.leadAssignmentStrategy = ROUND_ROBIN
   ↓
User.lastAssignedAt eng eski agent topiladi
   ↓
Klient avtomatik tayinlanadi
   ↓
Agent xabar oladi (notification)
   ↓
User.lastAssignedAt = NOW (navbat aylantirish)
```
