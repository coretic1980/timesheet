# Coretic uren

Urenregistratie voor Coretic. Medewerkers schrijven uren per week en dienen die in. Daarna keurt de beheerder ze goed. Goedgekeurde uren worden met één klik een verkoopfactuur in e-Boekhouden.nl.

Stack: Node 20 + Express, Postgres (Neon) en een frontend zonder build-stap. De app heeft drie dependencies.

## Wat het doet

**Medewerkers**
- Weekstaat met een rij per project en een kolom per dag. Invoer als `7,5` of `7:30`.
- Schakelaar tussen raster en lijst. De lijst toont dezelfde regels als het raster (elk toegewezen project, per activiteit) als kaarten, met de uren van die week en per kaart een invulregel. Uren en omschrijving pas je direct in de lijst aan; ze worden opgeslagen zodra je het veld verlaat of op Enter drukt (Shift+Enter geeft een nieuwe regel, Escape zet de oude waarde terug). De keuze wordt per browser onthouden; op een smal scherm is de lijst de standaard.
- Week- of maandoverzicht (schakelaar Week | Maand), in raster en lijst. In de maand dien je alle conceptregels van die maand in één keer in.
- Filter in raster en lijst op meerdere projecten en/of activiteiten tegelijk. Het activiteitenfilter werkt ook over projecten heen, en het filter blijft staan als je van week wisselt.
- Uren verplaatsen door een vak naar een andere dag of een ander project te slepen. Met Ctrl of ⌥ kopieer je in plaats van te verplaatsen. Staat er al iets in het doelvak, dan worden de uren opgeteld.
- Per cel een omschrijving.
- Week indienen, en terughalen zolang de uren nog niet zijn goedgekeurd.
- Afgekeurde uren verschijnen met de reden erbij en zijn weer te bewerken.

**Beheerder**
- **Goedkeuren** per medewerker per week, met afkeuren inclusief reden. Bij goedkeuring wordt het tarief vastgelegd, zodat een latere tariefwijziging (bijvoorbeeld indexatie) geen effect heeft op al goedgekeurde uren.
- **Tarieven** per project, eventueel per medewerker overschreven via het team van het project.
- **Interne projecten** (zonder klant) voor acquisitie, opleiding en dergelijke. Die tellen mee voor de bezetting, maar komen nooit op een factuur.
- **Facturen:** per klant en periode krijg je een voorbeeld, met één regel per project × medewerker × tarief. "Bekijk API-verzoek" toont exact wat er naar e-Boekhouden gaat. "Maak factuur" maakt de factuur aan en markeert de uren als gefactureerd. Dat gebeurt in één transactie: lukt de factuur niet, dan verandert er niets.
- **Rapportage:**
  - bezetting per medewerker (declarabel ÷ contracturen)
  - budgetverbruik per project
  - omzet uit goedgekeurde uren
  - CSV-export (puntkomma, decimale komma)
- **Projecten importeren** uit de export van e-Boekhouden (Uren › Configuratie › Projecten), of uit een eigen Excel- of CSV-bestand met de kolommen Project en Relatie. Ontbrekende klanten worden aangemaakt, projecten van je eigen bedrijf worden intern, en projecten die al bestaan worden overgeslagen. Tarieven staan niet in de export; projecten zonder tarief krijgen het label "Tarief ontbreekt".
- **Activiteiten:** activiteiten beheer je centraal met een standaardtarief, en per project kies je welke activiteiten erbij horen, eventueel met een afwijkend tarief. Medewerkers schrijven uren op project + activiteit. In het raster is elke combinatie een eigen regel. Elk actief project waaraan je bent toegewezen staat er altijd in, met een regel per actieve activiteit. De activiteit komt op de factuurregel.
- **Uren importeren** (Beheer › Uren importeren) uit de export van de geregistreerde uren in e-Boekhouden. Zo werkt het:
  - Per medewerker uit de export kies je de gebruiker in de app.
  - Projecten en activiteiten worden op naam gekoppeld, dus importeer die eerst.
  - Regels op dezelfde dag, hetzelfde project en dezelfde activiteit worden samengevoegd.
  - Uren t/m een gekozen datum worden "gefactureerd" (niet opnieuw te factureren); latere uren worden "goedgekeurd".
  - Bestaande uren worden overgeslagen, dus opnieuw importeren is veilig.
  - Kilometers worden niet geïmporteerd.
