# RestockGuard

**An AI restock agent for small online stores. It buys from the best supplier the moment a customer pays, and never buys at a loss.**

Live demo: https://restockguard.onrender.com (store) · https://restockguard.onrender.com/dashboard.html (owner dashboard)
PayPal sandbox only. The free Render instance sleeps when idle, so the first load can take up to a minute.

Built for the PayPal AI Hackathon.

## The problem

Small stores that ship straight from suppliers (wholesale drop shipping, or
restocking on demand) re-buy every order by hand: compare suppliers, check that
the price still leaves a margin, pay, and copy the tracking number back to the
customer. It is the perfect job for an AI agent, except that an agent with a
payment method can also overpay, pay twice, trust a brand-new supplier, or buy
at a loss when a supplier quietly raises its price.

## What RestockGuard does

1. **A customer pays** in the store with PayPal Checkout (Orders v2, capture).
2. **The agent starts** on the capture, and again on the
   `PAYMENT.CAPTURE.COMPLETED` webhook if the browser was closed (idempotent).
3. **AI matches products.** Three suppliers name the same goods differently and
   not all publish a GTIN. GTIN decides when both sides have one; otherwise the
   model judges "same item, same size, same pack?" with a confidence score.
4. **Landed cost** (unit cost × qty + shipping) is computed for every matching,
   in-stock offer fast enough for the delivery limit.
5. **Rules in code decide what may be paid automatically:**
   - never below the minimum margin; a loss is always blocked
   - per-order limit and daily supplier budget
   - a supplier price jump or a brand-new supplier needs the owner
   - one supplier payment per customer order (own lock + PayPal `sender_batch_id`)
6. **It pays the supplier with PayPal Payouts**, follows the batch until it
   succeeds (webhook + polling), and **adds the supplier's tracking number to the
   customer's PayPal order**.
7. **Anything that needs the owner** waits in Approvals (optional Telegram
   alert). Approving re-quotes first: an offer that no longer keeps the margin is
   never paid.

### Where the AI is, and where it is not

| AI does | Code does |
|---|---|
| decide whether two differently named listings are the same product | every price, landed cost and margin |
| turn a plain-language instruction ("keep 25% margin, ask me above $80") into a rule change that the owner previews and applies | every check that decides whether money moves |
| | the decision text shown to the owner |

During testing the model once rewrote "Supplier C is a new supplier (12 days)"
as "12-day marketplace processing": every number was right, the reason was
wrong. Since then the explanation of a money decision is built from the exact
rule results, never paraphrased by the model.

## Try it (sandbox)

1. Open the store and buy **coffee** with the sandbox buyer account: bought
   automatically from Supplier A (the cheaper Supplier C is new, so it is skipped).
2. Buy **2 × earbuds**: $90 is above the $60 per-order limit, so it waits in
   **Approvals**. Approve it: Supplier C is paid by Payouts.
3. In **Suppliers**, raise Supplier A's bottle cost (A-1002) to 30, then buy the
   **bottle**: blocked, nothing is paid.
4. In **Rules**, type a change in plain words, preview it, apply it.

Owner actions need the owner token (set on the server as `ADMIN_TOKEN`); it is
given to judges in the submission's testing instructions.

## PayPal integration

| PayPal product | Used for |
|---|---|
| JavaScript SDK + Orders v2 (create, capture) | customer checkout |
| Webhooks (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTSBATCH.*`), signature verified | start the agent, payout status |
| Payouts | pay the supplier, one batch per customer order |
| Orders v2 tracking (`/v2/checkout/orders/{id}/track`) | supplier tracking number on the customer's order |

## Run locally

```bash
npm install
PAYPAL_MODE=mock npm start          # no keys needed, PayPal calls are simulated
open http://localhost:3000          # store; /dashboard.html for the owner
npm test                            # end-to-end flows in mock mode
```

For the sandbox, copy `.env.example` to `.env` and fill in the sandbox app keys,
the webhook id and the three supplier sandbox accounts. Any OpenAI-compatible
endpoint works for the AI (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`); the demo
uses Qwen3-235B through the Otari gateway. Without a key, product matching falls
back to a simple text heuristic.

## Stack

Node 22 (built-in SQLite), Express, PayPal REST APIs, AG Grid Community for the
owner dashboard, any OpenAI-compatible model endpoint, Render.

## Limits

- Suppliers are demo feeds inside the app; real suppliers would be their APIs or
  price files. Supplier payment here is a direct PayPal Payout to the supplier's
  sandbox account.
- The free Render instance keeps data in a local SQLite file that resets on redeploy.

## License

MIT
