# Findings

Every result here comes from a file in `artefacts/` and carries its 95% interval and n where it is
an estimate. A few explanatory checks made after the results, from the saved predictions in
`models_out/predictions.parquet`, are marked "post-hoc". The tests and pass rules were fixed in `ANALYSIS_PLAN.md` before any result existed.
All three rules failed. They are reported as failed.

| | Question | Verdict |
|---|---|---|
| H1 | Is the language model more accurate than the small words model? | **FAIL**: the small model was more accurate, by 0.038 macro-F1 |
| H2 | Can the words model route half of complaints automatically at 95% precision? | **FAIL**: 63.6% coverage, but 88.8% precision |
| H3 | Does the alarm rule catch known events without crying wolf? | **FAIL**: 1 of 5 events caught |

## 1. The data and its traps

- 17,533,918 complaints received 1 Dec 2011 to 31 Aug 2026, from the CFPB Consumer Complaint
  Database Narratives Archive (21 files). 3,851,415 carry the consumer's written narrative (22.0%,
  95% interval 21.9% to 22.0%). The first narrative is dated 19 Mar 2015.
- The live CFPB bulk file no longer carries the narrative column at all; the archive is the only
  public source of the text.
- **Published text collapses in 2026.** Through 2025 the database published 56,510 to 172,937
  narratives a month. From January to July 2026 it published 10,002 to 22,227 a month, while total
  complaints kept rising to 500,000 to 670,000 a month. Credit-reporting narratives fell from
  38,876 to 101,415 a month in 2025 to 463 to 862 a month. The data does not say why, and no cause
  is claimed here.
- July and August 2026 are incomplete (105,327 and 370,160 complaints still "In progress"; one
  narrative in August), so the test period ends on 30 Jun 2026.
- **Repeated text.** 51.3% of 2024 narratives and 58.7% of 2025 narratives repeat another complaint
  word for word (after lower-casing and collapsing spaces), mostly credit reporting.
- **Concentration.** The three credit bureaus received 84% of complaints in 2024 and 86% in
  2025. Complaint counts are not incident counts: a company with more customers receives more
  complaints, and no rate here is adjusted for size.
- **Labels change.** The product list changed in April 2017 and again in August 2023. All 21 product
  labels map to eleven groups in `dbt/seeds/product_map.csv`; every complaint gets a group (a dbt test).
- **Label noise.** Of 13,109 test-period complaints whose text appears at least twice in the test
  period, 99.5% (95% interval 99.3% to 99.6%) carry the most common product for their text. This
  covers repeated text only and says nothing about labels on unique text.

## 2. The router

Trained on narratives received 1 Sep 2023 to 31 Dec 2024 (302,559 after removing repeated text and
capping each product at 100,000), tuned on 100,000 from 2025, and tested once on every narrative from
1 Jan to 30 Jun 2026 (111,391; 104,271 of them are text never seen before 2026). The label is the
consumer's chosen product, eleven values.

| Model | Test macro-F1 | Test accuracy | Calibration error |
|---|---|---|---|
| Majority (always "credit reporting") | 0.007 (0.007 to 0.007) | 0.040 (0.039 to 0.041) | 0.290 |
| Words: TF-IDF + logistic regression | **0.676 (0.672 to 0.681)** | **0.765 (0.763 to 0.768)** | 0.021 |
| Embeddings: MiniLM + logistic regression | 0.647 (0.643 to 0.651) | 0.744 (0.741 to 0.746) | 0.015 |

n = 111,391 for every row; intervals from 1,000 bootstrap resamples of complaints (section 5 explains
why these are too narrow). On text never seen before 2026, which is 94% of the test set, the words
model scores macro-F1 0.676 and accuracy 0.777.

**The words model scores higher than the sentence embeddings** by about 0.03 macro-F1. The two
intervals do not overlap, but they are not a paired test, so read this as a clear but untested gap. Both are well calibrated (expected calibration error 0.02 or below): when the words model
says 85%, it is right about 85% of the time.

**Where it goes wrong.** Credit reporting is 33% of the training sample and 75% of the 2025
validation sample, but only 4% of the 2026 test set, because of the 2026 collapse in published
credit-reporting text. The model keeps sending complaints to the credit-reporting desk: it sends
15,259 there, of which only 4,150 are credit reporting (precision 0.27, recall 0.93). Debt
collection is the most common victim. Small products with a broad remit (debt management, prepaid
cards, personal loans) are the hardest, with recall between 0.14 and 0.46.

**H2: automatic routing at 95% precision — FAIL.** The threshold chosen on 2025 data (a top
probability of 0.706) gave 95.0% precision on the 2025 validation complaints. On the 2026 test set it routed 63.6% of complaints
(95% interval 63.3% to 63.9%, n = 111,391) at **88.8% precision** (88.5% to 89.0%, n = 70,829).
Coverage passed the rule; precision did not. The threshold did not survive the shift in product mix, and it was already optimistic: 40% of the
validation sample is repeated text, and counting each text once (post-hoc), precision at the same
threshold on 2025 data was 93.3% (45,425 of 48,713), not 95.0%.

