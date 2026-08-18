# تدقيق قدرة التطبيق

لكل متطلب في `requirements-matrix.md`: هل يستطيع هذا التطبيق ضبطه فعلًا؟

**التصنيف لا يُمنح لأن الحقل ظاهر على الشاشة.** يُمنح فقط بعد تتبع
المسار كاملًا: واجهة → حالة → متحكّم → أمر MSP → تحقق → كتابة →
إعادة قراءة. أي حلقة ناقصة تُخفّض التصنيف.

| التصنيف | معناه |
|---|---|
| `SUPPORTED` | يُقرأ ويُكتب ويُعاد قراءته للتحقق، عبر المسار الكامل. |
| `SUPPORTED READ-ONLY` | يُقرأ ويُعرض، ولا يُكتب. |
| `PARTIALLY SUPPORTED` | يُضبط ضمن شرط أو نطاق أضيق مما يسمح به البرنامج الثابت. |
| `NOT SUPPORTED` | البروتوكول يسمح، والتطبيق لا يعرضه. |
| `NOT AVAILABLE FROM MSP` | لا يوجد في عقد MSP أصلًا. لا يمكن لأي تطبيق قراءته. |
| `HARDWARE DEPENDENT` | يعتمد على عتاد قد لا يكون موجودًا. |
| `FIRMWARE DEPENDENT` | يعتمد على خيار بناء قد لا يكون مُضمّنًا. |

---

## 1 · إحساس العصا

| المتطلب | التصنيف | الشاشة | الدليل |
|---|---|---|---|
| `feedforward_jitter_factor` | `SUPPORTED` | ضبط PID · بطاقة «إحساس العصا» | البايت 54 في `MSP_PID_ADVANCED`، يُكتب ويُعاد قراءته |
| `feedforward_averaging` | `SUPPORTED` | نفسها | البايت 50 |
| `feedforward_boost` | `SUPPORTED` | نفسها | البايت 52 |
| `rc_smoothing_auto_factor` | `SUPPORTED` | المستقبل · بطاقة التنعيم | `MSP_SET_RX_CONFIG` |
| `rc_smoothing_auto_factor_throttle` | `SUPPORTED` | نفسها | نفسه |
| `rc_smoothing_setpoint_cutoff` | `SUPPORTED` | نفسها | نفسه |
| `rc_smoothing_throttle_cutoff` | `SUPPORTED` | نفسها | نفسه |

**هذه الأسطر الثلاثة الأولى لم تكن مدعومة قبل هذه الجولة.** كانت الفجوة
الحقيقية الوحيدة في الدليل كله، وأُغلقت — التفاصيل في `gaps.md`.

## 2 · المحركات والفلاتر

| المتطلب | التصنيف | الشاشة | ملاحظة |
|---|---|---|---|
| `dshot_bidir` | `SUPPORTED` | المحركات · إعدادات | مشروط ببروتوكول DShot |
| `motor_poles` | `SUPPORTED` | المحركات · إعدادات | — |
| `motor_pwm_protocol` | `SUPPORTED` | المحركات · إعدادات | — |
| `dyn_idle_min_rpm` | `SUPPORTED` | ضبط PID · Dynamic Idle | 0 – 200، مطابق للبرنامج الثابت |
| `dyn_notch_count` · `_q` · `_min_hz` · `_max_hz` | `PARTIALLY SUPPORTED` | ضبط PID · Dynamic Notch | **يُعدَّل فقط إذا أثبتت القراءة أن الميزة نشطة.** لا يسمح التطبيق بتفعيلها على بناء لم يثبت دعمه، ولا بتعطيلها. |
| `gyro_lpf1` (ثابت أو ديناميكي) | `PARTIALLY SUPPORTED` | ضبط PID · Gyro LPF1 | الوضع مثبت من القراءة، لا يُبدّل |
| `dterm_lpf1` (ثابت أو ديناميكي) | `PARTIALLY SUPPORTED` | ضبط PID · D-term LPF1 | نفس القيد |
| `thrust_linear` | `NOT SUPPORTED` | — | موجود في `MSP_PID_ADVANCED` ولا يعرضه التطبيق |
| `rpm_filter_*` (harmonics, q, weights…) | `NOT SUPPORTED` | — | يُضبط من سطر الأوامر |
| `simplified_*` (منزلقات الضبط) | `NOT SUPPORTED` | — | قرار مقصود: منزلقات مجرّدة تخفي القيمة الفعلية |

