# بنية Web App لـ FPV-ARBCON

التاريخ: 2026-08-03
خط أساس Android المحمي: `5934aa6229eea19ccfda5fbd19b6dad1658f1752`

> **ملاحظة إعادة البناء (فرع `codex/web-app-foundation`).** الفرع المحلي
> الأصلي وcommitيه (`4d044c4`، `16b64d0`) فُقدا قبل وصولهما إلى GitHub، وقد
> تأكّد تعذّر استرجاعهما: غير موجودين في كائنات Git المحلية، ولا في
> `git fsck --lost-found`، ولا في أي مرجع بعيد، ولا في أي Pull Request،
> وواجهة GitHub تُجيب `422 No commit found`. لذلك أُعيد بناء هدف الويب من
> هذا المستند نفسه بوصفه المواصفة. بُني الفرع فوق `codex/gps-system` عند
> `6ff7449`.
>
> ما يصفه هذا المستند مُنفَّذ فعليًا الآن، باستثناء ما هو موسوم صراحةً بأنه
> يحتاج اختبار عتاد. راجع `docs/WEB_APP_STATUS.md` لحالة كل قدرة على حدة.

## القرار المعماري

الويب ليس نسخة واجهة منفصلة تعيد اختراع التطبيق. نقطة الدخول
`index.web.tsx` تشغّل الشاشات العربية نفسها عبر React Native Web، وتستخدم
النواة نفسها في `src/core`، ومنسق جلسة MSP نفسه، ونماذج Setup وMotors وPorts
وGPS وConfigurations نفسها. الاختلاف الوحيد المطلوب للاتصال هو الورقة
الأخيرة من طبقة النقل:

- Android: `NativeUsbSerialTransport.ts` ثم TurboModule الأصلي.
- Web: `NativeUsbSerialTransport.web.ts` ثم Web Serial للـMSP والمسارات
  التسلسلية، وWebUSB لـSTM32 DFU (DfuSe).

يختار Metro ملف Android ويختار Vite ملف `.web.ts`. لا يوجد شرط منصة داخل
مرمّز MSP أو محلل الإطارات أو منطق الحفظ والسلامة.

## مسار البيانات الحقيقي

```text
Web Serial bytes
  → NativeUsbSerialTransport.web.ts
  → UsbSerialTransportClient
  → RNMspTransport / MspSessionCoordinator
  → shared MSP parser, queue, telemetry and state
  → Arabic Setup / Motors / Ports / GPS / Configurations screens
```

المسح العادي يستعمل `navigator.serial.getPorts()` فقط، أي يعرض المنافذ التي
سبق أن منحها المستخدم الإذن ولا يفتح نافذة إذن من تلقاء نفسه. زر «اختيار جهاز
USB» هو وحده الذي يستدعي `requestPort()` نتيجة نقرة المستخدم. القراءة لها
قارئ واحد فقط لكل جلسة، والكتابة ترسل البايتات نفسها، والفصل يلغي ملكية الجلسة
ويرسل حدث detach إلى المنسق المشترك.

اختيار DFU يتبع القاعدة نفسها: `getDevices()` يعرض أجهزة WebUSB التي سبق
السماح بها فقط، وزر «اختيار STM32 DFU» هو وحده الذي يستدعي `requestDevice()`.
لا توجد نافذة إذن أثناء المسح الدوري ولا نجاح مصطنع عند غياب دعم المتصفح.

## مصفوفة القدرات الحالية

| القدرة                   | Android                           | Web الآن                    | الملاحظة                              |
| ------------------------ | --------------------------------- | --------------------------- | ------------------------------------- |
| البداية والاتصال         | مكتمل                             | مكتمل                       | نفس الرحلة العربية                    |
| USB serial / MSP         | TurboModule                       | Web Serial                  | اتصال وقراءة وكتابة حقيقيان           |
| Setup والاتجاه والبطارية | مكتمل                             | نفس النواة والشاشة          | لا توجد telemetry مصطنعة              |
| Motors                   | مكتمل ضمن بوابات السلامة          | نفس المنطق عبر Web Serial   | يلزم اختبار عتاد قبل اعتماد إصدار Web |
| Ports                    | قراءة/حفظ/قراءة راجعة             | نفس المسار                  | نفس interlock ومنع كسر USB MSP        |
| GPS                      | إعداد وtelemetry وربط Setup/Ports | نفس المسار                  | نفس فك ترميز MSP                      |
| Configurations           | قراءة/مسودة/حفظ متحقق             | نفس المسار                  | لا تُكتب حقول غير مدعومة              |
| ملف Firmware محلي        | Document Picker                   | File Picker في المتصفح      | HEX/BIN/UF2 والتحقق المشترك           |
| تنزيل Firmware/Build     | مكتمل                             | نفس API والمنسق             | يخضع CORS وسياسة شبكة الخادم          |
| STM32 ROM / ESP serial   | مكتمل                             | مكتمل برمجيًا عبر Web Serial | التحقق الفعلي بمصفوفة العتاد ما زال بوابة إصدار |
| حفظ UF2                  | Save sheet                        | تنزيل متصفح                 | النسخ إلى وحدة RP2040 يبقى للمستخدم   |
| STM32 DFU                | أصلي                              | WebUSB DfuSe حقيقي          | تحليل layout، مسح، كتابة، read-back verify ثم manifestation؛ العتاد الفعلي بوابة إصدار |
| DFU unprotect/exit       | أصلي                              | منفذ عبر WebUSB             | حماية انتظار غير حاجبة؛ لا يعتمد قبل اختبار FC فعلي |

