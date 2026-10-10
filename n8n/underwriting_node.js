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
    min_monthly_income_idr: dynamicConfig.min_monthly_income_idr ?? 3_000_000,
    max_acceptable_pd: dynamicConfig.max_acceptable_pd ?? 0.20,
    auto_approve_pd_threshold: dynamicConfig.auto_approve_pd_threshold ?? 0.05,
    monthly_flat_rate: dynamicConfig.monthly_flat_rate ?? 0.015,
    high_dti_threshold: dynamicConfig.high_dti_threshold ?? 0.30,
    high_dti_multiplier: dynamicConfig.high_dti_multiplier ?? 1.25,
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
function maskString(val, visiblePrefix = 0, visibleSuffix = 0, maskChar = '*') {
  const str = String(val ?? '').trim();
  if (!str) return '';
  if (str.length <= visiblePrefix + visibleSuffix) return str;
  return `${str.slice(0, visiblePrefix)}${maskChar.repeat(str.length - visiblePrefix - visibleSuffix)}${visibleSuffix > 0 ? str.slice(-visibleSuffix) : ''}`;
}

// Blank, missing or non-numeric -> null (never silently 0)
const toNum = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
const slug = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_');
const fmtIdr = n => (n == null ? '-' : Math.round(n).toLocaleString('id-ID'));
const fmtPct = (r, d = 1) => (r == null ? '-' : `${(r * 100).toFixed(d)}%`);

// Sector baseline PD and regional multiplier come from the config sheet:
//   base_pd_<sector>, base_pd_default, regional_multiplier_<sector>_<province>
const basePdFor = business_type =>
  dynamicConfig[`base_pd_${slug(business_type)}`] ?? dynamicConfig.base_pd_default ?? 0.12;
const regionalMultiplierFor = (business_type, province) =>
  dynamicConfig[`regional_multiplier_${slug(business_type)}_${slug(province)}`] ?? 1.0;

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
// 3. RETRIEVE ALL INCOMING ROWS & FILTER OUT ALREADY PROCESSED
// ==============================================================================
const allRows = $('Google Sheets Trigger').all().map(e => e.json);
const pendingRows = allRows.filter(row => {
  const status = String(row.application_status ?? '').trim();
  return status === '' || status === 'PENDING';
});

if (pendingRows.length === 0) return [];

