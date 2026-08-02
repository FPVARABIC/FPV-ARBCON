# تدقيق Firmware Flasher مقابل Betaflight Configurator

تاريخ التدقيق: 2026-08-02
مرجع Betaflight الرسمي: commit `5ed74193a7572366dac2efee5ea13eb063100c2c` (2026-08-01)

هذا المستند ليس قائمة تسويقية؛ هو عقد تدقيق يربط كل وظيفة ظاهرة بمسار تنفيذ واختبار. المقارنة تمت مع المصدر الرسمي الحالي، خصوصاً:

- `src/components/tabs/firmware-flasher/FlasherBoardBuildTab.vue`
- `src/components/tabs/firmware-flasher/FlasherFlashTab.vue`
- `src/composables/useBoardSelection.js`
- `src/composables/useCloudBuild.js`
- `src/composables/useFirmwareFlashing.js`
- `src/js/protocols/usbdfu.js`
- `src/js/protocols/webstm32.js`
- `src/js/protocols/esp32.js`

## مصفوفة التكافؤ

| القدرة | Betaflight | FPV-ARBCON | دليل التنفيذ/الاختبار |
|---|---|---|---|
| شاشة بداية بمسارين | تبويب Landing ثم Flasher | اتصال إلى Setup/Motors/Ports أو Flasher مستقل | `StartScreen.tsx`, `StartScreen.test.tsx`, `App.test.tsx` |
| Target عبر الإنترنت | Supported / community / legacy وبحث | نفس المجموعات والبحث باسم Target/الشركة/MCU، مع `FlatList` افتراضية | `firmwareCatalog.ts`, اختبار 2000 Target |
| Auto detect للـ FC | قراءة اللوحة ثم اختيار Target | MSP identity حقيقي، Betaflight family، Target/board/capabilities، اختيار الجهاز والمنفذ يدوياً عند التعدد | `FirmwareBootloaderController.ts/.test.ts` |
| Stable / RC / Development | نعم | نعم؛ القناة المختارة واضحة، وDevelopment لا يمكن تفليشه قبل إقرار مخاطر مستقل | `parseTargetReleases`, `FirmwareFlasherScreen` |
| Core Build | نعم | نعم | `createBuildRequest` (`CORE_BUILD`) |
| Cloud Build | نعم | نعم | `CloudBuildCoordinator`, polling متسلسل وحد زمني وإلغاء |
| خيارات البناء | Radio، Telemetry، OSD، motor، general | قسم ظاهر قبل الاختيار، ثم جميع الخيارات مع قبول `[None]` ذي القيمة الفارغة وتعطيل Telemetry عندما تكون مضمّنة في radio | `parseBuildOptions`, `FirmwareFlasherScreen.test.tsx` |
| Custom Defines | نعم | نعم، مع whitelist وطول/عدد محدودين ومنع payload غير صالح | `normalizeCustomDefines` واختباراته |
| Unified Config / Custom Defaults | نعم، إدخال داخل المساحة التي يعلنها HEX | نعم، من الخادم أو ملف محلي، مع تحقق pointer/capacity/overlap وإعادة تسلسل HEX صحيحة | `customDefaults.ts/.test.ts` |
| Commit تطويري | قائمة commits | قائمة محدودة إلى 20 نتيجة مرئية قابلة للتضييق + SHA يدوي، ولا يرسل commit للإصدار المستقر | `parseCommits`, `createBuildRequest` |
| Build status/log/cancel | queued/processing/log/cancel | نفس الحالات، عرض log محدود الحجم داخل FPV-ARBCON، AbortController، وطلب status واحد فقط في كل لحظة | `buildApi.test.ts`, `cloudBuildCoordinator.test.ts` |
| ملف محلي | HEX/UF2/BIN | HEX/UF2/BIN من Android document provider | Native SAF + `parseFirmwareFile` |
| حفظ Firmware | نعم | نعم عبر Android SAF، بلا إظهار زر إلغاء زائف أثناء نافذة الحفظ | `saveFirmwareFile` وحالة `saving` |
| HEX validation | Intel HEX | checksum/EOF/record types/32-bit ranges/overlap/entry، ودمج خطي الذاكرة | `intelHex.ts/.test.ts`, `IntelHexFirmware.kt` |
| STM32 DfuSe | erase/write | selective/full erase، layout descriptor، transfer-size descriptor، write ثم read-back verify | `DfuFlashWorker.kt`, `DfuUsbDescriptors.kt` |
| DFU chip families | IDs الرسمية | whitelist الرسمية 0483/28e9/2e3c/314b/3997؛ RP2040 UF2 لا يُعامل كـ DfuSe | `SUPPORTED_DFU_IDS` |
| STM32 ROM serial | F1/F3 العملية | 8E1، sync، GET/GET_ID، legacy/extended erase، write، read-back verify، GO | `Stm32SerialFlasher.ts/.test.ts` |
| BIN / ESP ROM | esptool-js | esptool-js 0.6.0، merged image عند address 0، MD5، ضغط، hard reset | `EspFirmwareFlasher.ts/.test.ts` |
| UF2 | حفظ ثم نسخ إلى boot drive | تحقق 512-byte blocks/magic/count/family/addresses ثم حفظ وتعليمات نسخ | `parseUf2`, مسار UF2 في الشاشة |
| Auto reboot للـ bootloader | MSP reboot mode 1 أو 4 | bit 3 `HAS_FLASH_BOOTLOADER` يختار 4 وإلا 1؛ Betaflight فقط | `FirmwareBootloaderController` |
| No reboot sequence | نعم | نعم، مع Target confirmation يدوي إلزامي | بوابة الأمان في الشاشة |
| Flash on connect | نعم | نعم، فقط مع No reboot وبعد اكتمال كل إقرارات الأمان | hotplug effect + safety gate |
| Full chip erase | نعم | نعم؛ الافتراضي selective erase | واجهة وخيارات DFU/STM/ESP |
| Manual baud | نعم | 57600/115200/230400/256000/460800/921600؛ defaults حسب البروتوكول | الشاشة + flashers |
| Backup policy | disabled/enabled/ask | never/always/ask، ونسخة Android حقيقية `diff all` | `CliBackupService.ts/.test.ts` |
| Restore | نعم | أوامر محدودة، validation ASCII، رصد `###ERROR`، وعدم إرسال `save` إذا فشل أمر | `CliBackupService` |
| Exit DFU | نعم | نعم | `DfuExitWorker.kt` |
| Read unprotect | نعم | نعم، بإقرار مسح صريح وworker مستقل وانتظار reset/disconnect | `DfuUnprotectWorker.kt` |
| Target mismatch | تحذير | حظر افتراضي، وتجاوز خبير صريح فقط مع عرض الفعلي والمحدد | `targetMatches`, safety gate |
| Unstable warning | نعم | حظر حتى الإقرار | safety gate |
| Progress / cancellation | نعم | build/DFU/STM/ESP/restore progress، throttled إلى 80ms، log محدود إلى 60، إلغاء فعلي | الشاشة والمحركات |
| البقاء داخل التطبيق | يفتح روابط دعم/إصدار/دليل خارجية | لا يفتح أي رابط من الشاشة؛ الدليل والأعطال وسجل Build داخل FPV-ARBCON | اختبار منع `Linking/openURL` في `FirmwareFlasherScreen.test.tsx` |
| عزل بقية الأنظمة | تبويب داخل تطبيق سطح المكتب | تحميل كسول؛ لا تُقيّم محركات catalogue/esptool أثناء بدء الاتصال أو Motors/Setup | `App.tsx`, اختبار `getComponent` |
| RTL/العربية | ليست واجهة عربية أصلية | واجهة عربية RTL كاملة مع إبقاء أسماء البروتوكولات التقنية المعروفة | `StartScreen`, `FirmwareFlasherScreen` |