## حدود المتصفح

- Web Serial ليس متاحًا في كل المتصفحات. الواجهة تفحص القدرة فعليًا؛ عند
  غيابها لا تعرض اختيارًا يوحي بأنه سيعمل.
- الاتصال بالمنافذ في الإصدار المنشور يحتاج secure context (HTTPS) واختيارًا
  صريحًا من المستخدم.
- يعرض Web تنبيه توافق صغيرًا إذا كان HTTPS أو Web Serial أو WebUSB غائبًا،
  لكنه لا يعطل فتح الملفات أو إعداد Cloud Build.
- لا يجوز تحويل غياب Web Serial أو DFU إلى جهاز تجريبي أو نتيجة نجاح وهمية.
- دعم Android Web أو Safari أو Firefox يحتاج محولًا مثبتًا منفصلًا (WebUSB أو
  bridge محلي) ولا يُعلن قبل وجود اختبارات عتاد له.

## الأداء والعزل

- شاشة البداية في حزمة الدخول، بينما Connection وMainTabs وFirmware Flasher
  محمّلة كسولًا لتفادي تحميل كل الأدوات قبل اختيار المستخدم.
- مجسم الاتجاه يستعمل إسقاط `computeDroneScene` الحقيقي نفسه في المنصتين؛
  Android يرسمه بـSkia وWeb يرسم المضلعات الناتجة بـSVG، وبذلك لا يحمل المتصفح
  CanvasKit/WASM بحجم 7.8MB ولا يعيد كتابة حسابات الدوران أو الكاميرا.
- لا توجد طبقة نسخ للحالة بين Android وWeb؛ هذا يمنع اختلاف القراءات أو
  مضاعفة polling.
- قواعد إيقاف Motors عند مغادرة التبويب، وإيقاف GPS التفصيلي عند إخفائه،
  وملكية MSP الواحدة هي القواعد نفسها في المنصتين.
- يستبدل Web تنفيذ `Alert.alert()` الفارغ في React Native Web بحوار عربي غير
  حاجب، ولذلك تعمل قرارات الحفظ/التجاهل والحماية في الشاشات المشتركة فعليًا.
- فتح خريطة GPS يستعمل رابط OpenStreetMap عبر HTTPS على Web، ويبقى `geo:`
  خاصًا بـAndroid.
- ملف Manifest يمنح النسخة اسمًا واتجاهًا وأيقونة ووضع standalone مناسبًا
  لتجربة Web App، من دون Service Worker يخزن أداة تفليش قديمة في المتصفح.
- `tsconfig.json` لا يفحص ملفات Web ضمن بناء Android، و`tsconfig.web.json`
  يحل اللاحقة `.web` أولًا. بذلك لا تتسرب أنواع DOM إلى Android ولا TurboModule
  إلى المتصفح.

## بوابة النشر

قبل وصف Web بأنه إصدار عتاد معتمد يجب أن تنجح، كل واحدة على حدة:

1. TypeScript وJest وESLint وبناء Vite الإنتاجي.
2. إعادة مجموعة Android كاملة وإثبات عدم التراجع مرة واحدة عند بوابة الدمج
   النهائية؛ لا حاجة لتشغيل Android Validation بعد كل تعديل Web معزول.
3. تجربة Web Serial فعلية على FC مدعوم: connect، identification، telemetry،
   Ports/GPS/config read-write-readback، وإيقاف Motors عند كل مسار مغادرة.
4. تجارب فشل: رفض الإذن، فصل الكابل أثناء القراءة/الكتابة، منفذ مشغول، تغير
   baud فاشل، وTarget mismatch.
5. تجربة WebUSB فعلية: إذن صريح، DFU layout، selective/full erase، كتابة،
   read-back verify، فصل أثناء العملية، exit وread-unprotect. الاختبارات
   الآلية موجودة، لكن لا تُستبدل بها تجربة اللوحة الفعلية.

## المراجع الهندسية

- React Native for Web: https://necolas.github.io/react-native-web/docs/
- Web Serial API: https://developer.mozilla.org/docs/Web/API/Web_Serial_API
- WebUSB API: https://developer.mozilla.org/docs/Web/API/WebUSB_API
- Betaflight Configurator: https://github.com/betaflight/betaflight-configurator
- INAV Configurator: https://github.com/iNavFlight/inav-configurator
