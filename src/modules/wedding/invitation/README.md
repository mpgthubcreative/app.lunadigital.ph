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
  customized/       Customized designs (Luna Bridal Custom): Super Admin assigns one
    garden/template.js      Garden (Custom-only; existing designs use it)
  registry.js       The one list of every design: id, name, category, source, availability
  renderer.js       The guest page /w/{slug}/invite/{token}
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
| `garden` | Garden | Customized | Super Admin, in a Luna Bridal Custom design |

Ids are permanent: weddings (`weddingSetup/current.templateId`) and Custom
designs (`invitationDesign/current` draft / published `config.templateId`)
store them. Never rename or reuse an id; a folder's name is its id. An
unknown or missing id shows Luna Standard.

## Add a Standard template

1. Copy a folder under `templates/`, e.g. `templates/classic/` to
   `templates/vintage/`.
2. In `template.js`, give it a new permanent `id` (`"vintage"`, the same as
   the folder), a `label` and a `description`, and change the `theme`,
   `layout`, `hero`, `order`, `show` and `gallery` values.
3. Register it (below). It then appears in Wedding Setup's template picker
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
`theme`, `layout`, `hero`, `order`, `show` and `gallery`.

## Not part of this step

Customized templates are **not** being newly connected to Wedding Setup as
part of this task. Today a Customized template is used exactly as before:
as the base of a Luna Bridal Custom design that Super Admin assigns,
previews and publishes, filled with the same Wedding Setup content as
every invitation. How customized designs consume Wedding Setup data (new
fields, per-design content) will be designed separately.
