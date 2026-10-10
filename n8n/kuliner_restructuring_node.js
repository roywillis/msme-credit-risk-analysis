// ==============================================================================
// DYNAMIC CULINARY (KULINER) RESTRUCTURING
// Runs after the underwriting node. Caps long Kuliner tenors, then re-derives
// DTI, PD, status and loan size for the restructured rows only. All other rows
// pass through unchanged.
// Decision and sizing rules mirror the underwriting node - keep them in sync.
// ==============================================================================

// ==============================================================================
// 1. DYNAMIC CONFIG & STANDARDIZED LOAN TIER ENUMS
// ==============================================================================
const configRows = $('Get row(s)').all().map(r => r.json);
const dynamicConfig = Object.fromEntries(
  configRows
    .filter(row => row.key && row.value !== '' && row.value != null)   // blank cell -> use default, not 0
    .map(row => [String(row.key).trim(), isNaN(Number(row.value)) ? row.value : Number(row.value)])
);

const LOAN_TIER_ENUM = {
  TIER_0_NONE:       { key: 'TIER_0_NONE',       amount: 0,           label: 'Rp 0 (Declined)' },
  TIER_1_MICRO_10M:  { key: 'TIER_1_MICRO_10M',  amount: 10_000_000,  label: 'Rp 10,000,000' },
  TIER_2_MICRO_25M:  { key: 'TIER_2_MICRO_25M',  amount: 25_000_000,  label: 'Rp 25,000,000' },
  TIER_3_MIKRO_50M:  { key: 'TIER_3_MIKRO_50M',  amount: 50_000_000,  label: 'Rp 50,000,000' },
  TIER_4_SMALL_100M: { key: 'TIER_4_SMALL_100M', amount: 100_000_000, label: 'Rp 100,000,000' },
  TIER_5_SMALL_250M: { key: 'TIER_5_SMALL_250M', amount: 250_000_000, label: 'Rp 250,000,000' },
  TIER_6_SMALL_500M: { key: 'TIER_6_SMALL_500M', amount: 500_000_000, label: 'Rp 500,000,000' },
};

const CONFIG = {
  limits: {
    max_exposure_idr: dynamicConfig.max_exposure_idr ?? 500_000_000,
    max_dti_ratio: dynamicConfig.max_dti_ratio ?? 0.40,
    max_acceptable_pd: dynamicConfig.max_acceptable_pd ?? 0.20,
    auto_approve_pd_threshold: dynamicConfig.auto_approve_pd_threshold ?? 0.05,
    monthly_flat_rate: dynamicConfig.monthly_flat_rate ?? 0.015,
    high_dti_threshold: dynamicConfig.high_dti_threshold ?? 0.30,
    high_dti_multiplier: dynamicConfig.high_dti_multiplier ?? 1.25,
    low_dti_threshold: dynamicConfig.low_dti_threshold ?? 0.20,
    low_dti_multiplier: dynamicConfig.low_dti_multiplier ?? 0.60,
    borderline_haircut: dynamicConfig.borderline_haircut ?? 0.70,
  },
  culinary: {
    max_tenor_months: dynamicConfig.max_tenor_months_culinary ?? 12,
    restructured_tenor_months: dynamicConfig.restructured_tenor_months_culinary ?? 12,
    pd_discount_multiplier: dynamicConfig.pd_discount_multiplier_culinary ?? 0.65,
  },
};

// ==============================================================================
// 2. HELPER FUNCTIONS
// ==============================================================================
const toNum = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
const slug = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_');
const fmtIdr = n => (n == null ? '-' : Math.round(n).toLocaleString('id-ID'));
const fmtPct = (r, d = 1) => (r == null ? '-' : `${(r * 100).toFixed(d)}%`);

// Flat-rate monthly installment
const installmentFor = (principal, tenor) =>
  tenor > 0 ? principal / tenor + principal * CONFIG.limits.monthly_flat_rate : 0;

