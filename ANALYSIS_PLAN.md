# Analysis plan

Written 17 Nov 2026, before any model was trained and before any weekly series was looked at.
This file is committed on its own. Later changes to it are separate commits and are listed in
`docs/FINDINGS.md` as deviations.

## 1. Questions

1. **Router.** How well can a complaint be sent to the right product desk from its text alone?
2. **Is a language model worth it.** Does a large language model beat a small trained model
   once confidence and cost are counted?
3. **Radar.** Would a simple monitoring rule have flagged known public events, and how often
   does it raise an alarm nobody can explain?

## 2. What had been seen when this was written

Everything below was fixed after looking at these things and nothing else:

- `docs/DATA_PROFILE.md` (made by `scripts/profile_data.py`): row counts, yearly and monthly
  counts, the list of product and sub-product labels with their date ranges, blank rates, text
  length, the share of repeated text by year and product, company concentration by year.
- The speed and output format of the language model on 24 complaints from the 2011 to 2018
  file, which is outside the modelling period. Predictions were not compared with labels.
- General public knowledge of the five events in section 7. The Equifax breach is widely
  reported to have raised complaint volumes, so it is a positive control, not a discovery.

Not seen: any weekly series, any trained model, any accuracy figure, any narrative text beyond
the few lines printed while checking that the file parsed.

Facts from the profile that shape the plan:

- 17,533,918 complaints received 1 Dec 2011 to 31 Aug 2026; 3,851,415 carry a narrative. The
  first narrative is dated 19 Mar 2015.
- The product list changed in April 2017 and again on 24 to 25 Aug 2023.
- Repeated text (the same narrative after lower-casing and collapsing spaces) is 51% of 2024
  narratives and 59% of 2025 narratives, mostly credit reporting.
- **Published narratives collapse in 2026.** Monthly narratives fall from about 100,000 in
  2025 to 10,000 to 22,000 from January 2026, and credit-reporting narratives fall from about
  80,000 a month to under 900, while total complaints keep rising. The cause is not in the data
  and is not guessed at here. It means the test period has a very different product mix from
  the training and validation periods. That is kept, not designed around: a router is used on
  the future, and the future changed.
- July and August 2026 are incomplete: 105,327 and 370,160 complaints are still "In progress"
  and August has one narrative.

## 3. Data and definitions

- **Source:** the CFPB "Consumer Complaint Database Narratives Archive", 21 files, pulled once
  (`data/MANIFEST.json`). One row is one complaint.
- **Narrative:** the complaint text, present only when the consumer agreed to publish it.
- **Product group:** eleven groups that hold across all three versions of the product list,
  mapped from product and sub-product by `dbt/seeds/product_map.csv`. The mapping is published.
- **Text hash:** md5 of the narrative lower-cased, trimmed, with runs of whitespace collapsed.
  Two complaints with the same hash have **repeated text**.
- **Week:** Monday to Sunday by date received. Only full weeks are used: the first starts
  5 Dec 2011, the last starts 24 Aug 2026.
- **Responded:** company response is not "In progress". Rates of timely response and relief
  use responded complaints as the denominator.
- **Monetary relief:** company response is "Closed with monetary relief".
- All sampling "by hash order" means ordering by `md5(complaint_id)` and taking the first rows,
  so samples are reproducible and independent of file order.

## 4. Descriptive layer (SQL)

Volume by month, product group, company, state and year; share with narrative; company response
mix; timely-response rate; monetary-relief rate. Every rate carries a Wilson 95% interval and
its n. These are descriptions of who complains, not of how companies behave: bigger companies
receive more complaints, and no rate here is adjusted for size.

## 5. Router

**Label.** The product, in the current product list, which has eleven values. Modelling uses
only complaints received from 1 Sep 2023, so no label is mapped across versions.

**Split by time.**

