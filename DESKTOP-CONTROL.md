# Windows desktop control and real integration checks

Use the installed Computer Use skill and its `@oai/sky` API through `node_repl`
for native operations. Chrome uses the browser plugin; GitHub uses the connected
GitHub plugin. This repository never copies app approvals or account credentials.

## Recover the correct native window

1. Keep the target app visible on the active, unlocked Windows desktop.
2. Obtain apps/windows from `sky.list_apps()` or `sky.list_windows()`.
3. If the app is closed, use its returned app identifier or a supported executable
   path with `sky.launch_app`. A packaged Notepad may launch through
   `C:\Windows\System32\notepad.exe`, but its real window has the app identifier
   `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`. Do not manufacture a window handle.
4. A launcher error saying it exposed no targetable window can mean a Windows
   launcher handed off to a packaged app. Re-enumerate windows once and select the
   actual returned app/window by the test document title. Require one match.
5. `Computer Use app approval timed out` is an unmet app approval. Ask the user to
   complete the app's Allow prompt. Do not edit the allow-list or click permission
   dialogs for the user. A new computer must obtain its own app approvals.
6. An `accessibility: null` result is not proof that the app is unusable. Capture
   the selected window's screenshot and use its current screenshot ID. Click the
   observed editor, refresh and verify focus before typing. Refresh after actions.
7. If a window disappears, re-enumerate and bind a fresh returned window. Do not
   reuse old IDs/coordinates, keep retrying indefinitely, or count enumeration as
   a successful click/input test. Do not use a short-lived launcher/test process
   as evidence that a persistent app is broken.

## On-device test (not a CI-only or schema-only test)

Run `npm run test:desktop:prepare`. Save its manifest path. Generated fixtures and
receipts live in an ignored `.ollamaforge-desktop-tests/<id>/` directory.

- **Native:** Open `nativeFile` in Notepad. Through Computer Use, click the editor,
  append `markerA`, and save with Ctrl+S. Run
  `node desktop-smoke.mjs native <manifest> 1`. Close only this saved test tab,
  reopen the file, bind the newly observed window, append `markerB` and save.
  Run `node desktop-smoke.mjs native <manifest> 2`. Leave unrelated documents alone.
- **Chrome:** Run `node desktop-smoke.mjs serve <manifest>`. Open the displayed
  loopback URL with the Chrome plugin, enter the displayed marker, click Verify,
  and observe PASS. Run `node desktop-smoke.mjs chrome <manifest>`.
- **GitHub:** On a repository the user authorized for these tests, use the GitHub
  plugin to create `githubBranch` from its default branch and create `githubFile`
  containing `githubContent`. Run
  `node desktop-smoke.mjs github <manifest> <repo>` to fetch that branch and read
  the uploaded marker back through Git. This does not change the checked-out
  branch or push the main branch. Delete only this disposable test branch after
  checking its remote tip still equals the verified commit.

If GitHub connector writes return `403 Resource not accessible by integration`,
do not confuse the connector's installation permissions with the user's push
permission and do not keep retrying that endpoint. Use the computer's existing
authenticated Git/GitHub CLI for writes. The packaged fallback is
`node desktop-smoke.mjs github-write <manifest> <repo>`: it writes only the
disposable branch, then independently fetches and verifies its marker. It never
copies tokens, changes connector permissions, or pushes the default branch.
An unconfigured computer must sign in to its own GitHub account first.

Finally run `node desktop-smoke.mjs verify <manifest>`. It exits unsuccessfully
if any real component receipt is missing. Unit tests do not constitute an
on-device pass. Stop the loopback server and close only the agent-created test
tabs. Existing app permission prompts, locked desktops, disconnected Chrome and
missing GitHub authentication must be reported as blockers, never PASS.
