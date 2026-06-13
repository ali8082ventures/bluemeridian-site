/**
 * Blue Meridian — HubSpot setup script (v2, includes Ambassador Programme)
 *
 * Creates every custom property Blue Meridian needs on Contacts and Deals.
 * Safe to run more than once: properties that already exist are skipped.
 *
 * Run on the server with:   node --env-file=.env setup-hubspot.js
 * Requires .env containing: HUBSPOT_TOKEN=your-private-app-token
 * (Never put the token in this file or in GitHub.)
 */

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: HUBSPOT_TOKEN is missing. Create a .env file next to this script.');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';

async function hs(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  return { status: res.status, json, text };
}

const GROUP_NAME = 'blue_meridian';

async function ensureGroup(objectType) {
  const r = await hs(`/crm/v3/properties/${objectType}/groups`, 'POST', {
    name: GROUP_NAME,
    label: 'Blue Meridian',
    displayOrder: -1,
  });
  if (r.status === 201) console.log(`  [group] created "Blue Meridian" group on ${objectType}`);
  else if (r.status === 409) console.log(`  [group] already exists on ${objectType} — fine`);
  else console.log(`  [group] unexpected response on ${objectType}: ${r.status} ${r.text.slice(0, 200)}`);
}

function text(name, label, opts = {}) {
  return { name, label, type: 'string', fieldType: 'text', groupName: GROUP_NAME, ...opts };
}
function textarea(name, label) {
  return { name, label, type: 'string', fieldType: 'textarea', groupName: GROUP_NAME };
}
function number(name, label) {
  return { name, label, type: 'number', fieldType: 'number', groupName: GROUP_NAME };
}
function datetime(name, label) {
  return { name, label, type: 'datetime', fieldType: 'date', groupName: GROUP_NAME };
}
function bool(name, label) {
  return {
    name, label, type: 'enumeration', fieldType: 'booleancheckbox', groupName: GROUP_NAME,
    options: [
      { label: 'Yes', value: 'true' },
      { label: 'No', value: 'false' },
    ],
  };
}
function select(name, label, values) {
  return {
    name, label, type: 'enumeration', fieldType: 'select', groupName: GROUP_NAME,
    options: values.map((v) => ({ label: v.label, value: v.value })),
  };
}

/* ------------------------- CONTACT PROPERTIES ------------------------- */
const contactProps = [
  // Core (from Backend Part 1)
  select('bm_lead_source', 'BM — Lead source', [
    { label: 'Website enquiry', value: 'website_enquiry' },
    { label: 'AI search', value: 'ai_search' },
    { label: 'Ambassador referral', value: 'ambassador_referral' },
    { label: 'Ambassador application', value: 'ambassador_application' },
    { label: 'Paid ads', value: 'paid_ads' },
    { label: 'Direct / other', value: 'direct' },
  ]),
  select('bm_charter_tier_interest', 'BM — Charter tier interest', [
    { label: 'Bookable yachts', value: 'bookable' },
    { label: 'Superyachts (on request)', value: 'superyacht' },
    { label: 'Both / undecided', value: 'both' },
  ]),

  // Ambassador programme
  select('bm_ambassador_status', 'BM — Ambassador status', [
    { label: 'Applied', value: 'applied' },
    { label: 'Active', value: 'active' },
    { label: 'Paused', value: 'paused' },
    { label: 'Declined', value: 'declined' },
  ]),
  bool('bm_is_ambassador', 'BM — Is an active ambassador'),
  text('bm_ambassador_own_code', 'BM — Ambassador: their own referral code'),
  text('bm_ambassador_country', 'BM — Ambassador: country (ISO code)'),
  text('bm_ambassador_code', 'BM — Referred by ambassador (code)'),
  text('bm_recruited_by', 'BM — Ambassador recruited by (code)'),
  text('bm_ambassador_social', 'BM — Ambassador: social / website'),
  textarea('bm_ambassador_about', 'BM — Ambassador: about their network'),
];

/* --------------------------- DEAL PROPERTIES --------------------------- */
const dealProps = [
  // Core (from Backend Part 1)
  text('bm_destination', 'BM — Destination'),
  text('bm_travel_dates', 'BM — Travel dates'),
  number('bm_guests', 'BM — Guests'),
  text('bm_yacht_type', 'BM — Yacht type'),
  text('bm_budget_guide', 'BM — Budget guide'),
  select('bm_charter_tier', 'BM — Charter tier', [
    { label: 'Bookable yacht', value: 'bookable' },
    { label: 'Superyacht (on request)', value: 'superyacht' },
  ]),
  textarea('bm_yachts_of_interest', 'BM — Yachts of interest'),
  textarea('bm_brief', 'BM — Client brief'),

  // Ambassador programme
  text('bm_ambassador_code', 'BM — Ambassador code (who referred this deal)'),
  number('bm_deal_profit', 'BM — Blue Meridian profit on this deal'),

  // Dashboard admin: enquiry housekeeping
  bool('bm_admin_archived', 'BM — Enquiry archived (parked from dashboard)'),
  datetime('bm_last_touched', 'BM — Enquiry last refreshed (freshness clock)'),
];

async function createProps(objectType, props) {
  console.log(`\nSetting up ${objectType} properties…`);
  await ensureGroup(objectType);
  for (const p of props) {
    const r = await hs(`/crm/v3/properties/${objectType}`, 'POST', p);
    if (r.status === 201) console.log(`  [ok]      created ${p.name}`);
    else if (r.status === 409) console.log(`  [skip]    ${p.name} already exists`);
    else console.log(`  [PROBLEM] ${p.name}: ${r.status} ${r.text.slice(0, 200)}`);
  }
}

(async () => {
  console.log('Blue Meridian — HubSpot setup starting…');
  const ping = await hs('/crm/v3/properties/contacts?limit=1');
  if (ping.status === 401) {
    console.error('\nERROR: HubSpot rejected the token (401). Check HUBSPOT_TOKEN in .env.');
    process.exit(1);
  }
  await createProps('contacts', contactProps);
  await createProps('deals', dealProps);
  console.log('\nDone. Open HubSpot → Settings → Properties and you should see a "Blue Meridian" group on both Contacts and Deals.');
})();