// Maps a capacity to the highest qualifying discrete tier (rounds down)
function quantizeToLoanTier(affordableCapacity) {
  const sortedTiers = Object.values(LOAN_TIER_ENUM)
    .filter(t => t.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  for (const tier of sortedTiers) {
    if (affordableCapacity >= tier.amount) {
      return tier;
    }
  }
  return LOAN_TIER_ENUM.TIER_0_NONE;
}

// ==============================================================================
// 3. RESTRUCTURE ELIGIBLE KULINER ROWS
// ==============================================================================
return $input.all().map(entry => {
  const item = {
    ...entry.json,
    flags: { ...(entry.json.flags ?? {}) },
    scoring: { ...(entry.json.scoring ?? {}) },
    terms: { ...(entry.json.terms ?? {}) },
  };

  const original_tenor = toNum(item.terms.original_tenor_months) ?? toNum(item.effective_tenor_months) ?? 0;

  // Only complete, income-eligible Kuliner applications with a long tenor.
  // Skipping rows already restructured keeps a re-run from discounting PD twice.
  const eligible =
    slug(item.business_type) === 'kuliner' &&
    original_tenor > CONFIG.culinary.max_tenor_months &&
    item.application_status !== 'PENDING_DOCUMENTS' &&
    !item.flags.below_min_income &&
    !item.terms.is_restructured;

  if (!eligible) return { json: item };

  const monthly_income = toNum(item.monthly_income_idr);
  const requested_amount = toNum(item.requested_loan_amount_idr);
  const effective_tenor = CONFIG.culinary.restructured_tenor_months;

  // Snapshot of the requested-terms result, for the audit trail
  const before = {
    tenor_months: original_tenor,
    pd_score: item.pd_score,
    dti_at_application: item.flags.dti_at_application,
    loan_amount_granted: item.loan_amount_granted,
    application_status: item.application_status,
  };

  // DTI on the capped tenor (shorter tenor -> higher installment)
  const dti_at_application = installmentFor(requested_amount, effective_tenor) / monthly_income;
  const is_high_dti = dti_at_application > CONFIG.limits.high_dti_threshold;

  // PD = sector baseline x regional x DTI (penalty when high, discount when low) x tenor-cap discount
  const base_pd = toNum(item.scoring.base_pd) ?? 0.12;
  const regional_multiplier = toNum(item.scoring.regional_multiplier) ?? 1.0;
  const is_low_dti = dti_at_application <= CONFIG.limits.low_dti_threshold;
  const dti_multiplier = is_high_dti ? CONFIG.limits.high_dti_multiplier
    : is_low_dti ? CONFIG.limits.low_dti_multiplier
    : 1.0;
  const tenor_multiplier = CONFIG.culinary.pd_discount_multiplier;

  const pd_factors = [`${item.business_type} ${fmtPct(base_pd)}`];
  if (regional_multiplier !== 1.0) pd_factors.push(`${item.province} ${regional_multiplier}`);
  if (is_high_dti) pd_factors.push(`DTI>${fmtPct(CONFIG.limits.high_dti_threshold, 0)} ${dti_multiplier}`);
  if (is_low_dti) pd_factors.push(`DTI<=${fmtPct(CONFIG.limits.low_dti_threshold, 0)} ${dti_multiplier}`);
  pd_factors.push(`tenor cap ${original_tenor}->${effective_tenor}m ${tenor_multiplier}`);

  let calculated_pd = base_pd * regional_multiplier * dti_multiplier * tenor_multiplier;
  calculated_pd = Math.min(Math.max(calculated_pd, 0.01), 0.99);
  const pd_percentage = fmtPct(calculated_pd, 2);

  // Status (guardrail and income checks already passed in the underwriting node)
  let application_status = '';
  let status_summary = '';

  if (calculated_pd > CONFIG.limits.max_acceptable_pd) {
    application_status = 'DECLINED_AUTO';
    status_summary = `PD above ${fmtPct(CONFIG.limits.max_acceptable_pd)} limit`;
  } else if (calculated_pd < CONFIG.limits.auto_approve_pd_threshold && dti_at_application <= CONFIG.limits.max_dti_ratio) {
    application_status = 'APPROVED_AUTO';
    status_summary = `PD below ${fmtPct(CONFIG.limits.auto_approve_pd_threshold)}, DTI within ${fmtPct(CONFIG.limits.max_dti_ratio)}`;
  } else {
    application_status = 'BORDERLINE_HITL';
    status_summary = `PD ${fmtPct(CONFIG.limits.auto_approve_pd_threshold)}-${fmtPct(CONFIG.limits.max_acceptable_pd)}, needs underwriter review`;
  }

  // Sizing on the capped tenor
  const max_allowable_installment = monthly_income * CONFIG.limits.max_dti_ratio;
  const theoretical_principal_capacity = max_allowable_installment / (1 / effective_tenor + CONFIG.limits.monthly_flat_rate);
  const max_sanctionable_capacity = Math.min(theoretical_principal_capacity, CONFIG.limits.max_exposure_idr);

  let grantedTier = LOAN_TIER_ENUM.TIER_0_NONE;

  if (application_status === 'APPROVED_AUTO') {
    grantedTier = quantizeToLoanTier(Math.min(max_sanctionable_capacity, requested_amount));
  } else if (application_status === 'BORDERLINE_HITL') {
    grantedTier = quantizeToLoanTier(Math.min(max_sanctionable_capacity * CONFIG.limits.borderline_haircut, requested_amount));
  }

  if ((application_status === 'APPROVED_AUTO' || application_status === 'BORDERLINE_HITL') && grantedTier.amount === 0) {
    application_status = 'DECLINED_AUTO';
    status_summary = `Affordable amount below Rp ${fmtIdr(LOAN_TIER_ENUM.TIER_1_MICRO_10M.amount)} minimum tier`;
  }

  const granted_amount_idr = grantedTier.amount;
  const granted_monthly_installment = installmentFor(granted_amount_idr, effective_tenor);
  const final_dti_ratio = granted_monthly_installment / monthly_income;
  const is_counter_offer = granted_amount_idr > 0 && granted_amount_idr < requested_amount;

  const restructuring_reason =
    `Kuliner tenor capped ${original_tenor}m -> ${effective_tenor}m: ` +
    `PD ${before.pd_score} -> ${pd_percentage}, ` +
    `DTI ${fmtPct(before.dti_at_application)} -> ${fmtPct(dti_at_application)}, ` +
    `offer Rp ${fmtIdr(before.loan_amount_granted)} -> Rp ${fmtIdr(granted_amount_idr)}`;

  // Same 4-line format as the underwriting node
  const decision_notes = [
    `${application_status} | PD ${pd_percentage} | DTI ${fmtPct(dti_at_application)}`,
    status_summary,
    granted_amount_idr > 0
      ? `Offer Rp ${fmtIdr(granted_amount_idr)} ${is_counter_offer ? `of Rp ${fmtIdr(requested_amount)} requested` : '(as requested)'} | Rp ${fmtIdr(granted_monthly_installment)}/mo x ${effective_tenor}m`
      : null,
    `PD: ${pd_factors.join(' x ')}`,
  ].filter(Boolean).join('\n');

  return {
    json: {
      ...item,
      loan_amount_granted: granted_amount_idr,
      loan_tier_granted: grantedTier.key,
      monthly_installment_idr: Math.round(granted_monthly_installment),
      effective_tenor_months: effective_tenor,
      pd_score: pd_percentage,
      application_status,
      decision_notes,
      scoring: {
        ...item.scoring,
        calculated_pd: parseFloat(calculated_pd.toFixed(4)),
        pd_percentage,
        dti_multiplier,
        tenor_multiplier,
      },
      flags: {
        ...item.flags,
        is_restructured: true,
        is_high_dti,
        is_low_dti,
        is_counter_offer,
        dti_at_application: parseFloat(dti_at_application.toFixed(4)),
        dti_ratio: parseFloat(final_dti_ratio.toFixed(4)),
        is_high_risk_pd: calculated_pd > CONFIG.limits.max_acceptable_pd,
      },
      terms: {
        ...item.terms,
        original_tenor_months: original_tenor,
        effective_tenor_months: effective_tenor,
        is_restructured: true,
        restructuring_reason,
        before_restructuring: before,
      },
    },
  };
});