**قيد Dynamic Notch مقصود وليس نقصًا.** تفعيل فلتر على بناء لم تُثبت
قراءته دعمه يعني إرسال قيم تفعيل تخمينية إلى متحكم طيران.

## 3 · الرابط والراديو

| المتطلب | التصنيف | الشاشة |
|---|---|---|
| `serialrx_provider` | `SUPPORTED` | المستقبل · المصدر |
| منفذ UART للمستقبل | `SUPPORTED` | المنافذ |
| `rssi_channel` | `SUPPORTED` | المستقبل |
| خريطة القنوات (AETR/TAER) | `SUPPORTED` | المستقبل |
| المناطق الميتة (deadband) | `SUPPORTED` | المستقبل |
| قراءة القنوات الحيّة | `SUPPORTED READ-ONLY` | المستقبل · المراقب الحي |
| معدل الرابط (250Hz / 500Hz…) | `NOT AVAILABLE FROM MSP` | — · يُضبط في الراديو والمستقبل، لا في متحكم الطيران |
| **جودة الرابط (LQ)** | `NOT AVAILABLE FROM MSP` | — · انظر أدناه |

### لماذا لا توجد جودة الرابط

`MSP_ANALOG` يرسل RSSI كنسبة مئوية فقط. لا يوجد حقل `linkQuality` ولا
`rssi_dbm` في أي أمر MSP في `msp.c` (S2.2). القيمتان تصلان إلى OSD
داخل المتحكم عبر مسار التيليمتري، ولا تخرجان عبر MSP.

**النتيجة:** لا يستطيع هذا التطبيق — ولا أي تطبيق MSP — عرض LQ أو
dBm حيًّا. ويستطيع **ضبط عتبة إنذارهما** في OSD، وهذا مدعوم.
لم تُصنَّع قيمة بديلة.

## 4 · Failsafe

| المتطلب | التصنيف | الشاشة |
|---|---|---|
| `failsafe_delay` | `SUPPORTED` | Failsafe · المرحلة 1 |
| `failsafe_procedure` | `SUPPORTED` | Failsafe |
| `failsafe_throttle` | `SUPPORTED` | Failsafe |
| `failsafe_landing_time` | `SUPPORTED` | Failsafe |
| `failsafe_throttle_low_delay` | `SUPPORTED` | Failsafe |
| `failsafe_switch_mode` | `SUPPORTED` | Failsafe |
| قيم القنوات عند فقد النبض (`rxfail`) | `SUPPORTED` | Failsafe · بطاقة القنوات |

الوحدات معروضة بالثواني للمستخدم، ومخزَّنة بأعشار الثانية كما يريدها
البرنامج الثابت. التحويل ثنائي الاتجاه ومثبت باختبارات.

## 5 · GPS و GPS Rescue

| المتطلب | التصنيف | الشاشة |
|---|---|---|
| كل معاملات GPS Rescue الإحدى عشرة | `SUPPORTED` | Failsafe · بطاقة GPS Rescue |
| `feature GPS` | `SUPPORTED` | GPS |
| `gps_provider` · `sbas` · `auto_config` · `galileo` | `SUPPORTED` | GPS |
| `gps_set_home_point_once` | `SUPPORTED` | GPS |
| عدد الأقمار الحي | `SUPPORTED READ-ONLY` | GPS |
| الموقع والمسافة إلى Home والاتجاه | `SUPPORTED READ-ONLY` | GPS |
| دقة تحديد الموقع (PDOP) | `SUPPORTED READ-ONLY` | GPS · مصنّفة بنطاقات Betaflight نفسها (S3.1) |
| **نوع التثبيت (Fix Type: 2D/3D)** | `NOT AVAILABLE FROM MSP` | — · `MSP_RAW_GPS` يرسل بتًا واحدًا: مثبَّت أو لا |
| **HDOP / VDOP** | `NOT AVAILABLE FROM MSP` | — · `MSP_RAW_GPS` يرسل `pdop` وحده |

`gps_rescue_*` مصنّفة `HARDWARE DEPENDENT` عمليًا: بلا وحدة GPS
موصولة لا معنى لأي منها. التطبيق يميّز صراحةً بين «الأمر غير مدعوم في
هذا البناء» و«لم تصل إجابة»، ولا يخلط بينهما.