Explaining the failure (post-hoc, not a test): the credit-reporting desk alone
took 7,376 automatically routed complaints at 47% precision. Every other desk was routed at 84% to
99% precision (per desk here means per predicted product), and without the credit-reporting desk the routed complaints were 93.6% correct
(59,406 of 63,453): better, still short of 95%.

**Issue within product (secondary, no hypothesis).** Predicting the issue inside a product is much
harder: the words model's issue accuracy ranges from 0.39 (debt management) to 0.74 (mortgage),
against 0.23 to 0.59 for always guessing the commonest issue.

**Plan rule not carried out.** The plan said a fine-tuned transformer is added if the best
validation macro-F1 is below 0.80. It was 0.680, so the rule fired. The fine-tuned model was not
built for this release; this is a deviation, listed in section 5.

## 3. The language model against the small model

**H1 — FAIL, in the other direction.** On the same fixed sample of 3,300 test complaints, the small
words model was more accurate than the language model.

The language model was Llama 3.1 8B, run locally on the laptop with Ollama, temperature 0. It saw the
eleven products as letters A to K and answered with one letter; its probabilities over the eleven
letters came from the first output token (on average 99.8% of that token's probability fell on the
letters). The sample is 300 complaints per product from the test period, one per text, so every
macro-F1 in this section is on an **equal mix of products**, not the real mix, and cannot be compared
with the 0.676 in section 2.

| Model | Macro-F1 (95% interval) | Accuracy | Calibration error | Seconds per 1,000 complaints |
|---|---|---|---|---|
| Words: TF-IDF + logistic regression | **0.656 (0.640 to 0.671)** | 0.669 | 0.063 | 0.08 |
| Embeddings + logistic regression | 0.629 (0.614 to 0.643) | 0.647 | 0.084 | 4.2 |
| Language model, few-shot (chosen on validation) | 0.617 (0.602 to 0.633) | 0.624 | 0.179 | 2,237 |
| Language model, zero-shot | 0.601 (0.585 to 0.617) | 0.614 | 0.219 | 2,139 |
| Majority | 0.015 | 0.091 | 0.240 | — |

n = 3,300 for every row. The few-shot prompt (one short example per product) beat zero-shot on the
1,650-complaint validation sample (0.632 against 0.595), so it is the language model's entry.

- **The difference** in macro-F1, language model minus words model, is **−0.038 (95% interval −0.056
  to −0.021)**, from 2,000 paired bootstrap resamples within product. The interval is entirely below
  zero.
- **Where each wins.** The language model found more of the student-loan (recall 0.92 against 0.83),
  personal-loan (0.76 against 0.45), vehicle-loan and money-transfer complaints. The words model was
  far better on the large desks: debt collection (0.75 against 0.45), mortgage (0.92 against 0.67),
  bank accounts (0.81 against 0.52) and credit cards (0.80 against 0.59).
- **Confidence.** The language model is badly calibrated: its expected calibration error is 0.18,
  against 0.06 for the words model, because it gives almost every answer a probability near 1. To
  reach 95% precision on validation its threshold had to sit at 0.9995, and at that threshold it
  routed only 1.9% of test-sample complaints automatically (at 90.3% precision). The words model, at
  its own threshold, routed 58.5% at 82.5% precision on this equal-mix sample. The two thresholds come
  from different validation sets (1,650 equal-mix complaints against 100,000 real-mix), so this is an
  illustration, not a like-for-like test.
- **Cost.** Measured on an Apple M4 laptop: the language model took a median of 1.95 seconds per
  complaint, about 2,200 seconds per 1,000. The words model scored 1,000 complaints in 0.08 seconds,
  roughly 28,000 times faster. The few-shot prompt used 1.69 million input tokens per 1,000
  complaints (zero-shot 0.35 million) and one output token each. No price is assumed; at any price
  per token, the language model costs more and is less accurate here, so there is no cost per point
  of accuracy to report.
- **What it is not.** A verdict on language models in general. This is one 8-billion-parameter open
  model, one prompt design, no fine-tuning, on the consumer's own product labels, which a model trained
  on those labels is better placed to imitate. A larger hosted model was not tested.

## 4. The radar

**H3 — FAIL.** The rule fixed in advance caught 1 of the 5 known events (95% interval 4% to 62%)
and needed 4.

