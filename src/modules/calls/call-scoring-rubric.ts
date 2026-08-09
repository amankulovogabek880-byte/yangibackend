
export const CALL_SCORING_RUBRIC = `
═══ ENG AVVAL: BU HAQIQIY SUHBATMI, YO'QMI? ═══

Baholashni boshlashdan OLDIN, transkriptni o'qib, quyidagi turlardan AYNAN QAYSI BIRIGA to'g'ri kelishini aniqla. Bu — "callType" maydoni uchun asos, va u KEYINGI hamma ballarga (feedback.score, overallScore va h.k.) TO'G'RIDAN-TO'G'RI ta'sir qiladi:

  • "real_conversation" — agent va mijoz ikkalasi ham gapirgan, haqiqiy dialog bo'lgan (hatto qisqa yoki muvaffaqiyatsiz bo'lsa ham — asosiysi IKKI TOMON ham real gapirgan).
  • "ivr_or_voicemail" — transkriptda faqat AVTOMATIK tizim ovozi bor (masalan "Barcha operatorlar band, iltimos kuting", "1-tugmani bosing", ovozli pochta signali, robot xabari) — REAL AGENT umuman gapirmagan yoki gapirgan bo'lsa ham 1-2 so'zdan oshmagan.
  • "no_answer_or_hangup" — qo'ng'iroq ulanmagan, darhol uzilgan, yoki hech kim gapirmagan (bo'sh/deyarli bo'sh transkript).
  • "short_offtopic" — real odam (agent va/yoki mijoz) gapirgan, LEKIN suhbat sotuv/tur mavzusiga umuman aloqasi yo'q (masalan noto'g'ri raqamga qo'ng'iroq, shaxsiy gaplashuv, sinov qo'ng'irog'i) — bu ham "real_conversation"dan FARQLI, chunki baholab bo'lmaydigan mavzu.

MUHIM QOIDA — "ivr_or_voicemail" va "no_answer_or_hangup" holatlarida:
  - Agent HALI GAPIRMAGANI uchun uni baholash MUMKIN EMAS. feedback.score, saleReadiness.score, overallScore — barchasini SUN'IY RAVISHDA past (masalan 1-3 oralig'ida, "o'rtacha 5" YOKI qandaydir "standart" raqam EMAS) belgilang va buni feedback.strengths/improvements'da ANIQ tushuntiring (masalan: "Agent bu qo'ng'iroqda umuman gapirmadi — faqat avtomatik IVR javob berdi, shuning uchun ko'nikma baholanmaydi").
  - churnRisk va saleProbability'ni HAM shu holatga mos (odatda past ishonch bilan, lekin real vaziyatni aks ettirib) belgilang — "standart" 30/40/50 kabi raqamlarni takrorlab qo'ymang, HAR BIR qo'ng'iroq uchun transkriptning o'ziga qarab HAQIQIY, farqlanuvchi baho bering.
  - summary'da albatta ANIQ yozing: mijoz nima demoqchi bo'lgani/nima uchun qo'ng'iroq qilgani (agar transkriptdan bilinsa — masalan IVR menyusida qaysi tugmani bosgani, qanday savol takrorlangani), va nima uchun real agent bilan gaplasholmagani.

"short_offtopic" holatida ham xuddi shunday — sotuv ko'nikmalari baholanmaydi (past/N/A bo'lsin), LEKIN summary'da suhbat AYNAN NIMA HAQIDA bo'lgani (mavzusi) albatta yozilsin — "off-topic edi" deb qisqa o'tib ketmang, ANIQ nima gaplashilganini ayting.

ENG MUHIM: har bir qo'ng'iroq — ALOHIDA holat. Agar 5 ta ketma-ket IVR qo'ng'iroqni tahlil qilsangiz ham, ularning ballari BIR XIL BO'LISHI SHART EMAS (masalan biттasida IVR faqat 1 marta takrorlangan, boshqasida 3 marta — bu farqni ballarga aks ettiring) — "odatiy" yoki "standart" bitta raqamni har safar qaytarish (masalan doim 8, doim 50%) — bu XATO va yo'l qo'yilmaydi. Transkriptning o'zidagi haqiqiy tafsilotlarga qarab baho bering.

═══ MUKAMMAL (PERFECT) SUHBAT QANDAY BO'LADI (faqat "real_conversation" uchun) ═══

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