## 6 · OSD

| المتطلب | التصنيف | الشاشة |
|---|---|---|
| `osd_rssi_dbm_alarm` | `SUPPORTED` | OSD · التنبيهات |
| `osd_link_quality_alarm` | `SUPPORTED` | OSD · التنبيهات |
| `osd_rssi_alarm` · `osd_cap_alarm` · `osd_alt_alarm` | `SUPPORTED` | OSD · التنبيهات |
| مواضع العناصر | `SUPPORTED` | OSD · العناصر (سحب حقيقي) |
| التحذيرات والإحصاءات والمؤقتات | `SUPPORTED` | OSD |
| نظام الفيديو والملف | `SUPPORTED` | OSD |
| OSD أصلًا | `FIRMWARE DEPENDENT` | يعتمد على خيار البناء |

## 7 · VTX

| المتطلب | التصنيف | الشاشة |
|---|---|---|
| النطاق والقناة والتردد | `SUPPORTED` | مرسل الفيديو |
| مستوى الطاقة | `SUPPORTED` | مرسل الفيديو |
| Pit mode وتردده | `SUPPORTED` | مرسل الفيديو |
| طاقة منخفضة عند DISARM | `SUPPORTED` | مرسل الفيديو |
| جدول النطاقات ومستويات الطاقة | `SUPPORTED READ-ONLY` | مرسل الفيديو |
| وجود VTX أصلًا | `HARDWARE DEPENDENT` | يحتاج SmartAudio/Tramp موصولًا ومضبوطًا في المنافذ |

## 8 · الأوضاع والمفاتيح

| المتطلب | التصنيف | الشاشة |
|---|---|---|
| ربط وضع بقناة AUX ونطاق | `SUPPORTED` | الأوضاع |
| الأوضاع المتاحة | `FIRMWARE DEPENDENT` | تُقرأ من `MSP_BOXNAMES`، فلا يُعرض إلا ما يدعمه البناء |
| مراقبة النطاق الحيّة | `SUPPORTED READ-ONLY` | الأوضاع |

الاعتماد على `MSP_BOXNAMES` هو الصواب: البناء الذي لا يحتوي GPS Rescue
لا يُظهر الوضع، بدل أن يعرض خيارًا لا يعمل.

## 9 · الإعدادات العامة

| المتطلب | التصنيف | ملاحظة |
|---|---|---|
| اسم الطائرة واسم الطيار | `SUPPORTED` | — |
| زاوية الكاميرا · small angle · auto-disarm | `SUPPORTED` | — |
| `pid_process_denom` | `SUPPORTED` | — |
| الميزات (OSD, LED, Airmode, SoftSerial…) | `PARTIALLY SUPPORTED` | عشر ميزات فقط، ومحجوبة إذا لم يدعمها البناء |
| **`feature GPS`** | يُضبط من شاشة GPS لا من الإعدادات العامة | ليس نقصًا، بل مكان مختلف |
| `feature RSSI_ADC` · `TELEMETRY` | `NOT SUPPORTED` | خارج قائمة الميزات العشر |

---

## الخلاصة

العدّ أدناه هو عدد **صفوف هذا الملف**، لا عدد الإعدادات: بعض الصفوف
تجمع إعدادات متقاربة (مثل صف واحد لمعاملات GPS Rescue الإحدى عشرة،
وصف واحد لأربعة حقول Dynamic Notch).

| التصنيف | عدد الصفوف |
|---|---|
| `SUPPORTED` | 41 |
| `SUPPORTED READ-ONLY` | 6 |
| `PARTIALLY SUPPORTED` | 4 |
| `NOT SUPPORTED` | 4 |
| `NOT AVAILABLE FROM MSP` | 4 |
| `FIRMWARE DEPENDENT` | 2 |
| `HARDWARE DEPENDENT` | 1 |
| صف إحالة (مكان الإعداد لا تصنيفه) | 1 |
| **المجموع** | **63** |

**كل نمط من الأنماط الخمسة قابل للضبط بالكامل من هذا التطبيق** فيما
يخص متطلباته الإلزامية. الفجوات المتبقية كلها في إعدادات مصنّفة
اختيارية في مصفوفة المتطلبات، أو غير موجودة في MSP أصلًا.
