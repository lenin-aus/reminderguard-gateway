// Defines which client_config fields must be filled in before a self-serve
// client is considered fully onboarded. Used to:
//   1. Decide whether a self-serve OAuth callback routes to the Setup Wizard
//      or straight to the Dashboard.
//   2. Gate the /trigger/nightly-report/:clientId route so an incomplete
//      client can't fire a report run no matter how the endpoint is called.
//
// CONFIRM before deploying: these column names are a best guess based on
// what's been visible in the Appsmith Configure page. Check them against the
// real client_config schema (e.g. via \d client_config in psql) and correct
// this list if any name is wrong — a wrong name here will silently make
// isConfigComplete() always return false for that field.
// super_payment_mode is deliberately NOT in this list — it's system-generated
// (Gateway sets it to 'payday' for every new client at signup, since quarterly
// mode is no longer relevant post-July), so it's never null and never asked.
const MANDATORY_FIELDS = ['report_email', 'fortnightly_wages_bill', 'fortnightly_super_liability', 'payday_day', 'last_payday_date'];
// last_payday_date is a stopgap (Path A) — manual entry until the PayRuns API
// auto-fetch (Path B) is built. Revisit removing this once that's live.

function isConfigComplete(config) {
  if (!config) return false;
  return MANDATORY_FIELDS.every(
    (field) => config[field] !== null && config[field] !== undefined && config[field] !== ''
  );
}

module.exports = { isConfigComplete, MANDATORY_FIELDS };
