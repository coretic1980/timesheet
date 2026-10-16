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
- **PO / referentie per project:** wordt automatisch de referentie op de factuur.
  - Bij het importeren haalt de app het PO-nummer uit de projectnaam ("PO 5473-1", "POR10-128179").
  - Bij het factureren kies je welke projecten op de factuur komen, zodat je per PO factureert. Staan er meerdere PO's op één factuur, dan waarschuwt de app.
  - Met de code `[REFERENTIE]` zet je de PO ook op elke factuurregel.
- **Opmaak factuurregel** met dezelfde codes als in e-Boekhouden: `[DATUM]`, `[PROJECT]`, `[ACTIVITEIT]`, `[OPMERKING]`, plus `[PROJECTCODE]` en `[MEDEWERKER]`. Standaard staat er `[DATUM] | [ACTIVITEIT] | [OPMERKING]` met één regel per uurregel. Samengevoegd (één regel per project, activiteit en medewerker, met datumbereik) kan ook. Beide stel je globaal in onder Koppeling en per klant onder Klanten.
- **Factuurnummer, factuurtekst en verzending** (Beheer › Koppeling › Factuur):
  - **Factuurnummer:** voorvoegsel plus vast aantal cijfers (bijv. F00035). Bij elke factuur stelt de app het volgende vrije nummer voor: het hoogste nummer met dat voorvoegsel in e-Boekhouden plus één.
  - **Factuurtekst** met codes [MAAND], [PERIODE], [KLANT] en [REFERENTIE]; standaard "Factuur periode [MAAND]".
  - **Klaarzetten voor verzending per post.**
  - **E-mailsjabloon:** kies een sjabloon uit e-Boekhouden voor het mailen.
- **Factuur direct mailen:** e-Boekhouden mailt de factuur naar het factuur-e-mailadres van de relatie, met het onderwerp en de tekst uit Koppeling (codes `[KLANT]` en `[PERIODE]`). Dit zet je per factuur aan of uit.
- **Budgetten per activiteit:** per project stel je per activiteit een budget in uren en/of euro's in (Projecten › Activiteiten).
  - In de urenstaat staat bij elke regel een budgetbalk met het verbruik ("38 / 120 uur") en wat er nog beschikbaar is ("Nog 82 uur beschikbaar"). Groen: 50–100% van het budget over, oranje: 25–50% over, rood: minder dan 25% over of overschreden. De balk loopt live mee; in Rapportage worden dezelfde kleuren gebruikt.
  - Activiteitbudgetten stel je in onder Projecten › Activiteiten, of per activiteit onder Activiteiten › Wijzigen (tabel "Budget per project").
  - Onder Rapportage staat een overzicht van alle budgetten.
  - Een projectbudget (Projecten › Wijzigen › Budget) geldt voor alle activiteiten samen. In de urenstaat staat het als balk "Project" bij elke regel van dat project, en een activiteitbudget als tweede balk "Activiteit".
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

## Gebruik op telefoon en desktop

- **Telefoon:**
  - Tabbalk onderaan: Overzicht, Uren, Goedkeuren, Facturen, Meer.
  - De urenstaat opent in de **dagweergave**: een strip met de dagen van de week of maand, per project een kaart met een groot urenveld en snelknoppen 2/4/8 uur. Vegen gaat naar de vorige of volgende dag.
  - "Week indienen" staat vast onderaan, en het filter zit achter de knop Filter.
  - Tabellen worden op smalle schermen kaarten.
- **Desktop:**
  - Het raster is gegroepeerd per klant. Groepen kun je inklappen; de groepskop toont dan de totalen.
  - Budgetten staan als compacte balk met "nog X u", de details zie je bij aanwijzen.
  - Met het filter "Alleen regels met uren" verberg je lege regels.
- **Overzicht (beheerders):** startscherm met te beoordelen uren, te factureren bedrag van vorige maand, budgetten met minder dan 25% over, en wie vorige week nog niet heeft ingediend.
- **Facturen:**
  1. Kies een klant.
  2. Het zijpaneel (volledig scherm op mobiel) loopt door project en PO.
  3. Controleer de regels.
  4. Vul de factuurgegevens in en verstuur.

  De gemaakte facturen staan in een eigen tabblad.
