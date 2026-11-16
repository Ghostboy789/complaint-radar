# Contracts

The exact shape of every table and result file. `tests/contracts.py` parses the mart tables in
this file and checks the Parquet files against them. Definitions live in `ANALYSIS_PLAN.md`.

## Raw Parquet (`data/parquet/complaints_NN.parquet`)

All columns are text: `date_received`, `product`, `sub_product`, `issue`, `sub_issue`,
`narrative`, `company_public_response`, `company`, `state`, `zip_code`, `tags`, `submitted_via`,
`date_sent_to_company`, `company_response`, `timely_response`, `complaint_id`, `source_file`.
Dates are `YYYY-MM-DD`. A missing value is NULL.

## Seeds (`dbt/seeds/`)

- `product_map.csv`: `product`, `sub_product`, `product_group`. A row with `sub_product` = `*`
  is the default for that product; an exact sub-product row overrides it.
- `product_groups.csv`: `product_group`, `label`, `current_product`, `letter`, `in_radar`.
- `events.csv`: `event_id`, `event_date`, `product_group`, `title`.

## Marts (`marts_out/<name>.parquet`)

Column order and types are exact. A column is nullable only when its note starts with
"nullable".

### `fct_complaints`

One row per complaint. No narrative text.

| column | type | notes |
|---|---|---|
| complaint_id | BIGINT | unique |
| date_received | DATE | |
| week_start | DATE | Monday of the week of date_received |
| month_start | DATE | |
| year | INTEGER | |
| product | VARCHAR | as in the source |
| product_group | VARCHAR | one of the eleven groups |
| issue | VARCHAR | |
| company | VARCHAR | |
| state | VARCHAR | nullable |
| submitted_via | VARCHAR | |
| company_response | VARCHAR | |
| is_responded | BOOLEAN | company_response is not 'In progress' |
| is_timely | BOOLEAN | timely_response = 'Yes' |
| is_monetary_relief | BOOLEAN | company_response = 'Closed with monetary relief' |
| is_any_relief | BOOLEAN | response is 'Closed with monetary relief', 'Closed with non-monetary relief' or 'Closed with relief' |
| has_narrative | BOOLEAN | narrative present and not blank |
| text_hash | VARCHAR | nullable; md5 of the normalised narrative |

### `dim_product_map`

One row per product and sub-product pair found in the data.

| column | type | notes |
|---|---|---|
| product | VARCHAR | |
| sub_product | VARCHAR | nullable |
| product_group | VARCHAR | |
| first_date | DATE | |
| last_date | DATE | |
| complaints | BIGINT | |
| with_narrative | BIGINT | |

### `dim_events`

| column | type | notes |
|---|---|---|
| event_id | VARCHAR | unique |
| event_date | DATE | |
| week_start | DATE | Monday of the event week |
| product_group | VARCHAR | |
| title | VARCHAR | |

### `mart_volume_monthly`

One row per month and product group that has complaints.

| column | type | notes |
|---|---|---|
| month_start | DATE | |
| product_group | VARCHAR | |
| complaints | BIGINT | |
| with_narrative | BIGINT | |
| responded | BIGINT | |
| timely | BIGINT | timely among responded |
| monetary_relief | BIGINT | |
| any_relief | BIGINT | |

### `mart_volume_cube`

One row per year, product group and company bucket that has complaints. The bucket is the
company name for the 20 companies with the most complaints overall, else 'All other companies'.

| column | type | notes |
|---|---|---|
| year | INTEGER | |
| product_group | VARCHAR | |
| company_bucket | VARCHAR | |
| complaints | BIGINT | |
| with_narrative | BIGINT | |
| responded | BIGINT | |
| timely | BIGINT | timely among responded |
| monetary_relief | BIGINT | |
| any_relief | BIGINT | |

### `mart_state_year`

| column | type | notes |
|---|---|---|
| state | VARCHAR | 'Unknown' when missing |
| year | INTEGER | |
| complaints | BIGINT | |

### `mart_response_mix`

| column | type | notes |
|---|---|---|
| year | INTEGER | |
| product_group | VARCHAR | |
| company_response | VARCHAR | |
| complaints | BIGINT | |

### `mart_weekly_product`

Full grid: every full week from 2011-12-05 to 2026-08-24 for all eleven groups, zeros filled.

| column | type | notes |
|---|---|---|
| week_start | DATE | |
| product_group | VARCHAR | |
| complaints | BIGINT | |
| with_narrative | BIGINT | |

### `mart_weekly_issue`

Full weeks only, rows with complaints only.

| column | type | notes |
|---|---|---|
| week_start | DATE | |
| product_group | VARCHAR | |
| issue | VARCHAR | |
| complaints | BIGINT | |