// ==============================================================================
// 4. INPUT GUARDRAILS, PD & DTI UNDERWRITING
// ==============================================================================
return pendingRows.map(item => {
  const borrower_id = item.borrower_id ?? '';
  const row_number = item.row_number ?? item.__rowNumber ?? undefined;
  const nik = String(item.nik ?? '').trim();
  const borrower_name = item.borrower_name ?? '';
  const business_name = item.business_name ?? '';
  const business_type = item.business_type ?? '';
  const province = item.province ?? '';
  const city = item.city ?? '';
  const original_tenor = toNum(item.tenor_months) ?? 0;
  const monthly_income = toNum(item.monthly_income_idr);            // no imputation
  const requested_amount = toNum(item.requested_loan_amount_idr);

  // Input Guardrails -> hold for documents instead of guessing
  const is_valid_nik = /^\d{16}$/.test(nik);
  const input_issues = [];
  if (!is_valid_nik) input_issues.push('valid NIK (16 digits)');
  if (monthly_income == null || monthly_income <= 0) input_issues.push('monthly income');
  if (!(requested_amount > 0)) input_issues.push('requested amount');
  if (!(original_tenor > 0)) input_issues.push('tenor');
  const below_min_income = monthly_income != null && monthly_income < CONFIG.limits.min_monthly_income_idr;

  // Culinary Tenor Cap
  let effective_tenor = original_tenor;
  let is_restructured = false;
  let restructuring_reason = 'None';

  if (slug(business_type) === 'kuliner' && original_tenor > CONFIG.culinary.max_tenor_months) {
    effective_tenor = CONFIG.culinary.restructured_tenor_months;
    is_restructured = true;
    restructuring_reason = `Auto-capped Culinary loan from ${original_tenor}m to ${effective_tenor}m ` +
      `(PD discount x${CONFIG.culinary.pd_discount_multiplier}).`;
  }

  // DTI of the requested loan
  const proposed_installment = installmentFor(requested_amount ?? 0, effective_tenor);
  const dti_at_application = monthly_income > 0 ? proposed_installment / monthly_income : null;
  const is_high_dti = dti_at_application != null && dti_at_application > CONFIG.limits.high_dti_threshold;

  // PD = sector baseline x regional x DTI x tenor-cap discount
  const base_pd = basePdFor(business_type);
  const regional_multiplier = regionalMultiplierFor(business_type, province);
  const dti_multiplier = is_high_dti ? CONFIG.limits.high_dti_multiplier : 1.0;
  const tenor_multiplier = is_restructured ? CONFIG.culinary.pd_discount_multiplier : 1.0;

  const pd_factors = [`${business_type || 'default'} ${fmtPct(base_pd)}`];
  if (regional_multiplier !== 1.0) pd_factors.push(`${province} ${regional_multiplier}`);
  if (is_high_dti) pd_factors.push(`DTI>${fmtPct(CONFIG.limits.high_dti_threshold, 0)} ${dti_multiplier}`);
  if (is_restructured) pd_factors.push(`tenor cap ${original_tenor}->${effective_tenor}m ${tenor_multiplier}`);

  let calculated_pd = base_pd * regional_multiplier * dti_multiplier * tenor_multiplier;
  calculated_pd = Math.min(Math.max(calculated_pd, 0.01), 0.99);
  const pd_percentage = fmtPct(calculated_pd, 2);
  const pd_is_final = input_issues.length === 0;   // DTI unknown until inputs are complete

  // Application Status Determination
  let application_status = '';
  let status_summary = '';

  if (input_issues.length > 0) {
    application_status = 'PENDING_DOCUMENTS';
    status_summary = `Missing: ${input_issues.join(', ')}`;
  } else if (below_min_income) {
    application_status = 'DECLINED_AUTO';
    status_summary = `Income below Rp ${fmtIdr(CONFIG.limits.min_monthly_income_idr)} floor`;
  } else if (calculated_pd > CONFIG.limits.max_acceptable_pd) {
    application_status = 'DECLINED_AUTO';
    status_summary = `PD above ${fmtPct(CONFIG.limits.max_acceptable_pd)} limit`;
  } else if (calculated_pd < CONFIG.limits.auto_approve_pd_threshold && dti_at_application <= CONFIG.limits.max_dti_ratio) {
    application_status = 'APPROVED_AUTO';
    status_summary = `PD below ${fmtPct(CONFIG.limits.auto_approve_pd_threshold)}, DTI within ${fmtPct(CONFIG.limits.max_dti_ratio)}`;
  } else {
    application_status = 'BORDERLINE_HITL';
    status_summary = `PD ${fmtPct(CONFIG.limits.auto_approve_pd_threshold)}-${fmtPct(CONFIG.limits.max_acceptable_pd)}, needs underwriter review`;
  }

  // ==============================================================================
  // 5. CAPACITY-BASED LOAN SIZING & TIER GRANTING
  // ==============================================================================
  // Max principal whose installment stays within the DTI ceiling
  const max_allowable_installment = (monthly_income ?? 0) * CONFIG.limits.max_dti_ratio;
  const theoretical_principal_capacity = effective_tenor > 0
    ? max_allowable_installment / (1 / effective_tenor + CONFIG.limits.monthly_flat_rate)
    : 0;
  const max_sanctionable_capacity = Math.min(theoretical_principal_capacity, CONFIG.limits.max_exposure_idr);

  let grantedTier = LOAN_TIER_ENUM.TIER_0_NONE;

  if (application_status === 'APPROVED_AUTO') {
    // Never above what was requested
    grantedTier = quantizeToLoanTier(Math.min(max_sanctionable_capacity, requested_amount));
  } else if (application_status === 'BORDERLINE_HITL') {
    // Risk haircut: conservative pre-qualification tier for underwriter review
    grantedTier = quantizeToLoanTier(Math.min(max_sanctionable_capacity * CONFIG.limits.borderline_haircut, requested_amount));
  }

  // Approved or borderline but affordable amount is below the smallest tier -> decline
  if ((application_status === 'APPROVED_AUTO' || application_status === 'BORDERLINE_HITL') && grantedTier.amount === 0) {
    application_status = 'DECLINED_AUTO';
    status_summary = `Affordable amount below Rp ${fmtIdr(LOAN_TIER_ENUM.TIER_1_MICRO_10M.amount)} minimum tier`;
  }

  const granted_amount_idr = grantedTier.amount;
  const granted_monthly_installment = installmentFor(granted_amount_idr, effective_tenor);
  const final_dti_ratio = monthly_income > 0 ? granted_monthly_installment / monthly_income : 0;
  const is_counter_offer = granted_amount_idr > 0 && granted_amount_idr < (requested_amount ?? 0);

  // Audit Log Trace for Google Sheets (details live in scoring / flags / terms)
  const processed_at = new Date().toISOString();
  const decision_notes = [
    `${application_status} | PD ${pd_is_final ? pd_percentage : '-'} | DTI ${fmtPct(dti_at_application)}`,
    status_summary,
    granted_amount_idr > 0
      ? `Offer Rp ${fmtIdr(granted_amount_idr)} ${is_counter_offer ? `of Rp ${fmtIdr(requested_amount)} requested` : '(as requested)'} | Rp ${fmtIdr(granted_monthly_installment)}/mo x ${effective_tenor}m`
      : null,
    pd_is_final ? `PD: ${pd_factors.join(' x ')}` : null,
  ].filter(Boolean).join('\n');

  // PII Masking (raw NIK and name are not passed downstream)
  const masked_nik = maskString(nik, 6, 2, '*');
  const masked_name = maskString(borrower_name, 2, 1, '*');
  const masked_phone = item.phone_number ? maskString(item.phone_number, 0, 4, '*') : undefined;

  return {
    json: {
      ...(row_number && { row_number }),
      borrower_id,
      masked_nik,
      masked_name,
      business_name,
      business_type,
      province,
      city,
      ...(masked_phone && { masked_phone }),

      // Underwriting & Sizing Results
      requested_loan_amount_idr: requested_amount,
      loan_amount_granted: granted_amount_idr,
      loan_tier_granted: grantedTier.key,
      monthly_installment_idr: Math.round(granted_monthly_installment),
      effective_tenor_months: effective_tenor,
      monthly_income_idr: monthly_income,

      // Status & Decisions
      pd_score: pd_is_final ? pd_percentage : '',
      application_status,
      decision_notes,
      processed_at,

      scoring: {
        calculated_pd: parseFloat(calculated_pd.toFixed(4)),
        pd_percentage,
        base_pd,
        regional_multiplier,
        dti_multiplier,
        tenor_multiplier,
      },
      flags: {
        is_valid_nik,
        input_issues,
        below_min_income,
        is_restructured,
        is_high_dti,
        is_counter_offer,
        dti_at_application: dti_at_application == null ? null : parseFloat(dti_at_application.toFixed(4)),
        dti_ratio: parseFloat(final_dti_ratio.toFixed(4)),
        is_high_risk_pd: calculated_pd > CONFIG.limits.max_acceptable_pd,
      },
      terms: {
        original_tenor_months: original_tenor,
        effective_tenor_months: effective_tenor,
        is_restructured,
        restructuring_reason,
      },
    },
  };
});