- **Koppeling:** de instellingen zijn gegroepeerd (Boekhouding, Factuurregels, Factuur, E-mail), met een vaste opslaanbalk. De app waarschuwt bij niet-opgeslagen wijzigingen.

## Accountant: meekijken en controleren

Geef je accountant (Vanwaarde Administratie & Belastingadvies) een eigen account onder **Beheer › Medewerkers › Medewerker toevoegen** met de rol **Accountant (alleen inzien)**. Dat is een los account in deze app; het staat los van hun gebruiker in e-Boekhouden.

De accountant:

- ziet alleen **Controle**, **Rapportage** en zijn eigen account, en kan niets wijzigen (de server weigert alles behalve inzien);
- schrijft geen uren en telt niet mee als medewerker in de rapportage;
- moet bij de eerste keer inloggen tweestapsverificatie instellen, net als een beheerder.

**Controle** heeft vier tabbladen, voor een kwartaal, jaar of eigen periode:

- **Overzicht**: gefactureerde omzet per maand, onderhanden werk op een peildatum, uren per status en automatische signaleringen. Die signaleringen zijn: facturen die niet aansluiten op de uren, dubbele of ontbrekende factuurnummers, teruggedraaide facturen, goedgekeurde uren die na 45 dagen nog niet gefactureerd zijn, ingediende uren die na 14 dagen nog niet beoordeeld zijn, declarabele uren zonder tarief, klanten zonder koppeling met e-Boekhouden en eigen uren die zelf zijn goedgekeurd.
- **Uren**: alle uurregels met wie ze heeft goedgekeurd en op welke factuur ze staan, te filteren op medewerker, klant, status en declarabel.
- **Facturen**: alle facturen uit de app met de onderliggende uren en of het bedrag aansluit.
- **Logboek**: wie wat wanneer heeft gedaan: goedkeuren, afkeuren, factureren, terugdraaien, tarieven, rechten, imports en factuurinstellingen. Regels kunnen niet worden gewijzigd. Het logboek begint bij de installatie van deze versie.

Elk tabblad heeft een CSV-knop voor Excel. Jij ziet als beheerder hetzelfde scherm onder **Controle**.

## Ingehuurde zzp'ers: zelffacturering

Laat je een zzp'er uren schrijven, dan maakt de app na goedkeuring de factuur namens de zzp'er ("factuur uitgereikt door afnemer"). Jij betaalt de zzp'er op basis van die factuur.

1. **Afspraak vastleggen.** Zelffacturering mag alleen als je dat vooraf schriftelijk met de zzp'er hebt afgesproken. Leg de datum van die afspraak vast in de app.
2. **zzp'er instellen.** Ga naar Beheer › Medewerkers, open de medewerker en vink **Ingehuurde zzp'er** aan. Vul de bedrijfsnaam, het adres, KvK, btw-nummer, IBAN, de btw (21%, kleineondernemersregeling of verlegd), het inkooptarief, de datum van het akkoord en eventueel de crediteur in e-Boekhouden in. Een afwijkend inkooptarief per project stel je in via Projecten › Team.
3. **Eigen gegevens.** Onder Beheer › Koppeling › **Zelffacturering zzp** vul je de gegevens van je eigen bedrijf in (afnemer). Daar kies je ook de nummerreeks (bijvoorbeeld ZF2026-0001) en de kosten- en crediteurenrekening.
4. **Afrekenen.** De zzp'er schrijft uren en jij keurt ze goed; het inkooptarief wordt dan vastgelegd. Onder Facturen › **Zelffacturen zzp** kies je de zzp'er, controleer je de regels en maak je de factuur. Is alles ingesteld, dan boekt de app hem als inkoopfactuur in e-Boekhouden (mutatie "factuur ontvangen" op de crediteur, btw-code HOOG_INK_21, GEEN of VERL_INK).
5. **Akkoord.** De zzp'er ziet de factuur in de app onder **Facturen**, kan hem bekijken en afdrukken als pdf, en geeft akkoord of maakt bezwaar. Bij bezwaar trek je de factuur in, pas je aan en maak je een nieuwe. Een factuur die in e-Boekhouden is geboekt, crediteer je daar zelf.