| Event | Week | Rule | Naive rule | What the weekly counts did |
|---|---|---|---|---|
| Equifax data breach | 4 Sep 2017 | missed | missed | credit reporting went 1,734 → 7,074 → 4,108 → 2,360 a week; z = 4.78 then 2.97 |
| CARES Act forbearance | 23 Mar 2020 | missed | missed | mortgage rose from about 470 to 555 a week; z about 1 |
| FTX bankruptcy | 7 Nov 2022 | missed | missed | money transfer: one week at 361 against about 250; z = 2.7 |
| Silicon Valley Bank | 6 Mar 2023 | missed | missed | bank account did not move; z about 1 |
| Student-loan payments restart | 25 Sep 2023 | **caught**, same week | fired 3 weeks early | complaints rose from late August; the naive rule's episode began 4 Sep, before the event week, so the fixed scoring counts it as unexplained |

- The rule raised 18 unexplained episodes in 115.5 series-years: 0.156 per series per year (exact
  Poisson 95% interval 0.092 to 0.246; too narrow, because several series alarm in the same weeks). Some of these are real events not on the list, so this is an
  upper bound on false alarms. The naive rule (1.5 times the trailing year's mean, two weeks) caught
  none of the events and raised 44 unexplained episodes (0.381 per series per year, 0.277 to 0.511).
- **The Equifax near-miss.** The one clear spike quadrupled weekly credit-reporting complaints for a
  single week. Its first week scored z = 4.78 and its second 2.97, just short; the rule needs two weeks
  above 3, so it stayed silent. Part of the reason: credit-reporting volume roughly doubled between
  December 2016 and May 2017, that shift sat inside the 52-week scale window and widened it. The rule
  was not changed after seeing this.
- **What this means.** Weekly complaint counts at product level are a weak early-warning signal for
  these events. Three of the five barely show in the counts at all. With five events, the detection
  rate's interval runs from 4% to 62%, so this backtest cannot rank one rule above another; it can
  only say this rule missed most of the list.
- **What it is not.** Evidence that these events caused no consumer harm, or that a finer series (one
  company, one issue) would also miss them. That was not tested.
- **Text novelty (exploratory, no pass rule).** Weekly mean novelty of narratives against the previous
  26 weeks flagged none of the four events it could observe and raised one unexplained episode. Because
  narratives start in March 2015 and the rule needs 130 weeks of history, its monitoring starts in
  October 2017, after the Equifax breach, so it could not observe that event at all; the plan's note
  that it "covers events from 2017 on" was wrong.
- Checked independently: a second implementation reproduced all 7,308 weekly z-scores (largest
  difference 0.00005) and every alarm.

## 5. Deviations and limits

An independent read-only review of the statistics found no bug that changes a PASS or FAIL. It found
one place where the code read the plan differently (fixed) and the limits below.

**Deviations from the plan**

- **Episode gap (fixed).** The first version joined alarms up to 5 weeks apart into one episode; the
  plan says at most 4. Fixing it raised the rule's unexplained episodes from 17 to 18 and the naive
  rule's from 38 to 44. No detection changed.
- **No fine-tuned transformer.** The plan adds one when the best validation macro-F1 is below 0.80.
  It was 0.680, and the model was not built.
- **The novelty variant is not exactly the same rule.** It uses the raw weekly mean novelty (no log),
  a scale floor of 1e-9 instead of 0.05, and compares each week with the first 500 narratives of the
  previous 26 weeks by hash order rather than all of them (up to 2,600). It has no pass rule.
- **The language model's uniform fallback was never used.** If the eleven letters had no probability
  in the first token, the code would split it evenly; no call hit that case, and the letters' share of
  the first token's probability was below 0.5 in only 3 of 9,900 calls.
- **Automatic routing "by desk"** groups complaints by the predicted product, which is what a desk
  receives. Recall by true product is in the per-product table.

**Limits an interviewer should raise**

- **Intervals treat complaints as independent.** About 12% of test complaints repeat another test
  complaint's text, one text up to 1,488 times. A check that resampled whole texts instead of
  complaints gave clearly wider intervals and changed no verdict; it is not part of the repo's results.
- **The intervals cover sampling noise inside one six-month period, not the shift between periods,**
  which is the real source of error here.
- **The routing threshold sat on repeated text and on a different product mix**, as section 2 says.
- **The radar's false-alarm rate is an upper bound** (some unexplained episodes are real events), its
  Poisson interval is too narrow because series alarm together, and five events cannot rank rules.
- **The student-loan detection is generous to the rule.** Complaints rose from late August 2023; the
  naive rule fired on 4 Sep and the fixed scoring does not count an episode that opens before the
  event week.
- **The label-noise interval is too narrow** (13,109 complaints but only 1,900 distinct texts) and
  covers only the 12% of test complaints whose text repeats.
- **Whole-population rates** (17.5 million complaints) carry Wilson intervals for form; they are
  not sampling intervals and their width means nothing.

## 6. What this cannot show

- Complaints are not a random sample of problems, and narratives are the subset whose authors agreed
  to publish.
- Labels are chosen by the consumer. A "wrong" prediction is sometimes the better label.
- Complaint counts are not incident counts. Nothing here measures any company's conduct.
- United States consumer finance only.
- The 2026 test period is small and unusual. Results on it describe that period.
