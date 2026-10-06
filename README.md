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

Hold the pointer down on any empty part of the page to channel Force lightning, touch the
archive core on the home page, or type `power`. Everyone starts on full effects; devices that
render the atmosphere slowly switch to a lighter mode automatically, and the footer switch
(or `?fx=lite` / `?fx=full`) chooses either one by hand.
