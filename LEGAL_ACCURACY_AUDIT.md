# TaxRefund Bot Legal and Accuracy Audit

Audit date: 2026-08-25
Scope: public landing page, embedded quiz copy, Telegram knowledge base, and commercial claims.

## Findings and actions

### Tax year framing

The product concerns tax year 2025 returns filed in 2026. It must not present 2025 figures as tax year 2026 figures. The landing page now states this distinction and tells users to verify current amounts at IRS.gov.

### Primary sources

The content is designed to cite IRS.gov, IRS publications, forms, Revenue Procedures, and the Internal Revenue Code. Current checks used for this review include:

- IRS Child Tax Credit page: https://www.irs.gov/credits-deductions/individuals/child-tax-credit
- IRS EITC page: https://www.irs.gov/credits-deductions/individuals/earned-income-tax-credit-eitc
- IRS Publication 587 (2025), Business Use of Your Home: https://www.irs.gov/publications/p587
- IRS Education Credits page: https://www.irs.gov/credits-deductions/individuals/education-credits-aotc-and-llc
- IRS Working Families Tax Cuts hub, updated August 2026: https://www.irs.gov/obbb

### Claims removed or narrowed

- Unsupported customer testimonials and refund amounts were replaced with illustrative scenarios.
- The phrase suggesting deductions can be claimed without receipts was replaced with a records-and-substantiation warning.
- Employee job-search costs are no longer listed as a generic current federal deduction.
- The amended-return FAQ no longer promises a universal three-year result; users are directed to IRC section 6511 and current IRS instructions.
- The product no longer promises a refund, savings, tax preparation, filing, or legal/accounting advice.

## Product boundary

TaxRefund Bot is an educational screening and document-preparation aid. The paid $4.99 product is a source-linked evidence checklist, not a tax return, legal opinion, refund estimate, or professional representation. Any human review or return preparation must be performed by a separately identified credentialed professional.

Do not collect Social Security numbers, bank credentials, full tax returns, or identity documents in the MVP. State tax rules are out of scope unless a state-specific source and workflow are added.

## Release gate

Before changing hardcoded tax figures, verify the tax year against current IRS material and update the tests. Before enabling payment, publish terms, privacy, refund/cancellation policy, seller identity, and professional credentials/scope where applicable.
