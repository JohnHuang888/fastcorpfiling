# Turning on "Click Pay" checkout (about 15 minutes)

How it works: the customer fills in the order form and clicks **Continue to Secure Payment**.
The site saves the order to Formspree (you still get the order email, now with an order number
like `FCF-261114-A1B2C3`), then sends the customer to a Stripe checkout page for the full total:
service fees + state filing fee + rush fee. After paying they land on `success.html`.

The small program in this folder (`worker.js`) runs for free on Cloudflare. It holds your Stripe
secret key (which must never be on the website) and re-calculates the price from `pricing.json`,
so nobody can change the price in their browser.

## 1. Get your Stripe secret key
1. Log in to https://dashboard.stripe.com.
2. Turn on **Test mode** (top right) for now.
3. Go to **Developers → API keys** and copy the **Secret key** (starts with `sk_test_`).

## 2. Create the Cloudflare Worker
1. Sign up / log in at https://dash.cloudflare.com (free plan is fine).
2. Go to **Workers & Pages → Create → Create Worker**. Name it `fastcorpfiling-checkout`, click **Deploy**.
3. Click **Edit code**, delete everything, paste the whole contents of `worker.js`, click **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets** and add:

   | Type   | Name                | Value |
   |--------|---------------------|-------|
   | Text   | `SITE_URL`          | `https://fastcorpfiling.com` |
   | Text   | `ALLOWED_ORIGINS`   | `https://fastcorpfiling.com,https://www.fastcorpfiling.com` |
   | Secret | `STRIPE_SECRET_KEY` | your `sk_test_...` key |

5. Copy the Worker's address, shown at the top, e.g. `https://fastcorpfiling-checkout.yourname.workers.dev`.

(Developers can instead run `npx wrangler deploy` in this folder and
`npx wrangler secret put STRIPE_SECRET_KEY`.)

## 3. Connect the website to the Worker
In **both** `index.html` and `success.html`, find this line:

```js
const CHECKOUT_API = '';
```

and put the Worker address between the quotes:

```js
const CHECKOUT_API = 'https://fastcorpfiling-checkout.yourname.workers.dev';
```

Commit to `main`; GitHub Pages republishes the site in a minute or two.
Until `CHECKOUT_API` is filled in, the site keeps working the old way (order is saved and the
customer is told you'll email a payment link).

## 4. Test, then go live
1. On the live site, place an order and pay with Stripe's test card `4242 4242 4242 4242`,
   any future date, any CVC, any ZIP.
2. Check: you got the Formspree email, the payment appears in Stripe (search the order number),
   and you landed on the "Payment Received" page.
3. Turn off Test mode in Stripe, copy the **live** secret key (`sk_live_...`) and replace
   `STRIPE_SECRET_KEY` in the Worker settings. Done.

Recommended Stripe settings: **Settings → Customer emails** → turn on "Successful payments"
(customer receipts), and make sure your own payment notification emails are on.

## Changing prices
Edit `pricing.json` in this repo. Service fees, rush fees and every state's fee live there.
`null` means the fee varies (by shares, revenue or members) and is not charged at checkout;
the customer sees "billed separately" and you invoice it after confirming.
The state fees were compiled from public 2026 fee tables on 2026-11-14. **Spot-check them
against the Secretary of State websites for the states you file in most**, and update them when
states change fees. Newspaper publication costs (NY, AZ, NE) and state rush fees are not included.

## If a customer cancels on the Stripe page
They return to the order form with a notice that they were not charged. You'll still have
their Formspree order (with no matching Stripe payment), so you can follow up by email.
