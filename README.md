# Anamne

A Chrome extension that saves your AI conversations to a searchable archive in your browser and can write them into your Obsidian vault as Markdown.

Supported sites: ChatGPT, Claude, Gemini, Perplexity, Grok and DeepSeek.

- Store: https://chromewebstore.google.com/detail/famgjpiggdaenmgnemmcjobbogdmghlj
- Site: https://getanamne.com

Anamne has no server, no account and no telemetry. Conversations are stored in the browser's IndexedDB and only leave it when you sync them to a folder you picked.

## Features

- Saves a conversation when you open or refresh it on a supported site.
- Full-text search, nested folders, tags and bulk actions in a full-page archive.
- Obsidian sync: Markdown with YAML frontmatter, written through the File System Access API.
- Images generated in ChatGPT and Gemini are stored with the conversation and written next to the note.
- Export all: every conversation as Markdown, with its images, in one .zip.
- Prompt library with `{{variable}}` fill-ins, available from a button on the chat sites.
- Light and dark theme.

## How capture works

Anamne reads the JSON the chat sites already download, not the rendered page, so layout changes don't break it.

1. `inject.js` runs in the page's own context (MAIN world) and wraps `fetch` and `XMLHttpRequest`. It copies response bodies for conversation endpoints and never alters the originals.
2. `platforms.js` holds the URL rules that decide which endpoints are conversations, one entry per site.
3. `bridge.js` (ISOLATED world) forwards those payloads to the service worker.
4. `background.js` parses them with `parsers.js` into one common shape and stores them through `db.js`. For ChatGPT and Gemini it also fetches the generated images.
5. `popup.js`, `archive.js` and `prompts.js` are the extension pages. `obsidian.js` handles folder sync from those pages, because the File System Access API needs a window and a user click.

If a site changes its API, the popup's **Diagnostics** view lists every request Anamne saw and whether it matched. That log is the first thing to attach to a bug report.

## Install from source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

There is no build step; the files load as they are.

## Tests

The tests are plain Node scripts (Node 18 or later, no dependencies):

```sh
for t in test/*.test.mjs; do node "$t" || exit 1; done
```

They cover the parsers (with recorded payloads from each site), the endpoint rules, image extraction, the Markdown renderer, archive search, the prompt templating and the zip writer.

## Packaging

```sh
tools/package.sh
```

Writes `dist/anamne-v<version>.zip` containing only the runtime files listed in the script.

## Adding a site

1. Add an entry to `PLATFORMS` and `HOST_PATTERNS` in `platforms.js`.
2. Add a `parse<Site>` function in `parsers.js` and register it in the `PARSERS` map in `background.js`.
3. Add the host to `host_permissions` and the three `content_scripts` match lists in `manifest.json`.
4. Add a test in `test/parsers.test.mjs` with a real (anonymized) payload.

## Contributing

Bug reports and pull requests are welcome. For capture bugs, include the site, what you expected to see, and the Diagnostics log from the popup. Please keep pull requests focused, and add or update a test when you change parsing.

## License

MIT, see [LICENSE](LICENSE). Anamne is not affiliated with OpenAI, Anthropic, Google, Perplexity, xAI, DeepSeek or Obsidian.
