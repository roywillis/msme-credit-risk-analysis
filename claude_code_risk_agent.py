import os
import json
import time
from typing import Dict, Any

# ==============================================================================
# CLAUDE CODE REBUILD: MSME CREDIT RISK ANALYSIS STEP (NODE 5 REPLICATION)
# Milestone 3 - Week 9 Tool Comparison Simulation
# ==============================================================================

# Input payload matching n8n Node 2/3 output
SAMPLE_BORDERLINE_APPLICANTS = [
    {
        "borrower_id": "BOR-0882",
        "masked_name": "B*** S***",
        "business_type": "Kuliner",
        "province": "Sumatera Utara",
        "credit_score": 520,
        "loan_amount_idr": 20000000,
        "effective_tenor_months": 12,
        "monthly_income_idr": 4500000,
        "dti_ratio": 0.3778,
        "pd_percentage": "18.20%",
        "is_restructured": True,
        "restructuring_reason": "Auto-capped Culinary tenor from 24m to 12m (reduces default risk from 35.00% to 12.90%)."
    },
    {
        "borrower_id": "BOR-0914",
        "masked_name": "A*** M***",
        "business_type": "Pertanian",
        "province": "Sulawesi Utara",
        "credit_score": 540,
        "loan_amount_idr": 18000000,
        "effective_tenor_months": 12,
        "monthly_income_idr": 4500000,
        "dti_ratio": 0.3400,
        "pd_percentage": "19.50%",
        "is_restructured": False,
        "restructuring_reason": "Standard contract terms applied."
    }
]

def generate_risk_analysis_prompt(applicant: Dict[str, Any]) -> str:
    """Constructs prompt identical to n8n Node 5 AI Agent prompt."""
    return f"""You are an expert MSME Credit Risk Analyst at an Indonesian Fintech Lender.
Analyze the following borderline credit application and produce a structured JSON risk evaluation.

[BORROWER PROFILE]
- Borrower ID: {applicant['borrower_id']}
- Masked Name: {applicant['masked_name']}
- Business Sector: {applicant['business_type']}
- Province: {applicant['province']}
- Credit Score: {applicant['credit_score']}
- Granted Loan Amount: Rp {applicant['loan_amount_idr']:,}
- Effective Tenor: {applicant['effective_tenor_months']} months
- Monthly Income: Rp {applicant['monthly_income_idr']:,}
- Debt-to-Income (DTI) Ratio: {applicant['dti_ratio'] * 100:.1f}%
- Calculated Probability of Default (PD): {applicant['pd_percentage']}
- Restructuring Applied: {'YES' if applicant['is_restructured'] else 'NO'}
- Restructuring Note: {applicant['restructuring_reason']}

[OUTPUT REQUIREMENTS]
Respond ONLY with a valid JSON object matching this schema:
{{
  "recommendation": "APPROVE_WITH_CONDITIONS" | "ESCALATE_TO_SENIOR_OFFICER" | "DECLINE",
  "risk_tier": "BORDERLINE_MODERATE" | "BORDERLINE_HIGH",
  "policy_trigger": "<Exact OJK or internal policy clause>",
  "executive_summary": "<1-sentence rationale for human underwriter>",
  "risk_drivers": ["<Risk factor 1>", "<Risk factor 2>"],
  "mitigating_factors": ["<Mitigating factor 1>", "<Mitigating factor 2>"],
  "action_checklist": ["1. <Verification 1>", "2. <Verification 2>", "3. <Verification 3>"]
}}"""

def run_ai_risk_step(applicant: Dict[str, Any]) -> Dict[str, Any]:
    """
    Executes AI risk evaluation.
    In live production, call anthropic.messages.create() or openai.chat.completions.create().
    """
    time.sleep(0.4) # Simulates API latency (~400ms)
    
    is_culinary = applicant["business_type"] == "Kuliner"
    
    if is_culinary and applicant["is_restructured"]:
        return {
            "recommendation": "APPROVE_WITH_CONDITIONS",
            "risk_tier": "BORDERLINE_MODERATE",
            "policy_trigger": "Credit Policy Section 4.2: Culinary Tenor Restructuring & DTI < 40% Rule",
            "executive_summary": f"Borrower {applicant['borrower_id']} exhibits moderate credit risk (PD {applicant['pd_percentage']}) stabilized by mandatory 12-month tenor capping.",
            "risk_drivers": [
                f"Low baseline credit score ({applicant['credit_score']}) near <550 threshold.",
                f"Elevated DTI ratio of {applicant['dti_ratio']*100:.1f}%."
            ],
            "mitigating_factors": [
                "Tenor auto-capped to 12 months, reducing default risk from 35.00% to 12.90%.",
                "Monthly installment within approved 40% DTI ceiling."
            ],
            "action_checklist": [
                "1. Verify POS transaction logs or QRIS daily sales records.",
                "2. Confirm active merchant registration for premises.",
                "3. Obtain signed agreement for restructured 12-month schedule."
            ]
        }
    else:
        return {
            "recommendation": "ESCALATE_TO_SENIOR_OFFICER",
            "risk_tier": "BORDERLINE_HIGH",
            "policy_trigger": "Credit Policy Section 5.1: Regional Hotspot Exposure Cap (North Sulawesi Agriculture)",
            "executive_summary": f"Borrower {applicant['borrower_id']} presents high regional risk in North Sulawesi agriculture (PD {applicant['pd_percentage']}) requiring Senior Officer override.",
            "risk_drivers": [
                "Historical regional agriculture default rate spike (36.51% baseline).",
                f"Unmitigated credit score of {applicant['credit_score']}."
            ],
            "mitigating_factors": [
                f"Loan principal (Rp {applicant['loan_amount_idr']:,}) is within exposure limits.",
                "Clean regional trade reference check recorded."
            ],
            "action_checklist": [
                "1. Conduct on-site crop yield and harvest cycle verification.",
                "2. Validate secondary guarantor income documentation.",
                "3. Obtain approval signature from Regional Head of Credit Risk."
            ]
        }

def run_claude_code_rebuild():
    start_time = time.time()
    results = []
    
    for applicant in SAMPLE_BORDERLINE_APPLICANTS:
        ai_output = run_ai_risk_step(applicant)
        combined = {
            **applicant,
            "ai_evaluation": ai_output,
            "decision_notes_formatted": f"[STATUS]: {ai_output['recommendation']} - {ai_output['executive_summary']}\n[POLICY]: {ai_output['policy_trigger']}"
        }
        results.append(combined)
    
    elapsed_time = time.time() - start_time
    
    # Write output matching n8n schema
    output_filepath = "claude_code_rebuild_output.json"
    with open(output_filepath, "w") as f:
        json.dump(results, f, indent=2)
        
    print(f"✓ Rebuild executed successfully in {elapsed_time:.3f}s ({elapsed_time/len(results):.3f}s per item).")
    print(f"✓ Output saved to {output_filepath}")

if __name__ == "__main__":
    run_claude_code_rebuild()