Op de factuur staan de verplichte gegevens van beide partijen, de vermelding "factuur uitgereikt door afnemer", de afspraak, de regels met uren en tarief, de btw en een urenspecificatie per dag. Rapportage toont per project de kosten van zzp'ers en de marge. De accountant ziet de zelffacturen onder Controle › Facturen, met signaleringen voor zzp-uren die na 45 dagen nog niet zijn afgerekend, uren zonder inkooptarief en facturen met bezwaar of zonder akkoord.

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

Gefactureerde uren liggen vast. Moet er toch iets worden gecorrigeerd:
1. Verwijder of crediteer de factuur in e-Boekhouden.
2. Gebruik daarna **Terugdraaien** bij Facturen › Gemaakte facturen. De uren van die factuur gaan dan terug naar "goedgekeurd" en zijn opnieuw te factureren. De factuur blijft in de lijst met het label "Teruggedraaid".

## Beveiliging

**Al geregeld in de app**
- **Wachtwoorden:** gehasht met bcrypt (cost 12). Inloggen geeft dezelfde foutmelding en duurt even lang, of het e-mailadres nu bestaat of niet.
- **Sessies:** httpOnly-cookie (Secure, SameSite=Lax, 30 dagen); in de database staat alleen de hash van het token. Na een wachtwoordwijziging of het deactiveren van een account worden alle sessies van die gebruiker ingetrokken.
- **CSRF:** elke wijziging vereist een eigen header die andere websites niet kunnen meesturen.
- **Inlogpogingen:** maximaal 10 mislukte pogingen per IP per kwartier.
- **Tweestapsverificatie (TOTP)** met een authenticator-app:
  - Verplicht voor beheerders, optioneel voor medewerkers (Account).
  - De geheime sleutel wordt versleuteld opgeslagen (AES-256-GCM met `APP_SECRET`), en een code kan niet twee keer gebruikt worden.
  - Na 5 foute codes moet je opnieuw inloggen.
  - Je krijgt 8 eenmalige herstelcodes. Een beheerder kan de 2FA van een medewerker resetten.
  - Noodknop: zet `MFA_RESET_EMAIL` in Render, deploy, log in en stel opnieuw in, en verwijder de variabele weer.
- **Rechten op de server:** medewerkers kunnen alleen hun eigen uren zien en wijzigen. Beheer, goedkeuren, facturen en rapportage zijn alleen voor beheerders.
- **SQL:** alle queries zijn geparametriseerd. Gebruikersinvoer wordt in de browser altijd ge-escaped.
- **Headers:** strikte CSP, HSTS, X-Frame-Options, nosniff, Permissions-Policy.
- **e-Boekhouden-token:** staat alleen in een omgevingsvariabele op de server, nooit in de database of de browser.
- **Database:** de verbinding is versleuteld en het certificaat wordt gecontroleerd.
- **CSV-export:** omschrijvingen kunnen in Excel geen formules uitvoeren.
- **Facturatie:** gebeurt in één transactie met vergrendelde uren, zodat er niet dubbel gefactureerd kan worden.

**Zelf regelen**
0. **APP_SECRET:** zet in Render een lange willekeurige waarde (bij een nieuwe Blueprint maakt Render die zelf aan). Verander hem daarna niet meer, anders moet iedereen 2FA opnieuw instellen.
1. **ADMIN_PASSWORD:** verwijder deze variabele in Render na de eerste start, en kies voor alle accounts een lang, uniek wachtwoord.
2. **Eigen databaserol:** geef de urenapp in Neon een eigen rol die alleen eigenaar is van de database `timesheet`, in plaats van `neondb_owner`. Dan kan de app niet bij je Neptune-data.
3. **Token voor e-Boekhouden:**
   - Maak het aan onder een aparte e-Boekhouden-gebruiker met alleen de rechten die nodig zijn: relaties, facturen, grootboek lezen.
   - Geef het een vervaldatum.
   - Trek het direct in als je denkt dat het is uitgelekt.
4. **Back-ups:** controleer in Neon hoe ver je terug kunt (point-in-time restore).
5. **Updates:** voer af en toe `npm audit` en `npm update` uit, en deploy opnieuw.

**Bekende beperkingen**
- **De Excel-lezer voor de imports** (SheetJS 0.18.5 via cdnjs) heeft bekende kwetsbaarheden bij het lezen van kwaadwillig gemaakte bestanden. De lezer draait alleen in de browser van de beheerder en alleen voor bestanden die je zelf uploadt; importeer daarom alleen je eigen exports uit e-Boekhouden.

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
