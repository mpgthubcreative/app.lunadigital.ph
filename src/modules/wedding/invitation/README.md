# Bridal invitation

One invitation engine for every wedding. Invitation designs are source
code in this folder (VS Code is where they're designed); a wedding stores
only which design it uses. Super Admin assigns, previews, publishes and
manages; it is not where designs are drawn.

```
src/modules/wedding/invitation/
  templates/        Standard designs (Luna Bridal): the Owner chooses one
    standard/template.js    Luna Standard: the original invitation (the default)
    classic/template.js     Classic
    modern/template.js      Modern
    romantic/template.js    Romantic
    editorial/template.js   Editorial
    gold/template.js        Gold Elegance   (signature layout; offered)
    gold/sample.js          its sample content + photos (preview only)
    monochrome/…            Black & White   (signature layout; offered)
    rustic/…                Rustic Garden   (signature layout; offered)
  customized/       Customized designs (Luna Bridal Custom): Super Admin assigns one
    garden/template.js      Garden (Custom-only; existing designs use it)
  registry.js       The one list of every design: id, name, category, version, kind,
                    preview, source, availability, the fields it uses, photo slots, wording
  renderer.js       The guest page /w/{slug}/invite/{token} (the card layout)
  signature.js      The signature layout (a full page; Gold / Black & White / Rustic)
  samples.js        The sample couple's shared words + previewSetup (real values,
                    the design's samples where empty: the Owner's editor only)
  preview.js        The in-app preview (Owner and Super Admin; Super Admin always with a sample guest)
  README.md         This file
```

## Stable template ids

| id | Name | Category | Who picks it |
| --- | --- | --- | --- |
| `standard` | Luna Standard | Standard | Default for every wedding without a choice |
| `classic` | Classic | Standard | Owner, in Wedding Setup |
| `modern` | Modern | Standard | Owner, in Wedding Setup |
| `romantic` | Romantic | Standard | Owner, in Wedding Setup |
| `editorial` | Editorial | Standard | Owner, in Wedding Setup |
| `gold` | Gold Elegance | Standard | Owner, in Wedding Setup |
| `monochrome` | Black & White | Standard | Owner, in Wedding Setup |
| `rustic` | Rustic Garden | Standard | Owner, in Wedding Setup |
| `garden` | Garden | Customized | Super Admin, in a Luna Bridal Custom design |

Ids are permanent: weddings (`weddingSetup/current.templateId`) and Custom
designs (`invitationDesign/current` draft / published `config.templateId`)
store them. Never rename or reuse an id; a folder's name is its id. An
unknown or missing id shows Luna Standard.

## Which sections each design shows

`registry.js` lists this per design (`shows` / `doesNotShow`). A design
that doesn't show a section never displays that saved content. Super Admin
can turn sections on or off in a Custom design.

| Design | Story | Map links | Entourage | Gallery | FAQ | Closing line |
| --- | --- | --- | --- | --- | --- | --- |
| Luna Standard page (`standard` in Wedding Setup; no design) | when added | in Ceremony / Reception | no | when added | when added | when added |
| `classic` | yes | yes | no | **no** | **no** | yes |
| `modern` | **no** | yes | no | yes | **no** | yes |
| `romantic` | yes | **no** | no | **no** | **no** | yes |
| `editorial` | yes | yes | no | **no** | yes | yes |
| `gold` | yes | in Details | yes | yes | yes | yes |
| `monochrome` | yes | in Details | yes | yes | yes | yes |
| `rustic` | yes | in Details | yes | yes | yes | yes |
| `garden` (Customized) | yes | **no** | yes | yes | **no** | yes |

Every design shows the names, date, cover photo, welcome message,
ceremony, reception, dress code and RSVP (with the meal choice and dietary
note when Wedding Setup asks for them). The signature designs show the
map links inside their Details section (and show entourage, gallery and
FAQ only when there is content). Since 2026-10-24 every Owner can enter
every field; a field the chosen design doesn't show says "Not shown by …"
in Wedding Setup and is kept for any design that shows it. The Luna Standard page is the original
hard-coded invitation in `renderer.js` (`draw()`); the `standard` template
file is its look for a Custom design that starts from it, with the
sections listed in that file.

## Template-first editing (2026-10-25)

Wedding Setup (`src/modules/wedding/setup.js`) is the invitation itself:
choose a design → the complete invitation with the design's own sample
content and photos → tap a part's **Edit** / a photo's **Replace** → a small
sheet with only that part's fields → **Clean Preview** (the guest's page,
no controls) → **Publish**.

- **Offered designs:** only `offered: true` designs (Gold Elegance, Black &
  White, Rustic Garden) can be newly chosen; the server refuses switching
  TO any other id. Weddings already on an older design keep it, and it
  still renders and is edited the same way.
