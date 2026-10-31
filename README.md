# ASEAN Startup Passport (prototype)

Gemma-powered eKYB and deal matching for ASEAN startups. Synthetic data only.

## Run

```bash
python3 server.py                       # http://localhost:8080, mock extractor
PASSPORT_BACKEND=ollama GEMMA_MODEL=gemma3:12b python3 server.py
PASSPORT_BACKEND=openai GEMMA_URL=http://localhost:8000/v1 python3 server.py   # vLLM, LM Studio, etc.
python3 -m unittest discover -s tests -t .
```

## What is here

- `passport/`: extraction backends (mock, Ollama, OpenAI-compatible Gemma), UBO graph, cross-checks, readiness score (AIRS, 0-1000), W3C-style verifiable credential.
- `samples/`: synthetic registry, financial, tax and compliance documents for "Kopi Ledger" across SG, MY, ID, TH and VN.
- `web/`: the app. Login, MyProfile, Home dashboard, Challenges (rule-based AI match, post a solution), KYB (the analyzer), DealTracker (six stages), and Notifications. App state lives in browser localStorage.

## Notes

- Approval for posting is readiness of 650 or more. High-severity findings are shown as conditions.
- The credential uses an HMAC demo key. A production issuer would sign with Ed25519 and publish a DID.
- Buyers in the challenge list are fictional and marked "(demo)". No real company names or logos are used.
