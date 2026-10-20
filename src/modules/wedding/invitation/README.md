# Bridal invitation

One invitation engine for every wedding. Templates are source code here;
a wedding stores only which template it uses.

| File | What it is |
| --- | --- |
| `templates/standard/template.js` | Luna Standard: the original invitation (the default) |
| `templates/classic/template.js` | Classic |
| `templates/modern/template.js` | Modern |
| `templates/romantic/template.js` | Romantic |
| `templates/editorial/template.js` | Editorial |
| `templates/garden/template.js` | Garden (Custom designs only; kept for existing designs) |
| `registry.js` | The list of templates, and which ones an Owner can choose (`tier: "standard"`) |
| `renderer.js` | The guest page `/w/{slug}/invite/{token}`: the Luna Standard page, or a template / Custom design |
| `preview.js` | The in-app preview (Owner and Super Admin), always with a sample guest in Super Admin |

What Firebase stores (per wedding, never the template source):

- `businesses/{bid}/weddingSetup/current`: the wedding content and the Owner's `templateId` (Luna Bridal)
- `businesses/{bid}/weddingSetup/hero`, `weddingGallery/*`: the couple's photos
- `businesses/{bid}/invitationDesign/current`: Luna Bridal Custom only. Super Admin's `templateId` plus overrides, as `draft` and `published` with the version history, and `live`
- `businesses/{bid}/invitationAssets/*`: the images a Custom design uses

Guest links (`invitations/{sha256(token)}`) don't depend on the template.
Switching templates, publishing a design or upgrading to Custom never
changes a link. During a free trial the couple chooses, fills in and
previews; guest links are made and opened once Luna Bridal is paid.

To add a template, copy a folder under `templates/`, give it a new
permanent `id`, and add it to `registry.js`.
