# سجل المصادر — دليل أنماط الطيران

كل رقم في هذا الدليل يعود إلى سطر في هذا الملف. إذا لم يكن للرقم مصدر هنا،
فهو ليس رقمًا — بل توجيه (Type C) ومكتوب على هذا الأساس.

**تاريخ الجمع:** 2026-08-18
**لم تُستخدم أي مشاركة منتدى، ولا فيديو، ولا رأي فردي، كمصدر لأي قيمة.**

---

## ترتيب الأولوية المتبع فعليًا

1. مكتبة الإعدادات الرسمية من Betaflight (`firmware-presets`) — لأنها الوحيدة
   التي تربط قيمة برقم بنمط طيران باسم صريح، وهي مُراجَعة داخل المشروع.
2. مصدر البرنامج الثابت (`settings.c`, `msp.c`, `failsafe.c`) — للحدود
   والوحدات وحضور الحقل من عدمه.
3. `betaflight-configurator` — لتفسير القيم (مثل نطاقات جودة الموقع).
4. طبقة البروتوكول في هذا المستودع — لإثبات أن التطبيق يقرأ/يكتب الإعداد فعلًا.

---

## S1 — مكتبة الإعدادات الرسمية (firmware-presets)

المصدر: `raw.githubusercontent.com/betaflight/firmware-presets/master`
جُلب: 2026-08-18 · الفهرس: 471 إعدادًا، منها 205 بحالة `STATUS: OFFICIAL`
**كل ملف مستعمل أدناه حالته `OFFICIAL`.** لم يُستعمل أي إعداد بحالة
`COMMUNITY` أو `EXPERIMENTAL` كمصدر لأي قيمة في هذا الدليل.