### `mart_text_repeats`

| column | type | notes |
|---|---|---|
| year | INTEGER | |
| product_group | VARCHAR | |
| with_narrative | BIGINT | |
| repeated_text | BIGINT | narratives whose text hash occurs more than once in the whole data |

### `mart_label_noise`

One row. Test-period complaints (2026-01-01 to 2026-06-30) with a narrative whose text hash is
shared by at least two test-period complaints.

| column | type | notes |
|---|---|---|
| complaints | BIGINT | |
| distinct_texts | BIGINT | |
| in_modal_product | BIGINT | complaints carrying the most common product of their text |

### `mart_router_samples`

The train sample, the validation sample and the whole test set (ANALYSIS_PLAN.md section 5).

| column | type | notes |
|---|---|---|
| complaint_id | BIGINT | unique |
| split | VARCHAR | 'train', 'validation' or 'test' |
| date_received | DATE | |
| product | VARCHAR | one of the eleven current products |
| issue | VARCHAR | |
| text_hash | VARCHAR | |
| is_new_text | BOOLEAN | test rows: hash not in any complaint received before 2026-01-01; false for other splits |
| narrative | VARCHAR | |

### `mart_llm_samples`

The fixed samples of ANALYSIS_PLAN.md section 6.

| column | type | notes |
|---|---|---|
| complaint_id | BIGINT | unique |
| role | VARCHAR | 'test', 'validation' or 'fewshot' |
| product | VARCHAR | |
| text_hash | VARCHAR | |
| narrative | VARCHAR | |

### `mart_novelty_sample`

Up to 100 narratives per full week and product group, for the five event product groups, weeks
from 2015-03-23.

| column | type | notes |
|---|---|---|
| complaint_id | BIGINT | unique |
| week_start | DATE | |
| product_group | VARCHAR | |
| narrative | VARCHAR | |

## Result files (`artefacts/`)

**NUM** is `{"value": float|null, "ci_low": float|null, "ci_high": float|null, "n": int|null}`
(made by `analysis.stats_util.num`). JSON is written with `indent=1`, keys in the order shown,
and a trailing newline. Product lists are always in the order of `product_groups.csv`.

### `descriptive.json`

```
{"totals": {"complaints": int, "with_narrative": int, "first_date": str, "last_date": str,
            "companies": int, "narrative_share": NUM, "timely_rate": NUM,
            "monetary_relief_rate": NUM, "any_relief_rate": NUM},
 "by_year": [{"year": int, "complaints": int, "with_narrative": int, "narrative_share": NUM,
              "timely_rate": NUM, "monetary_relief_rate": NUM}],
 "by_product_group": [{"product_group": str, "label": str, "complaints": int,
                       "with_narrative": int, "narrative_share": NUM, "timely_rate": NUM,
                       "monetary_relief_rate": NUM, "any_relief_rate": NUM}],
 "top_companies": [{"company": str, "complaints": int, "share": float, "timely_rate": NUM,
                    "monetary_relief_rate": NUM}],
 "response_mix": [{"company_response": str, "complaints": int, "share": float}],
 "repeats": [{"year": int, "with_narrative": int, "repeated_share": NUM}],
 "label_noise": {"complaints": int, "distinct_texts": int, "modal_share": NUM},
 "taxonomy": [{"product": str, "sub_product": str|null, "product_group": str,
               "first_date": str, "last_date": str, "complaints": int}]}
```

Rates use responded complaints as the denominator. `top_companies` has the 20 buckets of
`mart_volume_cube` without 'All other companies', most complaints first.

### `router.json`

```
{"products": [str x 11],
 "split": {"train": {"from": str, "to": str, "rows": int},
           "validation": {...}, "test": {"from": str, "to": str, "rows": int, "new_text_rows": int}},
 "class_counts": [{"product": str, "train": int, "validation": int, "test": int,
                   "test_new_text": int, "in_macro_f1": bool}],
 "models": {"majority" | "words" | "embeddings": {
     "c": float|null, "validation_macro_f1": float,
     "test": METRICS, "test_new_text": METRICS,
     "auto_route": {"threshold": float|null, "validation_precision": float|null,
                    "test": ROUTE, "test_new_text": ROUTE,
                    "by_product": [{"product": str, "coverage": NUM, "precision": NUM}]}}},
 "h2": {"model": "words", "coverage": NUM, "precision": NUM, "pass": bool},
 "issue_within_product": [{"product": str, "issues": int, "train_rows": int, "test_rows": int,
                           "majority_accuracy": NUM, "words_accuracy": NUM,
                           "words_macro_f1": NUM}]}
```

