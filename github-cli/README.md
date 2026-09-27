# GitHub CLI

A Hana v2 app (`manifestVersion: 2`). Kind: `tool`.

The identity icon is declared by `icon` in the manifest and shipped in `assets/`. Keep the source image; Hana creates a display copy during installation. Large images are resized automatically, and small images only receive a clarity recommendation.

## SDK and validate

`index.js` imports the bundled local App SDK and uses `defineApp(async sdk => ...)`. Registration calls wait for the host acknowledgement; retain the returned receipt when later code must dispose a registration explicitly. The scaffold does not install packages or resolve imports from Hana's own `node_modules`.

Every declared card must have `face.image` pointing to a bundled, nonempty PNG/WebP/SVG under `ui/`. For `ui` and `full`, the scaffold copies the explicit `--cover` source into `ui/assets/`. Keep the declaration and file together when editing or packaging; a missing or invalid cover rejects the App. Tool-only Apps do not need a card cover.

## Validate

The scaffold has run static package validation. After editing, build if required, then run these commands from a Hana checkout:

```sh
node scripts/validate-app.mjs --dir /path/to/github-cli --json
node scripts/validate-app.mjs --dir /path/to/github-cli --smoke --json
```

Use `--archive /path/to/install.zip --json` to validate the final installation archive. Add `--smoke` when startup execution is part of the task: it starts a backend process and, for declared UI pages, an Electron runner. Static validation alone does not prove runtime behavior. UI packages use path-scoped relative assets and the App UI SDK.

## Startup arguments

This App declares no startup arguments. Add static `contributes.cliFlags` entries only when startup-time configuration is necessary; then start Hana with `hana serve -- --app.<id>.<flag>=<value>`.

## Install

1. Use Hana Builder to import this local directory into an isolated development project.
2. Complete App Manager's review and read the actual installation result.
3. For production installation, give the validated package or local directory to App Manager. The manifest id is `github-cli`.

## After you edit

Build changed sources, then explicitly reload through Builder or App Manager. Local-directory installs retain their source for reload. New permission requests require review; read the resulting state before continuing. Keep the source project separate from the disposable development environment.

## How the starter tool runs

The starter tool uses the declared name, without an automatic host prefix. The manifest requests `app/tools.expose-to-model`; after approval, enable the App for the intended Agent. Discover the current tool schema before calling it. The Agent's tool discovery mode determines whether the tool is listed directly or found through deferred discovery.

The full contract is in `APPS.md` / `APPS_EN.md`.