- **Samples are template-owned:** `templates/{id}/sample.js` (`data` and
  `assets` under `public/invitations/samples/`) become the registry's
  `sampleData` / `sampleAssets`. `previewSetup()` merges them over the real
  record ON THE OWNER'S SCREEN ONLY, a whole group at a time (a real venue
  is never shown beside a sample address). They are never saved, and a
  guest's invitation is built by the server from real data only: an empty
  section is left out.
- **Editable sections:** the renderer marks parts with `data-edit` (and
  photos with `data-slot`); the registry's `editableSections` says which
  Wedding Setup fields, photo slots ("hero" = the cover photo) and wording
  lines each part edits, plus its one-line guide (the Guide tab). The
  editor adds its controls only in Edit mode; a guest's page has none.
  Entourage links to Guests (roles are typed once, there).
- **Publish:** a new invitation is saved with `published: false`; its links
  say "not published yet" until Publish, which the server allows only with
  the real names and date (and not during the free trial). A live
  invitation is never unpublished by a save. Weddings from before have no
  flag and stay live.
- **Per design:** wording / accent in `templateOptions[templateId]`; the
  couple's photos are per wedding (`weddingPhotos/{slot}`) and every
  design that has that slot shows them, so switching designs and back
  keeps everything.

To add a design: its folder (`template.js` + optional `sample.js` and
photos in `public/invitations/samples/{id}/`), register it, mark it
`offered: true`. A new layout kind also needs its `data-edit` marks and a
`SECTION_EDITORS` entry in `registry.js`. Never a new Bridal plan: Luna
Bridal is the one product (Luna Bridal Custom is legacy since 2026-10-25;
weddings already on it keep their Customized design).

Per entry the registry also gives `sectionGuide` (each section's label,
what it holds and where to tap: the Guide) and `fieldMappings` (each
section → its fields, photo slots and wording lines), both derived from
`editableSections`.

### Final pass (2026-10-25)

- **Bar:** Edit · Clean Preview · Undo · ⋯ (Guide, Change design, Reset
  invitation). Clean Preview hides Undo and every editor mark.
- **Family:** `partner1Family` / `partner2Family` = `[{ relation, label?,
  name }]` in order (relation: Father … Aunt, `other` + its own word, or
  none). The Family sheet adds / edits / removes / reorders each side. The
  older one-line `partner1Parents` / `partner2Parents` still render while a
  side has no list (and show in the sheet only while they hold text).
- **Undo:** one step, on this screen: the last successful save, photo
  change, gallery change or Reset section, put back through the same API.
- **Reset section:** that section's fields, wording lines and photos back to
  the design's examples (confirmation when something real is removed); the
  names and date are never reset.
- **Reset invitation** (`resetInvitation`, server): removes the invitation
  content (`INVITATION_RESET_FIELDS`), every design's wording / accent, the
  cover photo, design photos and gallery. Keeps the names, date, city,
  ceremony / reception details, RSVP settings, design, publish state and
  wedding link; never touches guests, RSVPs, roles, seating or any other
  module (that is Reset Data).