| المعرف | الملف | الإصدار | المؤلف | يُستعمل في |
|---|---|---|---|---|
| S1.1 | `presets/2025.12/rc_link/generic/150hz_cinematic.txt` | 2025.12 | Ivan Efimov (Limon) | السينمائي |
| S1.2 | `presets/2025.12/rc_link/generic/150hz_ultra_cinematic.txt` | 2025.12 | Ivan Efimov (Limon) | السينمائي |
| S1.3 | `presets/2025.12/rc_link/generic/250hz_freestyle.txt` | 2025.12 | Ivan Efimov (Limon) | الحر |
| S1.4 | `presets/2025.12/rc_link/generic/500hz_race.txt` | 2025.12 | Ivan Efimov (Limon) | السباق |
| S1.5 | `presets/2025.12/rc_link/ghost/long_range.txt` | 2025.12 | Ivan Efimov (Limon) | المدى الطويل |
| S1.6 | `presets/2025.12/rc_link/elrs/elrs_250hz.txt` | 2025.12 | ctzsnooze, SupaflyFPV | الحر · السباق |
| S1.7 | `presets/2025.12/rc_link/tbs/crossfire_150hz.txt` | 2025.12 | Ivan Efimov (Limon) | المدى الطويل |
| S1.8 | `presets/2025.12/tune/karate/karate_whoop_2025_12.txt` | 2025.12 | sugarK | الوووب |
| S1.9 | `presets/2025.12/tune/karate/karate_race_2025.txt` | 2025.12 | sugarK | السباق |
| S1.10a | `presets/2025.12/tune/supafly_fpv/…Freestyle_3_4_Inch…` | 2025.12 | SupaflyFPV | الحر (3–4") |
| S1.10b | `presets/2025.12/tune/supafly_fpv/…Freestyle_5_Inch…` | 2025.12 | SupaflyFPV | الحر (5") |
| S1.10c | `presets/2025.12/tune/supafly_fpv/…Freestyle_7_Inch…` | 2025.12 | SupaflyFPV | الحر (7") · المدى الطويل |
| S1.11a | `presets/4.5/tune/uav_tech/UAV_tech_Cinewhoop.txt` | 4.5 | UAV Tech (Mark Spatz) | السينمائي (Cinewhoop) |
| S1.11b | `presets/4.5/tune/uav_tech/UAV_tech_Cinelog.txt` | 4.5 | UAV Tech (Mark Spatz) | السينمائي |
| S1.11c | `presets/4.5/tune/uav_tech/UAV_tech_6-7in.txt` | 4.5 | UAV Tech (Mark Spatz) | المدى الطويل |
| S1.11d | `presets/4.5/tune/uav_tech/UAV_tech_5in_Race_500-575.txt` | 4.5 | UAV Tech (Mark Spatz) | السباق |
| S1.12a | `presets/2025.12/tune/defaults.txt` | 2025.12 | Betaflight | الأصل المرجعي للضبط |
| S1.12b | `presets/2025.12/rates/defaults.txt` | 2025.12 | Betaflight | الأصل المرجعي للـ Rates |
| S1.12c | `presets/2025.12/osd/defaults.txt` | 2025.12 | Betaflight | الأصل المرجعي للـ OSD |
| S1.12d | `presets/2025.12/other/reset_gps.txt` | 2025.12 | Betaflight | GPS و GPS Rescue |
| S1.12e | `presets/4.5/filters/defaults.txt` | 4.5 | Betaflight | الأصل المرجعي للفلاتر |
| **S1.13** | `presets/2025.12/rc_link/defaults.txt` | 2025.12 | Betaflight | **الأصل المرجعي للرابط — يضمّنه كل إعداد RC_LINK رسمي** |

**لماذا S1.13 حاسم.** ملفه يحمل تعليقًا صريحًا من Betaflight:
«NOTE TO AUTHORS: Always include this Preset in any RC Preset»، وكل إعداد
من S1.1 إلى S1.7 يضمّنه فعلًا قبل أن يكتب سطرًا واحدًا. أي إعداد **لا**
يذكره الإعداد الخاص بنمط ما يبقى على قيمة هذا الملف — لا على صفر، ولا على
«غير مضبوط». هذا ما يحدد قيمة `feedforward_boost` لكل من السينمائي والحر:

```
set feedforward_averaging = 2_POINT
set feedforward_jitter_factor = 7
set feedforward_boost = 15
set rc_smoothing_auto_factor = 30
set rc_smoothing_auto_factor_throttle = 30
set rc_smoothing_setpoint_cutoff = 0
set rc_smoothing_throttle_cutoff = 0
```

**اختصارات العائلات.** حين يتغيّر إعداد عبر مقاسات عائلة كاملة، يُشار
إلى العائلة لا إلى ملف واحد:

| الاختصار | يعني |
|---|---|
| **S1.10** | عائلة SupaflyFPV Freestyle كاملة: S1.10a + S1.10b + S1.10c |
| **S1.11** | عائلة UAV Tech كاملة: S1.11a + S1.11b + S1.11c + S1.11d |
| **S1.12** | ملفات الأصول الرسمية كاملة: S1.12a … S1.12e |

**ملاحظة على الإصدارات.** الملفات المؤرخة `4.5` ما زالت منشورة في المكتبة
الرسمية ومصنفة `OFFICIAL`، وتُستعمل هنا فقط للفروق التي تعتمد على حجم
الطائرة (الفلاتر والـ thrust_linear) لا للقيم التي تغيّرت بين الإصدارين.
حيث اختلف `2025.12` عن `4.5` في نفس الإعداد، تُعتمد قيمة `2025.12`.

---

## S2 — مصدر البرنامج الثابت

نسخ مثبتة داخل هذه الجلسة من `betaflight/src/main/`:

| المعرف | الملف | يُستعمل لـ |
|---|---|---|
| S2.1 | `cli/settings.c` | الحدود الدنيا والعليا لكل إعداد، وأسماء القيم المعدودة |
| S2.2 | `msp/msp.c` | ما يُرسل فعلًا في كل أمر MSP، وما لا يوجد فيه |
| S2.3 | `flight/failsafe.c` | مراحل Failsafe والوحدات (عُشر الثانية) |
| S2.4 | `drivers/motor.c` · `flight/mixer.c` | بروتوكولات المحركات و Dynamic Idle |
| S2.5 | `sensors/gps.h` · `io/gps.c` | حقول GPS المتاحة فعلًا |

`settings.c` هو المصدر الوحيد المقبول للحدود في هذا الدليل: MSP لا يُقصّ
القيم عند الاستقبال، فالحد المكتوب هنا هو الحد الذي يمنع كتابة قيمة
يقبلها المتحكم ويطير بها.

---

## S3 — betaflight-configurator

نسخة محلية `v2026.12.0-alpha`.

| المعرف | الموضع | يُستعمل لـ |
|---|---|---|
| S3.1 | `src/components/tabs/GpsTab.vue` → `getPositionalDopQuality()` | نطاقات جودة الموقع (1 / 2 / 5 / 10 / 20) |
| S3.2 | `src/js/msp/MSPHelper.js` | مواضع البايتات في `MSP_PID_ADVANCED` |

---

## S4 — هذا المستودع (إثبات القدرة لا مصدر قيمة)

لا يُستمد من هنا أي رقم موصى به. يُستمد منه فقط الجواب على سؤال
«هل يستطيع التطبيق ضبط هذا؟»، وهو ما يوثّقه `capability-audit.md`.

---

## تصنيف الثقة المستعمل في كل الملفات

| التصنيف | معناه |
|---|---|
| `HIGH` | القيمة منسوخة حرفيًا من إعداد رسمي أو من مصدر البرنامج الثابت. |
| `MEDIUM` | نطاق مُستخرج من إعدادين رسميين أو أكثر يختلفان حسب المنصة. |
| `DIRECTIONAL` | لا رقم. اتجاه فقط، لأن الرقم الصحيح يعتمد على عتادك. |

## تصنيف نوع التوصية (المرحلة 4)

| النوع | معناه | مثال |
|---|---|---|
| **A — قيمة مباشرة** | رقم رسمي لهذا النمط بعينه. | `feedforward_jitter_factor = 3` للسباق (S1.4) |
| **B — نطاق مرجعي** | رقمان يحدّان ما تفعله الإعدادات الرسمية عبر المنصات. | `dyn_idle_min_rpm` بين 30 و40 لمقاس 5" (S1.9, S1.10b) |
| **C — اتجاه فقط** | «ارفع/اخفض» بلا رقم، لأن الرقم يعتمد على عتادك. | إنذار RSSI dBm |

---

## ما لم يُستعمل عمدًا

- لا مصدر مجتمعي منفرد (منتدى، فيديو، منشور) لأي قيمة.
- لا إعدادات بحالة `COMMUNITY` من المكتبة الرسمية، رغم توفرها.
- لا قيم من ذاكرة أو عادة شخصية. ما لم يكن له سطر هنا، فهو من النوع C.
