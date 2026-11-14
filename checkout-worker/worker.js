// FastCorpFiling checkout API — a Cloudflare Worker.
// POST /create-checkout  -> creates a Stripe Checkout Session, returns { url }
// GET  /session?id=cs_…  -> minimal payment status for the success page

const STRIPE_API = "https://api.stripe.com/v1";
const SERVICES = ["llc", "corp", "ein", "annual"];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type" }
      : {};
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments are not configured yet." }, 503);

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/create-checkout") {
        if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403);
        return json(await createCheckout(await request.json(), env, ctx));
      }
      if (request.method === "GET" && url.pathname === "/session") {
        return json(await getSession(url.searchParams.get("id"), env));
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      const status = err.status || 400;
      if (status >= 500) console.error(err);
      return json({ error: err.message || "Something went wrong" }, status);
    }
  },
};

// ── Pricing (same rules as the order form on the website) ──
function stateFeeKey(serviceId, entityType) {
  const et = String(entityType || "").toLowerCase();
  const isNonprofit = et.includes("nonprofit");
  const isLlc = et.includes("llc") || et.includes("limited liability");
  if (serviceId === "llc") return "llc";
  if (serviceId === "corp") return isNonprofit ? "nonprofit" : "corp";
  if (serviceId === "annual") return isNonprofit ? null : isLlc ? "annualLlc" : "annualCorp";
  return null; // ein: no state fee
}

function computeOrder(pricing, { services, speed, entityType, state }) {
  const lines = [];   // charged now: { label, cents }
  const pending = []; // state fees we can't price automatically
  const fees = pricing.stateFees[state];
  if (!fees) throw new Error("Unknown state");
  const seen = new Set();
  for (const id of services) {
    const svc = pricing.services[id];
    if (!svc || seen.has(id)) throw new Error("Invalid service");
    seen.add(id);
    lines.push({ label: svc.label, cents: Math.round(svc.price * 100) });
    if (id === "ein") continue;
    const key = stateFeeKey(id, entityType);
    const fee = key ? fees[key] : null;
    const feeLabel = `${state} state fee – ${svc.label}`;
    if (typeof fee === "number") {
      if (fee > 0) lines.push({ label: feeLabel, cents: Math.round(fee * 100) });
    } else {
      pending.push(feeLabel);
    }
  }
  if (!lines.length) throw new Error("No services selected");
  const sp = pricing.speed[speed];
  if (!sp) throw new Error("Invalid processing speed");
  if (sp.price > 0) lines.push({ label: sp.label, cents: Math.round(sp.price * 100) });
  const totalCents = lines.reduce((s, l) => s + l.cents, 0);
  return { lines, pending, totalCents };
}

function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

async function loadPricing(env, ctx) {
  const src = `${env.SITE_URL.replace(/\/$/, "")}/pricing.json`;
  const res = await fetch(src, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw fail("Pricing is temporarily unavailable.", 503);
  return res.json();
}

async function stripe(env, path, params, method = "POST") {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Stripe error", res.status, data?.error?.message);
    throw fail("Could not start checkout. Please try again or email support@fastcorpfiling.com.", 502);
  }
  return data;
}

async function createCheckout(body, env, ctx) {
  const services = Array.isArray(body.services) ? body.services.map(String) : [];
  if (!services.length || services.some(s => !SERVICES.includes(s))) throw fail("Please select at least one valid service.");
  const email = clean(body.email, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail("Please enter a valid email address.");
  const orderRef = clean(body.orderRef, 40);
  if (!/^FCF-[A-Z0-9-]{4,30}$/.test(orderRef)) throw fail("Invalid order reference.");

  const pricing = await loadPricing(env, ctx);
  const order = computeOrder(pricing, {
    services, speed: clean(body.speed, 20), entityType: clean(body.entityType, 60), state: clean(body.state, 40),
  });

  const site = env.SITE_URL.replace(/\/$/, "");
  const p = {
    mode: "checkout",
    customer_email: email,
    client_reference_id: orderRef,
    success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/?checkout=canceled#order`,
    "payment_intent_data[description]": `FastCorpFiling order ${orderRef}`,
    "payment_intent_data[metadata][order_ref]": orderRef,
    "metadata[order_ref]": orderRef,
    "metadata[business_name]": clean(body.bizName, 200),
    "metadata[state]": clean(body.state, 40),
    "metadata[entity_type]": clean(body.entityType, 60),
    "metadata[services]": services.join(", "),
    "metadata[speed]": clean(body.speed, 20),
    "metadata[customer_name]": clean(`${clean(body.firstName, 80)} ${clean(body.lastName, 80)}`, 160),
    "metadata[phone]": clean(body.phone, 40),
    "metadata[state_fees_billed_separately]": order.pending.join("; ").slice(0, 490) || "none",
  };
  if (order.pending.length) {
    p["custom_text[submit][message]"] =
      "Some state fees vary and are not included here. We'll confirm them and bill separately before filing.";
  }
  order.lines.forEach((l, i) => {
    p[`line_items[${i}][quantity]`] = "1";
    p[`line_items[${i}][price_data][currency]`] = "usd";
    p[`line_items[${i}][price_data][unit_amount]`] = String(l.cents);
    p[`line_items[${i}][price_data][product_data][name]`] = l.label;
  });

  const session = await stripe(env, "/checkout/sessions", p);
  return { url: session.url, totalCents: order.totalCents, pending: order.pending };
}

async function getSession(id, env) {
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id || "")) throw fail("Invalid session id.");
  const s = await stripe(env, `/checkout/sessions/${encodeURIComponent(id)}`, null, "GET");
  return {
    paid: s.payment_status === "paid",
    amountTotal: s.amount_total,
    orderRef: s.client_reference_id || null,
  };
}