`METRICS` = `{"macro_f1": NUM, "accuracy": NUM, "ece": float, "per_product": [{"product": str,
"precision": float, "recall": float, "f1": float, "n": int}], "reliability": [{"bin_low": float,
"bin_high": float, "n": int, "mean_confidence": float, "accuracy": float}],
"confusion": [[int x 11] x 11]}` with rows = true product.
`ROUTE` = `{"coverage": NUM, "precision": NUM}`.

### `timings.json`

`{"words_seconds_per_1000": float, "embeddings_seconds_per_1000": float}`. Written only by
`python -m analysis.router --measure`; never rewritten by a normal run, so other files stay
byte-identical.

### `llm_predictions.csv`

One row per call, sorted by `variant`, `role`, `complaint_id`. Committed, because the run takes
hours and everything in `llm_eval.json` is computed from it.

`complaint_id`, `role` (`test`|`validation`), `variant` (`zero_shot`|`few_shot`), `p_a` ... `p_k`
(probabilities of the eleven letters, summing to 1, 6 places), `letter_mass` (total probability
of the eleven letters before normalising), `seconds`, `prompt_tokens`, `output_tokens`.

### `llm_eval.json`

```
{"model": "llama3.1:8b",
 "sample": {"test": int, "validation": int,
            "per_product": [{"product": str, "test": int, "validation": int}]},
 "variants": {"zero_shot" | "few_shot": {
     "validation_macro_f1": float, "test": METRICS,
     "auto_route": {"threshold": float|null, "validation_precision": float|null, "test": ROUTE},
     "seconds_per_1000": float, "prompt_tokens_per_1000": float,
     "output_tokens_per_1000": float, "mean_letter_mass": float}},
 "chosen_variant": str,
 "same_sample": {"majority" | "words" | "embeddings": {
     "macro_f1": NUM, "accuracy": NUM, "ece": float, "auto_route": ROUTE}},
 "h1": {"difference": NUM, "verdict": "llm_better" | "small_model_better" |
        "no_detectable_difference", "pass": bool}}
```

`same_sample` scores the section 5 models on the language model's test sample, with each model's
own threshold from `router.json`.

### `radar_weekly.csv` and `novelty_weekly.csv`

`radar_weekly.csv`: `week_start`, `product_group`, `complaints`, `z` (blank before monitoring
starts), `alarm` (0|1), `naive_alarm` (0|1). Ten radar groups, every full week.
`novelty_weekly.csv`: `week_start`, `product_group`, `narratives`, `mean_novelty`, `z`, `alarm`.

### `radar.json`

```
{"rule": {"level_weeks": 26, "scale_weeks": 52, "limit": 3, "consecutive": 2,
          "monitor_from_week": 131, "episode_gap_weeks": 4, "event_window_weeks": 8,
          "naive_ratio": 1.5},
 "weeks": {"first": str, "last": str, "n": int},
 "series": [{"product_group": str, "monitored_from": str, "series_years": float,
             "episodes": [EPISODE], "naive_episodes": [EPISODE]}],
 "events": [{"event_id": str, "title": str, "event_date": str, "week_start": str,
             "product_group": str, "detected": bool, "already_open": bool,
             "delay_weeks": int|null, "naive_detected": bool, "naive_delay_weeks": int|null,
             "lead_weeks_vs_naive": int|null}],
 "summary": {"events": int, "detected": int, "detection_rate": NUM, "unexplained_episodes": int,
             "series_years": float, "unexplained_per_series_year": NUM, "naive_detected": int,
             "naive_unexplained_episodes": int, "naive_unexplained_per_series_year": NUM},
 "h3": {"pass": bool},
 "novelty": {"series": [{"product_group": str, "monitored_from": str, "series_years": float,
                         "episodes": [EPISODE]}],
             "events": [{"event_id": str, "detected": bool, "already_open": bool,
                         "delay_weeks": int|null}],
             "unexplained_episodes": int, "unexplained_per_series_year": NUM}}
```

`EPISODE` = `{"start": str, "end": str, "alarm_weeks": int, "peak_z": float|null,
"event_id": str|null}`. `lead_weeks_vs_naive` = naive delay minus rule delay when both detect.
`series_years` = monitored weeks / 52.

### `site/data/model.json`

The words model, as run in the browser:
`{"products": [str x 11], "terms": [str], "idf": [float], "coef": [[float] x 11],
"intercept": [float x 11], "threshold": float|null}`. `coef` rows follow `products`, columns
follow `terms`, rounded to 4 places. Scoring: lower-case, tokens `[a-z0-9]{2,}`, one and two word
terms, tf = 1 + ln(count), times idf, L2 normalise, linear scores, softmax.
