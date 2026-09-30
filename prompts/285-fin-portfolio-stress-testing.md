---
id: fin-portfolio-stress-testing
title: Finance: Macroeconomic Market Risk & Basel III / CCAR Portfolio Stress Testing
category: finance
language: null
functionName: solution
executable: false
---
Act as the Chief Risk Officer and Head of Quantitative Risk Analytics for a Global Systemically Important Bank (G-SIB) managing a $650B multi-asset investment and credit portfolio ($320B corporate & commercial loans, $180B residential mortgages, $90B fixed income & sovereign treasuries, and $60B structured credit derivatives). You are executing the annual Comprehensive Capital Analysis and Review (CCAR) and Basel III / Basel IV capital adequacy stress testing program.

Global financial markets face severe macroeconomic headwinds: stagflationary shocks, a 350 bps central bank interest rate spike, commercial real estate (CRE) office vacancy distress, sovereign bond yield curve inversions, and high-yield corporate credit spread blowout. You must quantify portfolio losses, evaluate Common Equity Tier 1 (CET1) capital depletion, and architect balance-sheet capital preservation strategies.

### Deliverables & Section Requirements:

#### 1. Macroeconomic Stress Scenarios & Shock Calibration
- Formal macroeconomic scenario definition table comparing Baseline vs. Severely Adverse Scenarios over a 9-quarter forecasting horizon:
  - Real GDP contraction (%).
  - Peak Unemployment Rate (%).
  - Commercial Real Estate Price Index (CREPI) drop (%).
  - Residential Home Price Index (HPI) decline (%).
  - 10-Year Treasury Yield vs. 3-Month T-Bill yield curve inversion spread.
  - BBB Corporate Credit Spread blowout (bps).
  - Equity Market (S&P 500) peak-to-trough decline (%).

#### 2. Multi-Asset Portfolio Loss & Credit Risk Modeling
Detailed quantitative credit loss model table across 5 core asset classes (Commercial Real Estate, Large Corporate Syndicated Loans, Mid-Market Commercial Loans, Prime & Non-Prime Mortgages, Collateralized Loan Obligations / CLOs) detailing:
- **Asset Portfolio Class & Exposure at Default (EAD, $B)**
- **Baseline Probability of Default (PD, %)**
- **Stressed Probability of Default (Stressed PD, %)**
- **Loss Given Default (LGD, %)**
- **Stressed Loss Rate (%)**
- **Projected 9-Quarter Cumulative Credit Losses ($B)**
- **Allowance for Credit Losses (ACL) & CECL Reserve Builds ($B)**
Include mathematical equations for the credit migration transition matrices and Merton structural default models.

#### 3. Trading Book Market Risk, Counterparty Exposure & VaR
- Value-at-Risk (VaR) and Expected Shortfall (ES) model calculations under the Fundamental Review of the Trading Book (FRTB) framework:
  - Stressed VaR (99% confidence level, 10-day liquidity horizon).
  - Counterparty Credit Risk: Stressed Credit Valuation Adjustment (CVA) and Potential Future Exposure (PFE) on the $60B derivatives portfolio.
  - Interest Rate Risk in the Banking Book (IRRBB): Economic Value of Equity (EVE) and Net Interest Income (NII) sensitivity to non-parallel yield curve shifts (+300 bps steepener / flattener).

#### 4. Capital Adequacy & CET1 Depletion Walkthrough
Comprehensive capital trajectory table walking through the 9-quarter severely adverse stress test:
- Starting Common Equity Tier 1 (CET1) Capital ($B) and CET1 Ratio (%).
- Pre-Provision Net Revenue (PPNR) generation.
- Cumulative Credit & Trading Losses.
- Stressed Risk-Weighted Assets (RWA) expansion.
- Trough CET1 Ratio (%) versus Regulatory Minimums (4.5% Basel III minimum + 2.5% Capital Conservation Buffer + G-SIB Surcharge + Countercyclical Buffer).
- Identifying capital shortfall or surplus buffer ($B).

#### 5. Liquidity Stress Testing & LCR / NSFR Compliance
- 30-day liquidity outflow simulation under Basel III Liquidity Coverage Ratio (LCR) standards:
  - Retail deposit run-off rates (operational vs. non-operational deposits).
  - Uncommitted credit and liquidity facility draw-downs.
  - High-Quality Liquid Assets (HQLA) haircut analysis (Level 1 cash/treasuries vs. Level 2A/2B securities).
  - Stressed LCR (%) and Net Stable Funding Ratio (NSFR) trajectory.

#### 6. Capital Restoration & Management Remediation Plan
- Actionable balance-sheet preservation recommendations:
  - Dividend distribution cuts and share buyback suspensions.
  - RWA compression levers: hedging credit portfolios via Credit Default Swaps (CDS), synthetic risk transfers (SRT), and high-RWA loan divestitures.
  - Executive presentation dashboard summarizing capital resilience for the Federal Reserve Board and ECB Joint Supervisory Team.

---
### Presentation Standards:
- Present the deliverable as an executive, regulatory-grade Quantitative Risk Dossier.
- Provide comprehensive Markdown tables for macroeconomic scenarios, credit risk losses, capital ratio depletion, and liquidity runs.
- Bold all monetary amounts ($B), basis points (bps), capital ratios (CET1 %), and statistical probabilities.
- Provide full mathematical and numerical rigour without truncated rows or placeholders.