- **Opmaak factuurregel** met dezelfde codes als in e-Boekhouden: `[DATUM]`, `[PROJECT]`, `[ACTIVITEIT]`, `[OPMERKING]`, plus `[PROJECTCODE]` en `[MEDEWERKER]`. Standaard staat er `[DATUM] | [ACTIVITEIT] | [OPMERKING]` met één regel per uurregel. Samengevoegd (één regel per project, activiteit en medewerker, met datumbereik) kan ook. Beide stel je globaal in onder Koppeling en per klant onder Klanten.
- **Factuur direct mailen:** e-Boekhouden mailt de factuur naar het factuur-e-mailadres van de relatie, met het onderwerp en de tekst uit Koppeling (codes `[KLANT]` en `[PERIODE]`). Dit zet je per factuur aan of uit.
- **Budgetten per activiteit:** per project stel je per activiteit een budget in uren en/of euro's in (Projecten › Activiteiten).
  - In de urenstaat staat bij elke regel een budgetbalk met het verbruik ("38 / 120 uur"). Groen: 50–100% van het budget over, oranje: 25–50% over, rood: minder dan 25% over of overschreden. De balk loopt live mee; in Rapportage worden dezelfde kleuren gebruikt.
  - Onder Rapportage staat een overzicht van alle budgetten.
  - Projecten zonder activiteiten houden hun eigen projectbudget.
- **Tariefvolgorde** bij goedkeuring:
  1. afwijkend tarief van de activiteit op het project
  2. tarief van de medewerker op het project
  3. standaardtarief van de activiteit
  4. projecttarief
- **Importeren uit e-Boekhouden:**
  - activiteiten uit de export van Uren › Configuratie › Activiteiten (naam + uurtarief)
  - klanten rechtstreeks via de API (Beheer › Klanten › Ophalen uit e-Boekhouden), direct gekoppeld
  - bij de projectimport worden nieuwe klanten op naam opgezocht in e-Boekhouden en meteen gekoppeld
- **Koppeling:** klanten koppel je aan een bestaande relatie (via de relatiecode), of je maakt de relatie vanuit de app aan in e-Boekhouden.

## Installatie

### 1. Database (Neon)

Gebruik je bestaande Neon-project in Frankfurt, of maak een nieuwe database, bijvoorbeeld `coretic_uren`. Kopieer de connection string; de pooled variant is prima. De tabellen worden bij de eerste start automatisch aangemaakt.

### 2. e-Boekhouden API-token

1. Log in op e-Boekhouden en ga naar **Beheer › API-tokens**.
2. Maak een nieuw token aan van het type **e-Boekhouden API**. Kies niet het oude API/SOAP: dat token werkt niet op de REST API.
3. Het token wordt maar één keer getoond. Bewaar het direct.

Het token hoort bij één administratie en bij de gebruiker die het aanmaakt. Deactiveer je die gebruiker, dan vervalt het token.

### 3. Render

1. Zet deze map in een (private) GitHub-repo.
2. Kies in Render **New › Blueprint**, wijs de repo aan, en Render leest `render.yaml`. Je kunt ook handmatig een Web Service maken met:
   - build `npm install --omit=dev`
   - start `npm start`
   - health check `/healthz`
3. Vul de omgevingsvariabelen in:

| Variabele | Waarde |
| --- | --- |
| `DATABASE_URL` | Neon connection string |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | De eerste beheerder. Na de eerste start mag je `ADMIN_PASSWORD` verwijderen. |
| `EB_API_TOKEN` | Het token uit stap 2 |

