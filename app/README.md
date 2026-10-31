# ASEAN Startup Passport (Vite app)

A fully static build of the eKYB prototype. Everything runs in the browser, so it deploys to Cloudflare Pages with no server.

```bash
cd app
npm install
npm run dev        # http://localhost:5173
npm test           # analysis parity with the Python reference, plus credential checks
npm run build      # outputs dist/
```

## Deploy to Cloudflare Pages

Option 1, Wrangler CLI (needs a Cloudflare account and `npx wrangler login`):

```bash
npm run build                       # from the repo root
npx wrangler pages deploy app/dist --project-name asean-startup-passport
```

Option 2, Git integration: in the Cloudflare dashboard create a Pages project from this repo. The root `wrangler.toml` and `package.json` set the build (`npm run build`) and output (`app/dist`), so the defaults work.

`public/_headers` sets a strict Content-Security-Policy. Gemma calls are made from the browser, so
the endpoint must allow CORS from the Pages domain.

## What is here

- `src/passport/`: the analyzer in plain JS (label extractor, UBO graph, cross-checks, AIRS score, verifiable credential via Web Crypto). Mirrors `../passport/` in Python.
- `src/samples/`: the nine synthetic filings, bundled at build time.
- `src/main.js`: the app. Login, Home dashboard, MyProfile, Challenges (rule-based match, post a solution gated on KYB), KYB, DealTracker (six stages), and Notifications. State is kept in localStorage.
- Backends: `mock` runs in the browser with no network. `gemma` calls any OpenAI-compatible endpoint (vLLM, LM Studio, a local gateway). Set the URL in the KYB panel.

## Notes

- The credential uses an HMAC demo key, so it proves integrity only within this demo. A production issuer would sign with Ed25519 and publish a DID.
- All companies, people and buyers are synthetic. Scores are illustrative, not legal or investment advice.