- **Companions at RSVP:** a guest's view carries `guest.party = { named,
  open }`; accepting may name the unnamed seats (`rsvp.companions`), which
  become party members keeping their seats. One private link per party.

## One wedding profile, many designs (2026-10-24)

Wedding Setup is the **wedding profile** (information); a template is
**presentation**. Every template reads the same fields from
`weddingSetup/current` (all optional except the names and the date):

| Group | Fields |
| --- | --- |
| Couple | `partner1Name`, `partner2Name`, `coupleNames` (the names line; filled from the two names unless the couple types one), `partner1Parents`, `partner2Parents`, `weddingSlug` |
| Wedding information | `weddingDate`, `city`, `ceremonyTime/Venue/Address/Map`, `sameVenue`, `receptionTime/Venue/Address/Map` |
| Wedding details | `welcomeMessage`, `dressCode`, `dressCodeDetails`, `palette` [{name, hex}], `attireNotes` [], `schedule` [{time, title}], `gettingThere`, `reminders` [], `giftNote`, `story` (paragraphs), `faq` [{q, a}], `footerNote` |
| Entourage | not typed here: from Guests → Role (`rolesPlan`) |
| RSVP | `rsvpEnabled`, `rsvpDeadline`, `closeAfterDeadline`, `rsvpContact`, `mealOptions` [], `askDietary` |
| Photos & media | `weddingSetup/hero` (cover), `weddingPhotos/{story1, story2, when, venue, dressCode}`, `weddingGallery/*` |
| Design | `templateId`, `templateOptions.{templateId}.wording / accent` (kept per design) |

A template file declares the rest: `version`, `kind` (`card` | `signature`),
`variant`, `recommended` (the "looks best with" prompt), `photoSlots`,
`wording` (default lines the couple can reword) and `accents`. The
registry derives `uses` (the fields its sections show), `required`
(names + date) and `preview` (`public/invitations/previews/{id}.webp`).
Older weddings have none of the new fields and show exactly as before.

## One data path (Wedding Setup → Preview → guests)

```
Wedding Setup (businesses/{bid}/weddingSetup/current, /hero, weddingGallery/*)
  → the server loader: liveDesignFor (a guest's link) / previewDesign
    (Owner Preview, Super Admin preview; draft or live)
      → { design, gallery, entourage }
  → invitationData(...) in shared/invitation-design.js: the one contract
      { wedding (the content fields), hero, guest, rsvpOpen, design, gallery, entourage }
  → renderer.js: the Luna Standard page or the design's sections
```

Only these change: live or draft design, a real or sample guest, and in
the Owner's Preview the details still on screen (not saved yet) and the
Standard template picked on screen.

## Add a Standard template

1. Copy a folder under `templates/`, e.g. `templates/classic/` to
   `templates/vintage/`.
2. In `template.js`, give it a new permanent `id` (`"vintage"`, the same as
   the folder), a `label` and a `description`, and change the `theme`,
   `layout`, `hero`, `order`, `show` and `gallery` values. Optionally
   `kind: "signature"` (+ `variant`, `wording`, `accents`, `photoSlots`,
   `recommended`); a new look of the signature layout also needs its
   `[data-variant="…"]` CSS in `src/styles/layout.css`.
3. Add its preview image `public/invitations/previews/{id}.webp` (a
   screenshot of the design with sample details, ~390 px wide).
4. Register it (below). It then appears in Wedding Setup's template picker
   for every Luna Bridal Owner.

## Add a Customized template

1. Copy a folder under `customized/`, e.g. `customized/garden/` to
   `customized/custom-luxe-01/`. Name new ones `custom-<style>-<NN>`
   (`custom-editorial-01`, `custom-garden-02`, `custom-luxe-01`).
2. In `template.js`, set `id` to the folder name and change the design
   values, as for a Standard template.
3. Register it with the category `"customized"`. It then appears only in
   Super Admin's Custom design Template choice (labelled "· Customized"),
   never in Wedding Setup.

## Register a template

In `registry.js`, import the file and add it to `TEMPLATE_REGISTRY` with
its category:

```js
import vintage from "./templates/vintage/template.js";
import luxe01 from "./customized/custom-luxe-01/template.js";
// ...
[vintage, "standard"],
[luxe01, "customized"],
```

The registry builds the rest (name, source path, availability, the full
defaults). `tests/shared/invitation-registry.test.js` fails if a folder is
not registered, if a source path doesn't exist, or if an id changes.

## Preview on staging

- A Standard template: as the Owner of a Luna Bridal wedding, More →
  Wedding Setup → choose the template → Preview (a sample guest; nothing
  is saved until you press Save).
- A Customized template: in Super Admin, Businesses → the wedding →
  Invitation → Edit design → choose the template → Save draft → Preview
  draft (always with a sample guest).
- Locally, `npm run dev` and the same screens.

Push to `main` to deploy staging; production is separate.

## Draft / Published (current behaviour)

- Luna Bridal (Standard): the Owner's choice is saved in Wedding Setup and
  is what guests see as soon as it is saved (there is no draft step).
  During the free trial the couple chooses and previews only; guest links
  are made and opened once Luna Bridal is paid.
- Luna Bridal Custom: Super Admin edits a **draft** (template plus
  overrides and images), previews it, and **Publishes** it. Guests see
  the published version only, and only while the Custom design is live;
  otherwise they see Luna Standard. Each publish is kept as a version that
  can be restored into the draft. Publishing is blocked during a trial.
- Guest links (`invitations/{sha256(token)}`) never depend on the
  template. Switching templates, publishing or upgrading never changes a
  link.

## What Firebase stores (per wedding, never the template source)

- `businesses/{bid}/weddingSetup/current`: the wedding content and the
  Owner's `templateId` (Luna Bridal)
- `businesses/{bid}/weddingSetup/hero`, `weddingGallery/*`: the couple's
  photos
- `businesses/{bid}/invitationDesign/current`: Luna Bridal Custom only.
  Super Admin's `templateId` plus overrides, as `draft` and `published`,
  with the version history and `live`
- `businesses/{bid}/invitationAssets/*`: the images a Custom design uses

## Never hardcode in a design file

- Customer content: couple names, dates, venues, guests, RSVP details,
  photos, stories, FAQs. These come from Wedding Setup at render time.
- Business, wedding or guest ids, slugs or tokens, and any
  `if (businessId === ...)` logic. A wedding gets a design only through a
  registered id.
- Links, prices or plan rules.

A design file holds presentation only: `id`, `label`, `description`,
`theme`, `layout`, `hero`, `order`, `show`, `gallery`, and optionally
`version`, `kind`, `variant`, `recommended`, `photoSlots`, `wording`,
`accents`, `showsWhenAdded`.

## Not part of this step

Customized templates are **not** being newly connected to Wedding Setup as
part of this task. Today a Customized template is used exactly as before:
as the base of a Luna Bridal Custom design that Super Admin assigns,
previews and publishes, filled with the same Wedding Setup content as
every invitation. How customized designs consume Wedding Setup data (new
fields, per-design content) will be designed separately.