## نواحٍ أقوى من النسخة المرجعية

1. كل مسار كتابة STM32 ينفذ read-back byte verification قبل إعلان النجاح.
2. Target mismatch محظور افتراضياً، وليس مجرد نص تحذير.
3. Android Backup ليس “skip”: ينفذ `diff all` فعلياً ويحفظه قبل erase، ويلغي التفليش إذا ألغى المستخدم حفظ النسخة المطلوبة.
4. Cloud polling لا يستخدم `setInterval(async ...)`؛ لذلك لا يمكن أن تتداخل طلبات status البطيئة.
5. تحليل آلاف سجلات HEX يخصص كل منطقة متصلة مرة واحدة، بدلاً من نسخ prefix كاملاً مع كل سجل.
6. قائمة Targets افتراضية، ونتائج Commits محدودة، والتقدم throttled والسجلات bounded لمنع lag ونمو الذاكرة.
7. مسارات USB ترفض التعدد الغامض ولا تخمّن الجهاز أو المنفذ.
8. DFU memory layout و`wTransferSize` يُقرآن من raw descriptors إذا لم يوفر Android اسم الواجهة مباشرة.
9. فشل الإنترنت لا يعطل اختيار Firmware محلي أو اكتشاف USB.
10. خيارات Cloud Build لا تختفي بسبب تمثيل `[None]` الرسمي بقيمة فارغة؛ هذا السيناريو مغطى باختبار واجهة كامل.
11. محرك Flasher محمّل عند فتح الشاشة فقط، لذلك دمجه لا يضيف عملاً إلى مسار بدء Motors/Setup/Ports.

## حدود صريحة لا يجوز إخفاؤها

- UF2 بروتوكول mass-storage: مثل Betaflight Configurator، الأداة تتحقق وتحفظ الملف، ثم ينسخه المستخدم إلى قرص bootloader. إرساله إلى DfuSe سيكون خطأ بروتوكولياً.
- STM32 ROM serial مفعّل فقط للـ chip IDs التي يملك مرجع Betaflight نفسه لها flash size وpage size عمليين (`0x410`, `0x414`, `0x422`). أي chip ID غير موصوف يُرفض قبل erase بدلاً من تخمين geometry قد يعطّل اللوحة.
- اختبارات CI تثبت البناء، الأنواع، المحاكاة والبروتوكولات، لكنها لا تستبدل مصفوفة hardware فعلية. قبل وصف إصدار متجر بأنه “متحقق على العتاد” يجب تسجيل تجربة: STM32 DFU، STM32 serial F1/F3، ESP32، RP2040 UF2، detach أثناء write، Target mismatch، read protection، وrestore مع أمر CLI فاشل.

## بوابات الإصدار

- `npx tsc --noEmit`
- `npx jest --runInBand`
- `npm run lint`
- Android codegen
- Production bundle scan
- Android Validation في GitHub مرة واحدة على commit المنشور نفسه
- لا Merge ولا إعادة تشغيل CI تلقائياً عند الفشل؛ تُراجع نتيجة التشغيل نفسها أولاً
