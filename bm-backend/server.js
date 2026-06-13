/**
 * Blue Meridian — Backend service (Ambassador Programme + Admin Dashboard API)
 *
 * Endpoints:
 *   POST /api/ambassador/apply      — public: application form on ambassador.bluemeridian.ai
 *   POST /api/enquiry               — public: client enquiries (carries ?ref attribution)
 *   GET  /api/admin/summary         — admin: everything the dashboard needs (auth required)
 *   POST /api/admin/activate        — admin: turn an applicant into an active ambassador
 *   GET  /admin                     — serves the dashboard page
 *   GET  /health                    — quick "is it running" check
 *
 * Run with:  node --env-file=.env server.js   (or via pm2, see deploy guide)
 * .env needs: HUBSPOT_TOKEN=...   ADMIN_KEY=...   PORT=3001
 */

const express = require('express');
const path = require('path');

const TOKEN = process.env.HUBSPOT_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PORT = process.env.PORT || 3001;

if (!TOKEN || !ADMIN_KEY) {
  console.error('ERROR: HUBSPOT_TOKEN and ADMIN_KEY must be set in .env');
  process.exit(1);
}

const app = express();
app.use(express.json());

/* ----------------------------- CORS ----------------------------- */
const ALLOWED_ORIGINS = [
  'https://bluemeridian.ai',
  'https://www.bluemeridian.ai',
  'https://ambassador.bluemeridian.ai',
  'https://staging.bluemeridian.ai',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------- HubSpot helper ------------------------ */
const HS = 'https://api.hubapi.com';
async function hs(pathname, method = 'GET', body) {
  const res = await fetch(HS + pathname, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function findContactByEmail(email) {
  const r = await hs('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  });
  return r.json?.results?.[0] || null;
}

async function searchAll(objectType, filters, properties) {
  // Pages through HubSpot search results (100 per page).
  const out = [];
  let after;
  for (let page = 0; page < 50; page++) {
    const body = { filterGroups: [{ filters }], properties, limit: 100 };
    if (after) body.after = after;
    const r = await hs(`/crm/v3/objects/${objectType}/search`, 'POST', body);
    if (r.status !== 200) break;
    out.push(...(r.json.results || []));
    after = r.json.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* ================================================================ */
/*  PUBLIC: ambassador application                                   */
/* ================================================================ */
app.post('/api/ambassador/apply', async (req, res) => {
  try {
    const b = req.body || {};
    const email = clean(b.email, 200).toLowerCase();
    const firstName = clean(b.firstName, 100);
    const lastName = clean(b.lastName, 100);
    if (!validEmail(email) || !firstName || !lastName) {
      return res.status(400).json({ ok: false, error: 'Please provide a first name, last name and a valid email.' });
    }
    const properties = {
      email,
      firstname: firstName,
      lastname: lastName,
      city: clean(b.city, 120),
      bm_lead_source: 'ambassador_application',
      bm_ambassador_status: 'applied',
      bm_ambassador_social: clean(b.social, 300),
      bm_ambassador_about: clean(b.about, 3000),
    };
    if (b.recruitedBy) properties.bm_recruited_by = clean(b.recruitedBy, 40).toUpperCase();

    const existing = await findContactByEmail(email);
    const r = existing
      ? await hs(`/crm/v3/objects/contacts/${existing.id}`, 'PATCH', { properties })
      : await hs('/crm/v3/objects/contacts', 'POST', { properties });

    if (r.status >= 300) {
      console.error('apply failed', r.status, JSON.stringify(r.json).slice(0, 300));
      return res.status(502).json({ ok: false, error: 'Could not save your application. Please try again.' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('apply error', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

/* ================================================================ */
/*  PUBLIC: client enquiry (used when the main site is wired up)     */
/* ================================================================ */
app.post('/api/enquiry', async (req, res) => {
  try {
    const b = req.body || {};
    const email = clean(b.email, 200).toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'A valid email is required.' });

    const ref = b.ref ? clean(b.ref, 40).toUpperCase() : '';
    const contactProps = {
      email,
      firstname: clean(b.firstName, 100),
      lastname: clean(b.lastName, 100),
      bm_lead_source: ref ? 'ambassador_referral' : 'website_enquiry',
    };
    if (ref) contactProps.bm_ambassador_code = ref;

    const existing = await findContactByEmail(email);
    const cRes = existing
      ? await hs(`/crm/v3/objects/contacts/${existing.id}`, 'PATCH', { properties: contactProps })
      : await hs('/crm/v3/objects/contacts', 'POST', { properties: contactProps });
    const contactId = existing?.id || cRes.json?.id;

    const dealProps = {
      dealname: `Charter enquiry — ${contactProps.firstname || email}`,
      dealstage: 'appointmentscheduled',
      bm_brief: clean(b.brief, 5000),
      bm_destination: clean(b.destination, 200),
      bm_travel_dates: clean(b.dates, 200),
    };
    if (ref) dealProps.bm_ambassador_code = ref;

    const dRes = await hs('/crm/v3/objects/deals', 'POST', {
      properties: dealProps,
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
      }] : [],
    });
    if (dRes.status >= 300) console.error('deal create failed', dRes.status);
    res.json({ ok: true });
  } catch (e) {
    console.error('enquiry error', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

/* ================================================================ */
/*  ADMIN                                                            */
/* ================================================================ */
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'Wrong admin key.' });
  }
  next();
}

/* ----- Commission rules (single source of truth) ----- */
const TIERS = [
  { name: 'Commodore', min: 100000, rate: 0.15 },
  { name: 'Captain', min: 75000, rate: 0.125 },
  { name: 'Navigator', min: 0, rate: 0.10 },
];
const OVERRIDE_RATE = 0.01;
const tierFor = (revenue12m) => TIERS.find((t) => revenue12m >= t.min);

app.get('/api/admin/summary', requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const yearAgo = now - 365 * 24 * 3600 * 1000;

    // 1) All deals (any stage) with the properties we need.
    const deals = await searchAll(
      'deals',
      [{ propertyName: 'createdate', operator: 'GTE', value: String(now - 3 * 365 * 24 * 3600 * 1000) }],
      ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'bm_ambassador_code', 'bm_deal_profit', 'bm_destination']
    );

    // 2) Ambassador contacts + applicants.
    const ambassadors = await searchAll(
      'contacts',
      [{ propertyName: 'bm_is_ambassador', operator: 'EQ', value: 'true' }],
      ['firstname', 'lastname', 'email', 'bm_ambassador_own_code', 'bm_recruited_by', 'bm_ambassador_status']
    );
    const applicants = await searchAll(
      'contacts',
      [{ propertyName: 'bm_ambassador_status', operator: 'EQ', value: 'applied' }],
      ['firstname', 'lastname', 'email', 'city', 'bm_ambassador_social', 'bm_ambassador_about', 'bm_recruited_by', 'createdate']
    );

    const won = deals.filter((d) => (d.properties.dealstage || '').toLowerCase().includes('closedwon'));
    const num = (v) => (v ? parseFloat(v) || 0 : 0);
    const within12m = (d) => d.properties.closedate && new Date(d.properties.closedate).getTime() >= yearAgo;

    /* ----- Platform totals + by source + monthly series ----- */
    const won12 = won.filter(within12m);
    const totals = {
      revenue12m: won12.reduce((s, d) => s + num(d.properties.amount), 0),
      profit12m: won12.reduce((s, d) => s + num(d.properties.bm_deal_profit), 0),
      dealsWon12m: won12.length,
      openDeals: deals.filter((d) => !/closed/.test((d.properties.dealstage || '').toLowerCase())).length,
      activeAmbassadors: ambassadors.length,
      pendingApplications: applicants.length,
    };

    const bySource = {};
    for (const d of won12) {
      const src = d.properties.bm_ambassador_code ? 'Ambassador' : 'Direct / website';
      bySource[src] = bySource[src] || { revenue: 0, profit: 0, deals: 0 };
      bySource[src].revenue += num(d.properties.amount);
      bySource[src].profit += num(d.properties.bm_deal_profit);
      bySource[src].deals += 1;
    }

    const monthly = {};
    for (const d of won12) {
      const m = (d.properties.closedate || '').slice(0, 7); // YYYY-MM
      monthly[m] = monthly[m] || { revenue: 0, profit: 0, deals: 0 };
      monthly[m].revenue += num(d.properties.amount);
      monthly[m].profit += num(d.properties.bm_deal_profit);
      monthly[m].deals += 1;
    }

    /* ----- Per-ambassador maths ----- */
    const byCode = {};
    for (const d of won) {
      const code = (d.properties.bm_ambassador_code || '').toUpperCase();
      if (!code) continue;
      (byCode[code] = byCode[code] || []).push(d);
    }

    const ambRows = ambassadors.map((a) => {
      const p = a.properties;
      const code = (p.bm_ambassador_own_code || '').toUpperCase();
      const myDeals = byCode[code] || [];
      const my12 = myDeals.filter(within12m);
      const revenue12m = my12.reduce((s, d) => s + num(d.properties.amount), 0);
      const profit12m = my12.reduce((s, d) => s + num(d.properties.bm_deal_profit), 0);
      const tier = tierFor(revenue12m);
      const commission12m = profit12m * tier.rate;
      return {
        contactId: a.id,
        name: `${p.firstname || ''} ${p.lastname || ''}`.trim() || p.email,
        email: p.email,
        code,
        recruitedBy: (p.bm_recruited_by || '').toUpperCase() || null,
        revenue12m, profit12m,
        tier: tier.name, rate: tier.rate,
        commission12m,
        deals12m: my12.length,
        dealsMissingProfit: my12.filter((d) => !num(d.properties.bm_deal_profit)).length,
      };
    });

    // Overrides: 1% of profit generated by ambassadors this person recruited.
    for (const row of ambRows) {
      const recruits = ambRows.filter((r) => r.recruitedBy && r.recruitedBy === row.code);
      row.recruitCount = recruits.length;
      row.override12m = recruits.reduce((s, r) => s + r.profit12m, 0) * OVERRIDE_RATE;
      row.totalOwed12m = row.commission12m + row.override12m;
    }

    /* ----- Data-quality flag: won deals with no profit recorded ----- */
    const missingProfit = won12
      .filter((d) => !num(d.properties.bm_deal_profit))
      .map((d) => ({ id: d.id, name: d.properties.dealname, amount: num(d.properties.amount), closedate: d.properties.closedate }));

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      totals, bySource, monthly,
      ambassadors: ambRows.sort((x, y) => y.revenue12m - x.revenue12m),
      applicants: applicants.map((a) => ({
        contactId: a.id,
        name: `${a.properties.firstname || ''} ${a.properties.lastname || ''}`.trim(),
        email: a.properties.email,
        city: a.properties.city,
        social: a.properties.bm_ambassador_social,
        about: a.properties.bm_ambassador_about,
        recruitedBy: a.properties.bm_recruited_by || null,
        applied: a.properties.createdate,
      })),
      missingProfit,
      rules: { tiers: TIERS, overrideRate: OVERRIDE_RATE },
    });
  } catch (e) {
    console.error('summary error', e);
    res.status(500).json({ ok: false, error: 'Could not build the summary.' });
  }
});

/* ----- Activate an applicant: give them their code ----- */
app.post('/api/admin/activate', requireAdmin, async (req, res) => {
  try {
    const email = clean(req.body?.email, 200).toLowerCase();
    const code = clean(req.body?.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!validEmail(email) || code.length < 3) {
      return res.status(400).json({ ok: false, error: 'Need an email and a code of at least 3 letters/numbers.' });
    }
    // Code must be unique among ambassadors.
    const clash = await searchAll('contacts',
      [{ propertyName: 'bm_ambassador_own_code', operator: 'EQ', value: code }],
      ['email']);
    if (clash.length && clash[0].properties.email !== email) {
      return res.status(409).json({ ok: false, error: `Code ${code} is already taken.` });
    }
    const contact = await findContactByEmail(email);
    if (!contact) return res.status(404).json({ ok: false, error: 'No contact with that email.' });

    const r = await hs(`/crm/v3/objects/contacts/${contact.id}`, 'PATCH', {
      properties: {
        bm_is_ambassador: 'true',
        bm_ambassador_status: 'active',
        bm_ambassador_own_code: code,
      },
    });
    if (r.status >= 300) return res.status(502).json({ ok: false, error: 'HubSpot update failed.' });
    res.json({ ok: true, code, link: `https://bluemeridian.ai/?ref=${code}` });
  } catch (e) {
    console.error('activate error', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

/* ----- Dashboard page + health ----- */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/health', (req, res) => res.json({ ok: true, service: 'bm-backend' }));

app.listen(PORT, '127.0.0.1', () => console.log(`Blue Meridian backend listening on 127.0.0.1:${PORT}`));
