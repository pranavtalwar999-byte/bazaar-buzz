# Bazaar Buzz: local server

A hyperlocal deals platform. Shops post offers, and people nearby discover them.
This folder runs the full website **plus a backend that saves every sign-up, deal, coupon and payment**.

No installs needed. It only uses Node.js built-ins.

## 1. Run it

1. Install Node.js 18 or newer from https://nodejs.org (skip this if you already have it; check with `node -v`).
2. Open a terminal in this folder and run:

```bash
node server.js
```

3. Open **http://localhost:3000** in your browser.

You'll see:
```
🚀 Bazaar Buzz running at  http://localhost:3000
🔐 Admin page:          http://localhost:3000/admin?key=bazaarbuzz-admin
💾 Data saved in:       data/db.json
```

The sign-in popup shows **🟢 Connected to Bazaar Buzz server** when everything is working.

## 2. Where the data goes

Everything is saved in **`data/db.json`**:

| What | Saved details |
|---|---|
| users | name, email, role (explorer / business), plan, sign-in method, join date. Passwords are **hashed with scrypt**, never stored as plain text |
| sessions | login tokens, so people stay logged in |
| deals | offers posted by businesses (everyone sees these) |
| claims | coupon codes claimed by users |
| payments | pack purchases (test mode until Razorpay is added) |

**Admin panel:** open `http://localhost:3000/admin?key=bazaarbuzz-admin` to see all users, deals, coupons and payments in tables. This is handy for your project demo.
Change the key before showing it to anyone (see step 4).

To reset all data, stop the server and delete `data/db.json`.

## 3. Let friends use it (same Wi-Fi)

Find your laptop's IP address (Mac: `ipconfig getifaddr en0`, Windows: `ipconfig`), then others on the same Wi-Fi open
`http://YOUR-IP:3000`.

> GPS only works on `localhost` or `https://`, so on other phones over Wi-Fi people pick their state and city instead.
> For a public https link, deploy this folder to **Render.com** or **Railway.app** (free tiers run `node server.js` directly).

## 4. Settings (optional)

Copy `config.example.json` to `config.json` and fill in what you need:

```json
{
  "PORT": 3000,
  "ADMIN_KEY": "change-this-secret",
  "GOOGLE_CLIENT_ID": "",
  "X_CLIENT_ID": "",
  "X_CLIENT_SECRET": "",
  "BASE_URL": "http://localhost:3000"
}
```

Restart the server after changing it.

## 5. Real social login

Until you add keys, the Google / X / Apple buttons run in **demo mode**: the person enters their name and email, and the account is still saved on the server (marked `google-demo` etc. in the admin panel).

### Google (free, about 10 minutes)
1. Go to https://console.cloud.google.com → create a project.
2. **APIs & Services → OAuth consent screen**, choose External and fill in the app name.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
4. Under **Authorized JavaScript origins** add `http://localhost:3000`.
5. Copy the **Client ID** into `config.json` as `GOOGLE_CLIENT_ID`, then restart.

The real "Continue with Google" button now appears, and the server verifies every login with Google.

### X / Twitter (free developer account)
1. Go to https://developer.x.com → create a project and app.
2. Turn on **OAuth 2.0**, set the type to **Web App**, and set the callback URL to `http://localhost:3000/auth/x/callback`.
3. Copy the **Client ID** and **Client Secret** into `config.json`, then restart.

### Apple
Sign in with Apple needs a paid Apple Developer account (US$99 per year) and an https domain, so it stays in demo mode for this project.

## 6. Real payments (Razorpay)

Checkout runs in **test mode** (nothing is charged), but payments are still recorded.
To accept real money, create a Razorpay account, put your Key ID in `RAZORPAY_KEY` at the top of the script in `public/index.html`,
and add server-side order creation and signature verification before you go live.

## Files

```
server.js            ← backend (API + admin page + serves the website)
public/index.html    ← the website
data/db.json         ← your data (created automatically)
config.example.json  ← settings template
```

## API (for your project report)

| Method | Route | What it does |
|---|---|---|
| POST | /api/signup | Create an account (name, email, password, role) |
| POST | /api/login | Log in, returns a token |
| GET | /api/me | Current user (needs token) |
| POST | /api/logout | End the session |
| POST | /api/auth/google | Google sign-in (verifies the ID token) |
| POST | /api/auth/demo | Demo social sign-in |
| GET | /auth/x/start | X sign-in (OAuth 2.0 + PKCE) |
| GET | /api/deals | All posted deals |
| POST | /api/deals | Post a deal (business accounts only) |
| POST | /api/claims | Claim a coupon, returns a code |
| POST | /api/plan | Change pack after payment |
| GET | /admin?key=… | Admin dashboard |
