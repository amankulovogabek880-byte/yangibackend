# v9 Backend — 4 ta yangi premium funksiya

## 🆕 v9 da qo'shilgan funksiyalar

### 1. 👨‍👩‍👧 PASSENGER MANAGEMENT
Bir bookingda bir nechta yo'lovchi.

**Endpoints (5 ta):**
- `GET /passengers/booking/:bookingId` — yo'lovchilar ro'yxati
- `GET /passengers/booking/:bookingId/stats` — statistika
- `POST /passengers/booking/:bookingId` — yangi yo'lovchi
- `PATCH /passengers/:id` — tahrirlash
- `DELETE /passengers/:id` — o'chirish

**Schema:** `Passenger` model
- Shaxsiy: fullName, dateOfBirth, gender, passengerType (ADULT/CHILD/INFANT/SENIOR)
- Passport: passportNo, passportCountry, passportExpiry, nationality
- Aloqa: phone, email
- Maxsus: mealPreference, seatPreference, specialRequest
- Narx: pricePerPerson

**Misol:** Oilam (er, xotin, 2 bola) bitta booking ichida.

### 2. ✅ APPROVAL WORKFLOW
Chegirma, refund, muhim o'zgarishlar — admin tasdiqi bilan.

**Endpoints (6 ta):**
- `GET /approvals` — barcha so'rovlar (status, type filter)
- `GET /approvals/:id` — bitta so'rov tafsilotlari
- `POST /approvals` — yangi tasdiq so'rovi (agent)
- `POST /approvals/:id/approve` — tasdiqlash (admin/manager)
- `POST /approvals/:id/reject` — rad etish
- `POST /approvals/:id/cancel` — bekor qilish (agent)

**Types:** DISCOUNT, REFUND, PRICE_CHANGE, BOOKING_CANCEL, PAYMENT_DELETE, COMMISSION_OVERRIDE, OTHER

**Avtomatik amal:** Tasdiqlanganda Booking/Payment avtomatik o'zgartiriladi.

### 3. 🎯 ROUND ROBIN AUTO ASSIGNMENT
Yangi leadlarni agentlarga avtomatik adolatli taqsimlash.

**Endpoints (5 ta):**
- `GET /lead-assignment/strategy` — joriy strategiya
- `POST /lead-assignment/strategy` — strategiyani o'rnatish (MANUAL/ROUND_ROBIN/LEAST_BUSY)
- `GET /lead-assignment/queue` — kim navbatda
- `POST /lead-assignment/assign/:clientId` — bitta klientni tayinlash
- `POST /lead-assignment/assign-unassigned` — barcha tayinlanmagan klientlarni avtomatik tayinlash

**Strategiyalar:**
- **MANUAL** — qo'lda
- **ROUND_ROBIN** — User.lastAssignedAt eng eski bo'lgan agent
- **LEAST_BUSY** — eng kam active client'lik agent

### 4. ⌘K COMMAND PALETTE
Ctrl+K bossangda universal qidiruv va tezkor amallar.

**Endpoint (1 ta):**
- `GET /command-palette/search?q=...` — bitta call'da hammasi

**Qaytaradi:**
- Klientlar (5 ta)
- Bookinglar (5 ta)
- Invoicelar (5 ta)
- Suhbatlar (3 ta)
- Tezkor amallar ("Yangi mijoz", "Yangi booking", va h.k.)

**Frontend:** Local filterlash (tez)

---

## 📊 v9 statistikasi

| Element | v8 | v9 | Farq |
|---------|-----|-----|------|
| Endpointlar | 175 | **192** | +17 |
| Prisma modellar | 30 | **32** | +2 |
| Enumlar | 34 | **37** | +3 |
| Modullar | 27 | **31** | +4 |
| Notification turlari | 20 | **24** | +4 |

## 🆕 Yangi schema modellar

```prisma
model Passenger {
  id, tenantId, bookingId, booking
  fullName, dateOfBirth, gender, passengerType
  passportNo, passportCountry, passportExpiry, nationality
  phone, email
  mealPreference, seatPreference, specialRequest
  pricePerPerson
}

model ApprovalRequest {
  id, tenantId
  requesterId, requester, reviewerId, reviewer
  type, status
  entityType, entityId
  title, reason, oldValue, newValue, amount
  reviewNote, reviewedAt
}
```

## 🆕 Yangi enumlar

```prisma
enum PassengerType { ADULT, CHILD, INFANT, SENIOR }
enum ApprovalType { DISCOUNT, REFUND, PRICE_CHANGE, BOOKING_CANCEL, PAYMENT_DELETE, COMMISSION_OVERRIDE, OTHER }
enum ApprovalStatus { PENDING, APPROVED, REJECTED, CANCELLED }
```

## 🆕 Notification turlari

- `APPROVAL_REQUESTED` — admin'ga: tasdiq so'ralayapti
- `APPROVAL_APPROVED` — agentga: tasdiqlandi
- `APPROVAL_REJECTED` — agentga: rad etildi
- `CLIENT_ASSIGNED` — agentga: yangi lead avtomatik tayinlandi

## ✅ ESKI KOD SAQLANDI

Hech narsa o'chirilmadi. Faqat **yangi yo'q narsalar qo'shildi**:
- 4 ta yangi modul: `passengers`, `approvals`, `round-robin`, `command-palette`
- 2 ta yangi Prisma model
- 3 ta yangi enum
- 4 ta yangi notification turi
- User schema'siga 3 ta yangi field (lastAssignedAt, 2 ta relation)
- Booking schema'siga 1 ta yangi relation (passengers)

## 🚀 Ishga tushirish

```bash
unzip omoncrm-v9-backend.zip
cd tourcrm-v8-backend

# Schema yangilangani sababli MIGRATION kerak
npx prisma generate
npx prisma db push  # YOKI: npx prisma migrate dev --name v9_passenger_approval

npm run start:dev
```

**0 ta TypeScript xato, 0 ta sintaksis xato.**