Gebruik niet het gratis plan: dat slaapt na inactiviteit en de eerste klik duurt dan lang. Starter is genoeg.

Lokaal draaien:

```
cp .env.example .env    # invullen
npm install
npm run dev             # http://localhost:3000
```

### 4. Inrichten in de app

1. **Beheer › Koppeling:**
   1. Klik op "Test verbinding".
   2. Kies het factuursjabloon, de omzetrekening (8000) en de debiteurenrekening (1300).
   3. Kies eventueel de eenheid "uur" en zet de btw-code op 21%.
2. **Beheer › Klanten:** voeg klanten toe en koppel ze aan hun relatiecode in e-Boekhouden.
3. **Beheer › Projecten:** maak projecten aan met een uurtarief en stel per project het team samen. Medewerkers zien alleen projecten waarin ze in het team zitten, en dat geldt ook voor jou.
4. **Beheer › Medewerkers:** voeg medewerkers toe met hun contracturen.

## Eerste factuur: test eerst

De velden voor `POST /v1/invoice` zijn overgenomen uit de OpenAPI-specificatie en uit bestaande client-libraries:

- `relationId`, `templateId`, `date`, `termOfPayment`, `reference`
- per regel in `items`: `description`, `quantity`, `pricePerUnit`, `vatCode`, `ledgerId` en eventueel `unitId`
- `mutation` met de debiteurenrekening, om de factuur direct te verwerken

Ik heb dit niet tegen een live administratie kunnen draaien. Doe daarom de eerste keer het volgende:

1. Klik bij een factuur op **Bekijk API-verzoek** en controleer de JSON.
2. Maak één echte factuur voor een klein bedrag en controleer die in e-Boekhouden (bedragen, btw, grootboek, openstaande post).
3. Klopt er iets niet, dan staat de foutmelding van e-Boekhouden letterlijk in beeld, inclusief de foutcode (bijvoorbeeld `FACT_ITEM_001`). Die is terug te zoeken op https://api.e-boekhouden.nl/swagger.

Wil je de factuur liever als concept laten aanmaken, zodat je hem in e-Boekhouden nog kunt aanpassen? Zet dan "Factuur direct verwerken" uit onder Beheer › Koppeling.

Mocht de API de autorisatie-header zonder `Bearer` verwachten, dan schakelt de client daar automatisch op over.

## Statussen

```
concept ──indienen──▶ ingediend ──goedkeuren──▶ goedgekeurd ──factuur──▶ gefactureerd
   ▲                     │  │                       │
   └──── terughalen ─────┘  └──afkeuren──▶ afgekeurd │
   └──────────────── terugzetten (beheerder) ────────┘
```

Gefactureerde uren liggen vast. Moet er toch iets worden gecorrigeerd, maak dan een creditfactuur in e-Boekhouden.

## Beveiliging

- Wachtwoorden worden gehasht met bcrypt (cost 12).
- Sessies lopen via een httpOnly-cookie (30 dagen). In de database staat alleen de hash van het token.
- CSRF-bescherming via SameSite=Lax plus een verplichte `X-Requested-With`-header op mutaties.
- Inlogpogingen worden afgeremd per IP, er staat een strikte CSP, en HSTS staat aan in productie.
- Het e-Boekhouden-token staat alleen in de omgevingsvariabelen en nooit in de database of de browser.

## Structuur

```
db/schema.sql            tabellen (idempotent, draait bij elke start)
src/server.js            Express, beveiligingsheaders, routes
src/eboekhouden.js       REST-client: sessie, retry bij 401, paginering
src/routes/timesheet.js  weekstaat, indienen, terughalen
src/routes/approvals.js  goedkeuren, afkeuren, terugzetten
src/routes/invoicing.js  factuurvoorbeeld en aanmaken in e-Boekhouden
src/routes/reports.js    bezetting, budget, CSV
src/routes/admin.js      medewerkers, klanten, projecten, koppeling
public/                  frontend (index.html, app.js, styles.css)
```
