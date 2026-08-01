// ═══════════════════════════════════════════════════════════════════════
// AI QO'NG'IROQ BAHOLASH MEZONLARI — BU FAYLNI ISTAGANCHA TAHRIRLANG
// ═══════════════════════════════════════════════════════════════════════
//
// BU YERDA NIMA BOR: quyidagi RUBRIC matni — AI (Claude) har bir
// qo'ng'iroqni tahlil qilganda "qanday suhbat YAXSHI, qanday suhbat
// MUKAMMAL (perfect) va agentni AYNAN QANDAY MEZONLAR (points) bo'yicha
// baholash kerak" degan savolga javob beruvchi QOIDALAR TO'PLAMI.
//
// NIMA UCHUN ALOHIDA FAYL: bu qoidalar — sof matn, texnik kod emas.
// Siz bu yerni istalgancha o'zgartira olasiz (masalan yangi mezon
// qo'shish, mavjudini kuchaytirish/yumshatish, misollarni o'zingizning
// tajribangizga moslashtirish) — calls.module.ts faylidagi boshqa
// qismlarga (JSON formatini o'qish, ballarni saqlash va h.k.) UMUMAN
// TEGMASDAN. Ya'ni bu — "qonun" qismi, qolgani — "dastur" qismi.
//
// QANDAY TAHRIRLASH KERAK:
//  1. Faqat quyidagi CALL_SCORING_RUBRIC ichidagi MATNNI o'zgartiring.
//  2. Backtick (`) belgilarini o'chirmang — ular JavaScript matn
//     boshi/oxirini bildiradi.
//  3. JSON kalitlari haqida (masalan "feedback", "score", "mistakes")
//     GAPIRMANG / O'ZGARTIRMANG — ular calls.module.ts faylida ALOHIDA
//     va qattiq belgilangan, bu yerda ularga tegish shart emas va tavsiya
//     etilmaydi (aks holda AI javobi noto'g'ri formatda qaytishi mumkin).
//  4. O'zgartirgandan keyin serverni qayta ishga tushirish (deploy/restart)
//     kifoya — boshqa hech narsa kerak emas.
//
// TIL: matn qanday tilda yozilsa, AI xulosa/fikrlarni o'sha yo'nalishda
// (lekin baribir o'zbek tilida, calls.module.ts'dagi asosiy qoida bo'yicha)
// yozadi — shuning uchun bu yerga misollarni ham o'zbekcha yozgan maqsadga
// muvofiq.
export const CALL_SCORING_RUBRIC = `
═══ MUKAMMAL (PERFECT) SUHBAT QANDAY BO'LADI ═══

Quyidagi bosqichlar to'liq va sifatli bajarilgan bo'lsa, suhbat "mukammal"ga yaqin deb baholanadi:

1. SALOMLASHISH VA ALOQA O'RNATISH — agent o'zini va agentlikni tanishtiradi, ohangi issiq va samimiy, mijozni ismi bilan chaqiradi (agar ism ma'lum bo'lsa), suhbatni shoshilinch emas, tinch boshlaydi.

2. EHTIYOJNI ANIQLASH — agent DARHOL narx yoki turni aytavermaydi, avval ochiq savollar bilan aniqlaydi: qayerga bormoqchi, qachon, nechta odam (kattalar/bolalar), taxminiy byudjet, avval shu yo'nalishga borganmi, nimasi muhim (dam olish/faol sayohat/oila bilan va h.k.).

3. FAOL TINGLASH — agent mijozning gapini bo'lmaydi, aytganlarini qisqa o'z so'zi bilan qaytarib tasdiqlaydi ("Demak, siz avgust oyida, 2 kattalar bilan, dengiz bo'yida dam olishni xohlaysiz, to'g'rimi?"), savollariga to'g'ridan-to'g'ri javob beradi.

4. TAKLIFNI MOSLASHTIRIB TAQDIM ETISH — agent umumiy "menyu" o'qib bermaydi, aynan mijoz aytgan ehtiyojlarga mos 1-2 variant taklif qiladi va NEGA aynan shu variant mos kelishini tushuntiradi (narxni emas, FOYDANI birinchi o'ringa qo'yadi: masalan "bu mehmonxona plyajga eng yaqin, shuning uchun kichik bolangiz bilan qulay bo'ladi").

5. E'TIROZLARGA ISHONCHLI JAVOB — mijoz shubha yoki e'tiroz bildirsa (narx qimmat, o'ylab ko'raman, ishonmayman va h.k.), agent himoyalanmaydi va bahslashmaydi — tushunish bildiradi, keyin faktlar/argumentlar bilan tinch javob beradi, kerak bo'lsa muqobil variant (masalan arzonroq mehmonxona) taklif qiladi.

6. ANIQ KEYINGI QADAM BILAN YAKUNLASH — suhbat "xo'p, o'ylab ko'raman" bilan osilib qolmaydi — agent ANIQ keyingi qadamni taklif qiladi va kelishadi (masalan "Ertaga soat 15:00da qo'ng'iroq qilaman, shu vaqtgacha narxni tasdiqlab qo'yaman" yoki to'g'ridan-to'g'ri band qilishga o'tadi).

7. PROFESSIONAL OHANG — hurmatli, bosim o'tkazmaydigan, lekin ishonchli va energiyali ohang; ortiqcha jim qolish yo'q; mijozni "majburlamaydi", lekin ham qaror qabul qilishga yordam beradi (yumshoq shoshiltirish — masalan joylar kamayib qolayotgani haqida rost ma'lumot berish, yolg'on shoshiltirish EMAS).

8. ANIQLIK VA XATOSIZLIK — sana, narx, kishi soni, mehmonxona nomi kabi MUHIM ma'lumotlarni agent ANIQ va ikki marta tasdiqlab aytadi — chalkashlik yo'q.

═══ AI QAYSI NUQTALAR (POINTS) BO'YICHA AGENTNI BAHOLASHI KERAK ═══

Suhbatni tahlil qilganda, agentning "feedback.score" (1-10) ballini quyidagi 6 ta mezonga qarab, xolisona chiqar. Har bir mezon bo'yicha aniq nima yaxshi va nima yomon ekanini "strengths"/"improvements"da qisqa yoz:

  • Ehtiyojni aniqlash — agent savol berdimi yoki darhol narx/tur aytib qo'ya qoldimi?
  • Tinglash va tasdiqlash — agent mijoz gapini tingladimi, tushunganini bildirdimi, yoki o'zicha gapiraverdimi?
  • Taklifning moslashtirilganligi — taklif mijozning aytgan ehtiyojiga mos keldimi, yoki umumiy/shablon taklif bo'ldimi?
  • E'tirozga javob sifati — agent e'tirozni tinch va ishonchli yopdimi, yoki bahslashdimi/darhol taslim bo'ldimi (masalan darhol katta chegirma va'da qildimi)?
  • Yakunlash ko'nikmasi — suhbat aniq keyingi qadam bilan tugadimi, yoki "xo'p, ko'raylik" kabi noaniqlik bilan qoldimi?
  • Ohang va professionallik — agent hurmatli, bosimsiz, lekin ishonchli ohangda gapirdimi?

Eslatma: "overallScore" (0-100) — yuqoridagi agent ko'nikmasi BILAN BIRGA mijozning qiziqish darajasi va suhbat natijasini ham hisobga oladi (masalan agent juda yaxshi gapirgan bo'lsa-yu, mijoz baribir umuman qiziqmagan bo'lsa, overallScore feedback.score'dan pastroq bo'lishi mumkin — bu normal).
`.trim();