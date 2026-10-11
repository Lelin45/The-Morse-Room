# Chat setup for The Morse Room

The trainer still runs with Node 22.13 or newer and `npm start`. That server serves Learn and Practice locally. Chat uses Cloudflare Pages Functions and a D1 database, so use the steps below for chat development and the public site.

Production site: `https://learnmorse.lelinadhikari.com.np`

Chat uses Google sign-in. Enter production OAuth credentials directly in your Cloudflare project's secrets settings. Keep credentials and downloaded OAuth JSON files out of Git, public files, screenshots, and chat messages.

## 1. Run the chat server locally

Install the development tools once:

```sh
npm install
```

Copy the local settings template. In Windows PowerShell:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

On macOS or Linux:

```sh
cp .dev.vars.example .dev.vars
```

Leave the Google fields empty to inspect the setup screen without credentials. The supplied `SITE_URL` is `http://localhost:8788`. Initialize local D1, then start Pages:

```sh
npm run db:local
npm run dev:chat
```

Open `http://localhost:8788`, using `localhost` consistently. `/api/config` reports database and Google readiness; `/api/me` reports the current session. Without Google credentials, login stays unavailable. The local database persists under `.wrangler/state`. It is separate from the production database.

The migration command uses `wrangler.local.jsonc`; its database identifier is local only. The development server uses matching local D1 and `SITE_URL` command flags. Do not deploy the local configuration. Wrangler's local Pages server supports D1 bindings and local secrets. [Pages local development](https://developers.cloudflare.com/pages/functions/local-development/), [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/).

For real Google login locally, add a separate web OAuth client's redirect URI `http://localhost:8788/api/auth/google/callback`, then enter that development client's ID and secret in `.dev.vars`. Restart the server after changing that file.

## 2. Connect the GitHub repository to Cloudflare Pages

In Cloudflare, open **Workers & Pages**, select the existing Pages project for this site, or create a Pages project connected to `Lelin45/The-Morse-Room`. Set:

| Build setting | Value |
| --- | --- |
| Framework preset | None |
| Production branch | `main`, or your existing production branch |
| Build command | `npm run build` |
| Build output directory | `public` |
| Root directory | Repository root |
| Node version | 22 or newer |

Set `NODE_VERSION=22` if your project needs an explicit build Node version. Keep the existing custom domain `learnmorse.lelinadhikari.com.np` attached to this Pages project. Git pushes to the production branch then build and deploy the site. [Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/), [Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/).