| Set | Received | Use |
|---|---|---|
| Train | 1 Sep 2023 to 31 Dec 2024 | fit |
| Validation | 1 Jan 2025 to 31 Dec 2025 | choose settings and thresholds |
| Test | 1 Jan 2026 to 30 Jun 2026 | report once |

July and August 2026 are left out because narratives for those months are incomplete.

**Samples.**

- Train sample: one complaint per text hash (the earliest), then at most 100,000 per product
  by hash order.
- Validation sample: 100,000 narratives from the validation period by hash order.
- Test set: every narrative in the test period.
- **New text:** a test complaint whose text hash does not occur in any complaint received
  before 1 Jan 2026. Every test metric is reported on the full test set and on new text only.

**Models.**

1. Majority: always the most common product in the train sample.
2. Words: TF-IDF (lower-case, tokens `[a-z0-9]{2,}`, one and two word terms, at least 5
   documents, the 30,000 most frequent terms, sublinear term frequency, L2 norm) with
   multinomial logistic regression. This same model is exported to the site and run in the
   browser.
3. Embeddings: `sentence-transformers/all-MiniLM-L6-v2` on the first 2,000 characters, 256
   tokens at most, with multinomial logistic regression on top.

For models 2 and 3 the regularisation strength C is chosen from {0.3, 1, 3, 10} by macro-F1 on
the validation sample. Nothing else is tuned. A fine-tuned transformer is added only if the best
validation macro-F1 of these models is below 0.80.

**Metrics on the test set.** Macro-F1 (headline) and accuracy, each with a 95% percentile
interval from 1,000 bootstrap resamples of complaints (rows sorted by complaint id, seed 0).
Per-product precision, recall and F1. Calibration: reliability table in 10 equal-width bins of
the top probability and expected calibration error. Time to score 1,000 complaints.

**Automatic routing at 95% precision.** For each model the threshold is the smallest top
probability at which validation-sample complaints at or above it are at least 95% correct. On
the test set, report **coverage** (share at or above the threshold) and **precision** (share of
those that are correct), with Wilson intervals, overall, by product, and on new text.

**Label-noise check.** Among test complaints whose text hash is shared by at least two test
complaints, the share that carry the most common product for their text. A model sees only the
text, so it cannot beat this on those complaints. It describes repeated text only and is shown
as context, not as a ceiling for the whole test set.

**Issue within product (secondary).** For each product, the words model retrained on that
product's train rows to predict the issue, with issues under 50 train rows merged into "Other
issue". Reported per product against that product's majority issue. No hypothesis.

## 6. Language model against the small model

**Model.** `llama3.1:8b` run locally with Ollama, temperature 0, seed 0. No hosted model.

**Prompt.** The eleven products are listed as letters A to K. The complaint is cut to its first
2,000 characters. The model answers with one letter. The prediction is the letter with the
highest probability among A to K in the first output token; the **confidence** is that
probability divided by the total probability of the eleven letters.

- Zero-shot: the list and the complaint.
- Few-shot: the same, preceded by one example per product, each the first train-sample
  narrative by hash order with 200 to 800 characters, cut to 500 characters.

**Fixed evaluation samples**, one complaint per text hash, by hash order:

- Test: 300 per product from the test period (all of them where a product has fewer).
- Validation: 150 per product from the validation period.

The sizes were set from the measured speed (about 1.2 seconds a complaint) so both variants
finish in about four hours. Every model in section 5 is scored on the same test sample.

**Comparison (H1).** The variant with the higher macro-F1 on the validation sample is the
language model's entry. On the test sample, the difference in macro-F1 between it and the words
model, with a 95% interval from 2,000 paired bootstrap resamples within product. Verdict:

- interval entirely above 0: the language model is more accurate;
- entirely below 0: the small model is more accurate;
- otherwise: no detectable difference.

