# Reconciliation

Raw values are computed from the Parquet pull with their own SQL. Mart values are read from
the built Parquet files. Every row that is compared exactly is marked MATCH or MISMATCH.

| Metric | Raw | Mart | Status |
|---|---:|---:|---|
| Complaints | 17,533,918 | 17,533,918 | MATCH |
| Complaints with a narrative | 3,851,415 | 3,851,415 | MATCH |
| Complaints per year (years that match) | 16 of 16 | 16 of 16 | MATCH |
| Complaints, product group credit_reporting | 14,282,679 | 14,282,679 | MATCH |
| Complaints, product group debt_collection | 1,186,841 | 1,186,841 | MATCH |
| Complaints, product group mortgage | 459,836 | 459,836 | MATCH |
| Complaints, product group bank_account | 480,521 | 480,521 | MATCH |
| Complaints, product group credit_card | 528,679 | 528,679 | MATCH |
| Complaints, product group student_loan | 133,125 | 133,125 | MATCH |
| Complaints, product group money_transfer | 195,597 | 195,597 | MATCH |
| Complaints, product group vehicle_loan | 122,862 | 122,862 | MATCH |
| Complaints, product group personal_loan | 84,607 | 84,607 | MATCH |
| Complaints, product group prepaid_card | 42,575 | 42,575 | MATCH |
| Complaints, product group debt_management | 16,596 | 16,596 | MATCH |
| Distinct companies | 8,112 | 8,112 | MATCH |
| Narratives, train period | 979,996 | 979,996 | MATCH |
| Narratives, validation period | 1,222,050 | 1,222,050 | MATCH |
| Narratives, test period | 111,391 | 111,391 | MATCH |
| mart_router_samples, train rows | 302,559 | 302,559 | MATCH |
| mart_router_samples, validation rows | 100,000 | 100,000 | MATCH |
| mart_router_samples, test rows | 111,391 | 111,391 | MATCH |
| mart_llm_samples, test rows | 3,300 | 3,300 | MATCH |
| mart_llm_samples, validation rows | 1,650 | 1,650 | MATCH |
| mart_llm_samples, fewshot rows | 11 | 11 | MATCH |

## Complaints per year

| Year | Raw | Mart | Status |
|---|---:|---:|---|
| 2011 | 2,536 | 2,536 | MATCH |
| 2012 | 72,368 | 72,368 | MATCH |
| 2013 | 108,214 | 108,214 | MATCH |
| 2014 | 152,909 | 152,909 | MATCH |
| 2015 | 168,273 | 168,273 | MATCH |
| 2016 | 191,292 | 191,292 | MATCH |
| 2017 | 242,745 | 242,745 | MATCH |
| 2018 | 257,131 | 257,131 | MATCH |
| 2019 | 277,240 | 277,240 | MATCH |
| 2020 | 444,213 | 444,213 | MATCH |
| 2021 | 495,939 | 495,939 | MATCH |
| 2022 | 800,245 | 800,245 | MATCH |
| 2023 | 1,292,049 | 1,292,049 | MATCH |
| 2024 | 2,734,269 | 2,734,269 | MATCH |
| 2025 | 5,442,964 | 5,442,964 | MATCH |
| 2026 | 4,851,531 | 4,851,531 | MATCH |
