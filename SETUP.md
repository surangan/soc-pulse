# SoC Pulse server-side pipeline — setup

The repo contains a GitHub Action (`.github/workflows/scan.yml`) that runs
`scan.mjs` **hourly on GitHub's servers**, scanning public sources and
committing the results to `data/mentions.json`. The dashboard reads that file
on every scan, so all mentions found by the server appear for every team
member — shared history, no browser limitations.

## What works with zero setup

NUSWhispers, Bluesky and Hacker News are scanned server-side immediately.
Nothing to configure. To trigger the first run manually:

1. Go to the repo's **Actions** tab
2. Select **SoC Pulse scan** in the left sidebar
3. Click **Run workflow** → **Run workflow**

After ~1 minute it commits `data/mentions.json`, GitHub Pages redeploys
(~90 seconds), and the next dashboard scan will show a "Server feed" line.

> If the Actions tab shows a prompt asking you to enable workflows, click
> enable — GitHub sometimes requires one-time confirmation for workflows
> added to a repo.

## Enabling Reddit (5 minutes, free)

Reddit blocks all anonymous and proxy access, but its official API has a
generous free tier. You need a Reddit account.

1. Log in to Reddit, then open **https://www.reddit.com/prefs/apps**
2. Click **create app** (bottom). Fill in:
   - **name**: `soc-pulse-scanner`
   - **type**: select **script**
   - **redirect uri**: `http://localhost` (required but unused)
3. Click **create app**. Note two values:
   - the **client ID** — the short string under the app name, beneath
     "personal use script"
   - the **secret** — labelled `secret`
4. In this GitHub repo: **Settings → Secrets and variables → Actions →
   New repository secret**. Create these secrets (paste the values you noted):
   - `REDDIT_CLIENT_ID`
   - `REDDIT_CLIENT_SECRET`
   - `REDDIT_USER_AGENT` (optional) — e.g. `soc-pulse by u/YOUR_USERNAME`
5. Run the workflow again from the Actions tab. The run log should show
   `Reddit · r/nus: N new` instead of `FAILED - no credentials`.

Secrets are encrypted by GitHub and are **not** visible in the public repo
or to the dashboard — only the Action can read them. Never put these values
in `index.html` or any committed file.

## Notes

- The server keeps a rolling **30-day** window (max 300 items) in
  `data/mentions.json`; the dashboard then applies whatever retention window
  you choose in its Settings on top of that.
- Each hourly run only commits when something changed, so quiet hours add no
  commits.
- Browser-side scanning still runs as before; server and browser results are
  de-duplicated by post ID.
- Future channels (X, LinkedIn, TikTok, press RSS) can be added as extra
  functions in `scan.mjs` following the same pattern.