The build copies only the named browser files and the public privacy/terms pages into `public`. It adds `_routes.json`, which invokes Functions only for `/api/*`, and `_headers` for static asset security. The root `functions/api/[[path]].js` is compiled separately by Pages. Do not set the output directory to the repository root. Database migrations, server source, tests, credentials, configuration files, and this guide are not public assets. [Functions routing](https://developers.cloudflare.com/pages/functions/routing/), [Functions setup](https://developers.cloudflare.com/pages/functions/get-started/), [Static headers](https://developers.cloudflare.com/pages/configuration/headers/).

## 3. Create and bind production D1

In Cloudflare's D1 area, create a database named `morse-room-chat`. In the Pages project's **Settings > Bindings**, add a D1 binding named exactly `DB` and select that database. Set it for Production. If you enable chat in Preview, use a separate preview database and separate Google client configuration. Redeploy after changing bindings. [D1 bindings for Pages](https://developers.cloudflare.com/pages/functions/bindings/#d1-databases).

To apply the checked-in SQL migrations, copy `wrangler.jsonc.example` to `wrangler.jsonc`, then replace the Pages project name and D1 database ID with your actual values. The example contains placeholders, and `wrangler.jsonc` is ignored by Git.

For token authentication, create a custom Cloudflare API token with **Account > D1 > Edit** and **Account > Cloudflare Pages > Edit**, restricted to the account containing this Pages project. Add these values to a local `.env` file:

```dotenv
CLOUDFLARE_API_TOKEN=""
CLOUDFLARE_ACCOUNT_ID=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
SITE_URL="https://learnmorse.lelinadhikari.com.np"
```

The file is ignored by Git and excluded from the public build. Keep the token and client secret in this file or Cloudflare's secret settings. Apply remote migrations using the token without a browser login:

```sh
node --env-file=.env node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote --config wrangler.jsonc
```

This command targets the database in that private configuration. Check its name and ID first. It applies files under `migrations/`, including `0001_chat.sql` and `0002_friendship_lookup.sql`, and records which migrations have run. Running `db:local` instead changes only local D1. [API token creation](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [Wrangler token authentication](https://developers.cloudflare.com/workers/authorization/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

The ignored Wrangler file is for your local CLI. Git-connected production builds use the Pages dashboard bindings because the committed configuration is an example rather than an active production file. If you later commit a production Wrangler configuration, it becomes the source of truth for its supported settings; keep credentials in Cloudflare secrets. [Pages Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/).

## 4. Add site settings and Google credentials

In the Pages project's **Settings > Variables and Secrets**, add these to Production. Use the Secret type for `GOOGLE_CLIENT_SECRET`. The client ID and site URL can be plain variables. Redeploy after saving. [Pages environment variables and secrets](https://developers.cloudflare.com/pages/functions/bindings/#environment-variables).

| Name | Value |
| --- | --- |
| `SITE_URL` | `https://learnmorse.lelinadhikari.com.np`, without a trailing slash |
| `GOOGLE_CLIENT_ID` | Google's web OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google's web OAuth client secret |

`DB` is a D1 binding, not a text variable. Google sign-in needs both Google values. The client secret stays on the server and is not included in the public build.

## 5. Configure Google sign-in

Create or select a project in [Google Cloud Console](https://console.cloud.google.com/), then open **Google Auth Platform**.

The sign-in button uses Google's pre-approved light and dark PNG assets from its [branding guide](https://developers.google.com/identity/branding-guidelines). Keep these images and their proportions when changing the login screen.

In **Branding**, use The Morse Room as the app name and your actual support/contact email. Set these public URLs:

| Field | Value |
| --- | --- |
| Application home page | `https://learnmorse.lelinadhikari.com.np/` |
| Privacy policy | `https://learnmorse.lelinadhikari.com.np/privacy.html` |
| Terms of service | `https://learnmorse.lelinadhikari.com.np/terms.html` |
| Authorized domain | `lelinadhikari.com.np` |

The homepage must describe the app and link to the privacy policy. Review the public policy before launch so it accurately describes this app's account and message storage. For brand verification, verify ownership of the registrable domain through Google Search Console using an account associated with the project. Follow any requests in Google's Verification Center. [Google brand and domain requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

In **Audience**, choose External for public Google accounts. While setting up, add your own Google account under Test users. This app requests only `openid email profile`; Google documents an exception to the usual test-user and seven-day authorization restrictions for those basic sign-in scopes. When ready for the public site, use **Publish app** in Audience and complete any required verification. Do not add Gmail, Drive, or other scopes for this chat. [Google audience and testing rules](https://support.google.com/cloud/answer/15549945?hl=en), [Google OpenID Connect scopes](https://developers.google.com/identity/openid-connect/openid-connect).

In **Clients**, create an OAuth client of type **Web application**. Use:

```text
Authorized JavaScript origin:
https://learnmorse.lelinadhikari.com.np

Authorized redirect URI:
https://learnmorse.lelinadhikari.com.np/api/auth/google/callback
```

Copy the resulting client ID and secret directly into the Cloudflare fields above. The callback must match exactly, including protocol, hostname, and path. Keep localhost development credentials separate from the production client if possible. [Google web OAuth client setup](https://support.google.com/cloud/answer/15549257?hl=en), [Google web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server).

## 6. Check the finished deployment

After the database migration, binding, Google configuration, and redeployment:

1. Open the production site's Chat view. Confirm **Sign in with Google** is available.
2. Sign in, choose a valid username, and test a room message between two real accounts or separate browser profiles.
3. Verify refresh and sign-out behavior. Test a direct message with a second account.
4. Open `/api/config` and confirm `available` and `providers.google` are `true`. The Google client secret must never appear in this response or in browser source.
5. Check the public privacy and terms links from the homepage and Google's consent screen.

If Google reports `redirect_uri_mismatch`, compare the client's registered URI to `SITE_URL` plus `/api/auth/google/callback`. A missing database usually means the `DB` binding or migration is absent, or the project needs redeployment. `npm start` serves the offline trainer; it does not emulate Pages Functions or D1.

## 7. Running on the free plan

No rented server or Cloudflare Pro subscription is required. Cloudflare Pages serves the browser files, Pages Functions runs the chat API, and D1 stores accounts, friends, memberships, messages, and sessions. Keep the Workers account on the Free plan.

Current published allowances, checked October 11, 2026:

| Resource | Free allowance |
| --- | --- |
| Static Pages asset requests | Unlimited |
| Pages Functions and Workers requests | 100,000 per day, shared across the account |
| D1 rows read | 5 million per day |
| D1 rows written | 100,000 per day |
| D1 database size | 500 MB per database |
| D1 total storage | 5 GB across up to 10 databases |
| D1 Time Travel recovery | 7 days |

[Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The initial app uses one D1 database, so its storage limit is 500 MB. The 5 GB allowance does not make that single database 5 GB. Read/write quotas count scanned rows and index writes, not individual chat messages. There is no fixed user-count promise: concurrent activity and message volume determine usage.

To reduce usage, the client checks an open conversation every five seconds, the Chat inbox every 30 seconds, and the inbox outside Chat every minute. Opening the bell refreshes it immediately. Hidden tabs stop polling. Read positions are written only when new messages were received; failed polling uses a delay before retrying. Queries use indexes, newest-message lookups read one indexed row, and message history loads in pages of 100. Audio is generated in the recipient's browser, so there are no stored audio files or paid audio services.

For a rough request estimate, one hour with a visible open conversation uses about 720 message checks plus 120 inbox checks, before sending, reading, sign-in, or other actions. Ten people chatting for an hour is roughly 8,400 polling requests. This is an estimate, not a capacity guarantee. Limits are shared with any other Workers on your account.

Daily D1 limits reset at 00:00 UTC, or 05:45 in Nepal. When a free D1 quota is exhausted, queries fail until the daily reset; when storage is full, new data needs space freed. Staying on the Free plan does not turn these blocked D1 operations into paid overages. Learn and Practice run in the browser and remain usable when chat is unavailable. [D1 free-limit behavior](https://developers.cloudflare.com/d1/platform/pricing/#what-happens-if-i-exceed-the-daily-limits-on-reads-and-writes-or-the-total-storage-limit-on-the-free-plan).

Manage the database in Cloudflare's D1 dashboard. Check **Metrics > Row Metrics** and storage after launch. Cloudflare handles the database server and provides Time Travel recovery; you can also export a copy to your computer using `wrangler d1 export`. Treat exported chat data as private. If needed, inspect and remove stale data through D1's SQL console. No extra database provider is needed for this version.