Macro-F1 on this sample is on an equal mix of products, not the real mix; it is labelled that
way wherever it appears. Also reported for both: accuracy, coverage and precision of automatic
routing at the validation threshold, expected calibration error, seconds and tokens per 1,000
complaints. Cost is reported as measured time on this laptop. No price is invented: the site
lets the reader enter a price per million tokens to see what the measured token counts would
cost.

## 7. Radar

**Series.** Weekly complaints (all complaints, with or without narrative) for ten product
groups: credit reporting, debt collection, mortgage, credit card, bank account, student loan,
vehicle loan, money transfer, personal loan, prepaid card. Debt management is left out as too
small (10,153 complaints in three years).

**Alarm rule.** For a series with weekly count c:

1. x = ln(1 + c).
2. Level: the median of x over the previous 26 weeks. d = x minus the level.
3. Season: the median of d at the same week 52, 104, 156, ... weeks earlier, using every year
   available; 0 when fewer than two are available. r = d minus the season.
4. Scale: 1.4826 times the median absolute deviation of r over the previous 52 weeks, with a
   floor of 0.05. z = (r minus the median of r over those 52 weeks) divided by the scale.
5. **Alarm** in a week when z is above 3 in that week and in the week before.

A series is monitored from its 131st week. Alarm weeks no more than 4 weeks apart form one
**episode**, dated by its first alarm week.

**Naive rule for comparison.** Alarm when c is above 1.5 times the mean of the previous 52 weeks
in that week and in the week before. Same episodes.

**Events, fixed here.**

| Event | Date | Product group |
|---|---|---|
| Equifax data breach announced | 7 Sep 2017 | credit reporting |
| CARES Act mortgage forbearance signed | 27 Mar 2020 | mortgage |
| FTX files for bankruptcy | 11 Nov 2022 | money transfer |
| Silicon Valley Bank fails | 10 Mar 2023 | bank account |
| Federal student-loan payments restart | 1 Oct 2023 | student loan |

**Scoring.** An event is **detected** when an episode on its series starts in the event week
or the 8 weeks after. An episode already open in the event week does not count. Reported per
event: detected or not, delay in weeks, and the same for the naive rule. An **unexplained
episode** is one that starts outside every event window of its series. Some of these will be
real events not on the list, so the count is an upper bound on false alarms.

**H3.** The rule passes if it detects at least 4 of the 5 events and raises at most 1.0
unexplained episode per series per year (exact Poisson interval reported).

**Text novelty (exploratory, no pass or fail).** For the five event series, up to 100
narratives a week by hash order, embedded as in section 5. A narrative's novelty is 1 minus its
highest cosine similarity to the sampled narratives of the previous 26 weeks. The weekly mean
novelty is run through the same alarm rule. Narratives start in March 2015, so this covers
events from 2017 on.

## 8. Hypotheses and pass rules

| | Claim tested | Pass rule |
|---|---|---|
| H1 | The language model is more accurate than the words model | paired interval for the macro-F1 difference is entirely above 0 |
| H2 | The words model can route at least half of complaints automatically at 95% precision | on the test set, precision is at least 0.95 and coverage at least 0.50 |
| H3 | The alarm rule finds known events without crying wolf | at least 4 of 5 detected and at most 1.0 unexplained episode per series per year |

H2 is at risk from the 2026 change in product mix, which was known when this was written. If
it fails it is reported as failed.

## 9. What would change or drop an analysis

- A product with fewer than 100 test narratives is reported but left out of macro-F1.
- If the embedding model cannot be downloaded, model 3 is dropped and that is stated.
- If the language model run cannot finish, the completed complaints are reported with their n.
- A failed rule is reported as failed and explained. No threshold, window or event is changed
  after results are seen.

## 10. What this cannot show

- Complaints are not a random sample of problems, and narratives are the subset whose authors
  agreed to publish.
- Labels are chosen by the consumer. A "wrong" prediction is sometimes the better label.
- Complaint counts are not incident counts. Nothing here measures any company's conduct.
- United States consumer finance only.
- The 2026 test period is small and unusual. Results on it describe that period.
