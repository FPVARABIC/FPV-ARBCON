# FPV Configurator NL

Nederlandstalige editie van FPV-ARBCON. Deze zelfstandige branch `dutch-edition` is gebaseerd op commit `0a40c6b8227d49a608d8a60c3beb39ad2db0e015` van `codex/android-validation-recovery`.

De functies, MSP-protocollen, configuratiewaarden en beveiligingen blijven gelijk aan de brontoepassing. De interface, meldingen, toegankelijkheidslabels en 37 handleidingafbeeldingen zijn Nederlandstalig. De weergaverichting is van links naar rechts, ook op een apparaat met een Arabische systeemtaal.

De Android-app heet **FPV Configurator NL** en krijgt applicatie-ID `com.fpvarbcon.nl`, zodat beide edities naast elkaar kunnen worden geïnstalleerd. De interne Kotlin-namespace en React Native-registratienaam blijven behouden.

## Lokaal controleren

```sh
npm ci
npm run typecheck
npm run typecheck:web
npm test -- --maxWorkers=2
npm run build:web
npm run scan:web-bundle
```

Het Arabische referentiebestand blijft in `src/i18n/locales/ar.json` voor de sleutel- en interpolatiecontrole. Alleen `nl.json` wordt door deze editie geladen.

## Android

Een Nederlandse APK wordt in een volgende stap gebouwd. Deze wijziging publiceert alleen de broncode. De Android-controles voor een eerste start, herstart en oude RTL-voorkeuren zijn aangepast voor deze editie; uitvoering op een Android-apparaat blijft onderdeel van die volgende stap.

Verwijder de propellers vóór motortests. Ontvangstbevestigingen van de vluchtcontroller bewijzen geen mechanische beweging of veilige vlucht. Het oorspronkelijke beeldmerk is behouden.

## Handleidingafbeeldingen opnieuw maken

De browserfixture in `e2e/flight-guides` gebruikt echte schermcomponenten met expliciete voorbeeldgegevens. De 76 controles in `docs/flight-guides/_tools/validate.mjs` lezen de waarden en selecties van de echte bedieningselementen.

Installeer voor deze ontwikkeltools `playwright-core` lokaal en gebruik een geïnstalleerde Chromium-browser:

```sh
npm install --no-save --package-lock=false playwright-core@1.62.1
```

Dit is alleen nodig voor de ontwikkeltools. Bouw en serveer de fixture op poort 4182:

```sh
npx vite build --config e2e/flight-guides/vite.config.mts
npx vite preview --config e2e/flight-guides/vite.config.mts
```

Voer vanuit een tweede terminal de controles en opnamen uit. Stel zo nodig `CHROME_PATH` in op uw Chromium-uitvoerbaar bestand:

```sh
node docs/flight-guides/_tools/validate.mjs
node docs/flight-guides/_tools/capture.mjs
node docs/flight-guides/_tools/write-app-content.mjs
```

Met `GUIDE_STYLE=firmware` maakt u alleen de drie firmwareafbeeldingen opnieuw. Een mislukte opname vervangt de bestaande afbeeldingen niet. Voorbeeldgegevens zijn geen waarnemingen van aangesloten hardware.

[Oorspronkelijke projectdocumentatie](README.original.md).
