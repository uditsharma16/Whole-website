# TSO Central Archives

A Sith-themed archive laid over the Order's Google Site, read live and served as a
Cloudflare Worker with static assets. The Google Site is the source of truth: its pages become
vaults, and every Google Doc, Sheet, Slides deck, Form, Drive file or folder those pages link to
or embed becomes a page of the archive. Publishing a change on Google Sites shows up here within
a couple of minutes.

Source site: https://sites.google.com/view/tso-central-archives/home

## What becomes what

| On the Google Site | In the archive |
| --- | --- |
| A tab in the site's menu | A section (I, II, III…) in the index rail and the orrery |
| A page in a tab's dropdown | An inner vault (II.1, II.2…) inside its section |
| A page only linked from other pages | A vault under the page its address sits beneath |
| A menu link that leaves the site | The same link, in the same place in the rail |
| A linked or embedded Google Doc | A reading page at `/doc/<id>` with contents, footnotes and full-text search |
| A Google Sheet | A filterable table per tab at `/sheet/<id>` |
| Slides, Forms, Drive files and folders | A framed viewer at `/slides/…`, `/form/…`, `/file/…`, `/folder/…` |
| Every linked file | The Catalogue (A–Z card index) at `/codex` |

Links between pages and documents are rewritten to the archive's own routes, so the whole site,
documents included, reads as one place.

Documents must be shared as **Anyone with the link can view** (or published to the web). A
document that isn't is shown as a sealed record with a link to the original.

## Local development

```bash
npm install
npm run dev
```

To develop without reaching Google (or against saved copies of the site and its documents),
point the Worker at any server that mirrors Google's paths as `/<host><path>`:

```bash
npx wrangler dev --var GOOGLE_UPSTREAM:http://127.0.0.1:8899
```

With that set, `https://sites.google.com/view/…` is read from
`http://127.0.0.1:8899/sites.google.com/view/…`, and so on for `docs.google.com` and
`drive.google.com`.

## Deployment

```bash
npm run deploy
```

Pushes to `main` deploy automatically through `.github/workflows/deploy.yml`, which needs the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## Effects

Records are kept as holocrons; opening one lifts its capstone and floods the screen with its
light. A page that is a roll of the fallen (a portrait, a name and a few lines, again and again,
like the Valley of the Dark Lords) becomes a walk down a canyon past their statues, each
waking from stone as you draw level with it.

Hold the pointer down on any empty part of the page to channel Force lightning, touch the
archive core on the home page, or type `power`. Type `peaceisalie` (the start of the Sith
Code, as one word) or enter it in the terminal to hear the rest of it; the archive stays
awakened for the visit. Type `emperor` (or pick "Summon the Emperor" in the terminal) and
Darth Azazel, the Sith Emperor, rises and powers up. Type `regent` and Darth Zephros, Dark
Regent of the Sith, sheathes his sword as the enemies of the Sith fall. Type `voice` and
Darth Soteris, the Emperor's Voice, works an ancient spell from a book of Sith sorcery.
Type `wrath` and Darth Aeravix, the Emperor's Wrath, plants the banners of conquest across a war map of the
galaxy. Type `hand` and Darth Astarion, the Emperor's Hand, steps out of the shadows and snaps. Everyone starts on full effects; devices that
render the atmosphere slowly switch to a lighter mode automatically, and the footer switch
(or `?fx=lite` / `?fx=full`) chooses either one by hand.
