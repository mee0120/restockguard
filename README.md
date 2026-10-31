# RestockGuard

**An AI restock agent for small online stores. It buys from the best supplier the moment a customer pays, and never buys at a loss.**

Built for the PayPal AI Hackathon (PayPal sandbox only).

## The problem

Small stores that ship straight from suppliers (drop shipping from wholesale
suppliers, or restocking on demand) re-buy every order by hand: compare
suppliers, check that the price still leaves a margin, pay, copy the tracking
number back to the customer. Handing this to an AI agent is tempting, but an
agent with a payment method can also overpay, pay twice or buy at a loss.

## What RestockGuard does

1. A customer pays in the store with **PayPal Checkout** (Orders v2).
2. The capture (and the `PAYMENT.CAPTURE.COMPLETED` **webhook**) starts the agent.
3. The agent reads three supplier feeds. Suppliers name the same goods
   differently and not all publish a GTIN, so **AI decides which listings are the
   same product** (GTIN wins when both sides have one).
4. It computes the landed cost (unit cost × qty + shipping) of every offer and
   drops offers that are out of stock, too slow or from blocked suppliers.
5. **Rules in code, not in the prompt**, decide what may be paid automatically:
   - never below the minimum margin (a loss is always blocked)
   - per-order limit and daily budget
   - a supplier price jump or a brand-new supplier needs the owner
   - one supplier payment per customer order (own lock + PayPal `sender_batch_id`)
6. It pays the chosen supplier with **PayPal Payouts**, adds the supplier's
   tracking number to the customer's PayPal order (**order tracking**), and
   explains the decision in plain words.
7. Anything that needs the owner waits in **Approvals** (Telegram alert).
   Approving re-checks the price first.

The owner dashboard uses **AG Grid**: orders, offers compared per order, rule
checks, approvals, supplier feeds (edit a cost to simulate a price change) and
the rules, which can also be changed in plain words.

## Run locally

```bash
npm install
PAYPAL_MODE=mock npm start          # no keys needed, PayPal calls are simulated
open http://localhost:3000          # store; /dashboard.html for the owner
npm test                            # end-to-end flows in mock mode
```

For the sandbox, copy `.env.example` to `.env` and fill in the sandbox app keys,
the webhook id and the three supplier sandbox accounts.

## Stack

Node 22 (built-in SQLite), Express, PayPal REST APIs (Orders v2, Payouts, order
tracking, webhooks), AG Grid Community, any OpenAI-compatible model endpoint.

## License

MIT
