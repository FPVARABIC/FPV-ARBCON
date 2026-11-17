# Controleverslag — Nederlandse editie

De branch `dutch-edition` is gebaseerd op `0a40c6b8227d49a608d8a60c3beb39ad2db0e015` van `codex/android-validation-recovery`.

## Omvang

De interface, meldingen, toegankelijkheidslabels en handleidingen zijn Nederlandstalig. Alle 2283 vertaalwaarden behouden de sleutels en invulvelden van het referentiebestand. Alleen de Nederlandse taal wordt geladen. De oorspronkelijke documentatie staat in `README.original.md`.

De Android-weergavenaam is **FPV Configurator NL** en de applicatie-ID is `com.fpvarbcon.nl`. De Kotlin-namespace en React Native-registratienaam zijn behouden. Links-naar-rechts wordt ingesteld vóór het eerste native scherm, ook als oude RTL-voorkeuren aanwezig zijn.

De veiligheidscontroles en configuratieprotocollen blijven behouden. De DFU-apparaatcontrole gebruikt een getypeerde foutcode in plaats van een taalafhankelijke tekstprefix. Een vergelijking van de oorspronkelijke ASCII-constanten in 25 gewijzigde core/platformmodules vond geen verdwenen protocol- of identificatiewaarden.

## Uitgevoerde controles

| Controle | Resultaat |
| --- | --- |
| Volledige Jest-suite | 9032 tests in 483 suites geslaagd; 0 mislukt |
| Hercontrole van de drie gidsuites na het genereren van de nieuwe afbeeldingsafmetingen | 63 tests geslaagd; 0 mislukt |
| `npm run typecheck` | Geslaagd |
| `npm run typecheck:web` | Geslaagd |
| `npm run lint` | 0 fouten; 469 waarschuwingen |
| `npm run build:web` | Geslaagd |
| `npm run scan:web-bundle` | Geslaagd |
| `npm run scan:production-bundle` | Geslaagd; productie-JavaScript voor Android, zonder APK te bouwen |
| Controle van de gidsbediening | 76 waarden, selecties en schakelaars gecontroleerd |
| Nieuwe schermafbeeldingen | 37 opnamen; 0 browserfouten; volledige formulieren passen in het vastgelegde beeld |
| CI-shellscripts | Syntaxis van alle 9 scripts geslaagd |
| Zelftest van de native-logclassificatie | 0 problemen |
| `git diff --check` | Geslaagd |

De screenshots zijn gemaakt met echte schermcomponenten en expliciet aangeduide voorbeeldgegevens. Ze tonen geen waarnemingen van aangesloten hardware. Hun werkelijke PNG-afmetingen worden door de generator in de gidsmodules opgenomen.

## Volgende Android-stap

In deze stap is geen Nederlandse APK gebouwd. Gradle, native Android-lint, emulatorinstrumentatie en proeven met een fysieke vluchtcontroller zijn niet uitgevoerd. De bijgewerkte controles voor een eerste start, oude RTL-voorkeuren en activiteitshercreatie worden bij de APK-stap uitgevoerd.

Deze branch publiceert broncode. Er is geen GitHub Actions-workflow gestart en geen webversie uitgerold.
