# Complaint Radar

A bank's complaints team has two jobs: send each complaint to the right desk, and notice a new
problem before it becomes a flood. This project tests both on 17.5 million real complaints from the
US Consumer Financial Protection Bureau, and asks whether a large language model is worth its cost
against a small trained model.

The tests and their pass rules were written in [`ANALYSIS_PLAN.md`](ANALYSIS_PLAN.md) and committed
before any result existed. All three failed, and are reported as failed.

## The three answers

| | Question | Verdict |
|---|---|---|
| H1 | Is a language model (Llama 3.1 8B, run locally) more accurate than a TF-IDF + logistic regression router? | **FAIL, the other way.** On the same 3,300 complaints the small model scored macro-F1 0.656 against 0.617 (difference −0.038, 95% interval −0.056 to −0.021), and ran about 28,000 times faster |
| H2 | Can the small router send at least half of complaints to a desk automatically at 95% precision? | **FAIL.** It routed 63.6% (95% interval 63.3% to 63.9%) but at 88.8% precision (88.5% to 89.0%) on 2026 complaints |
| H3 | Does a seasonal control-chart rule catch five known events (Equifax breach, CARES Act, FTX, Silicon Valley Bank, student-loan restart) without crying wolf? | **FAIL.** It caught 1 of 5. It missed the Equifax spike by a hair: z = 4.78, then 2.97, against a rule that needs two weeks above 3 |

What went wrong, in short: the public complaint text almost disappears in 2026, so the test period's
product mix is nothing like the training period's, and a threshold tuned on 2025 sends too many
complaints to the credit-reporting desk. Product-level weekly counts barely moved for three of the
five events. Details, intervals and the limits an interviewer should raise are in
[`docs/FINDINGS.md`](docs/FINDINGS.md); a one-page note for a head of complaints is in
[`docs/MEMO.md`](docs/MEMO.md).

## What is in the repo

| Path | What it does |
|---|---|
| `extract/pull.py` | Downloads the CFPB Narratives Archive once (21 files, 1.43 GB) and writes Parquet plus `data/MANIFEST.json` |
| `scripts/profile_data.py` | The only look at the data before the plan: `docs/DATA_PROFILE.md` |
| `dbt/` | The SQL layer on DuckDB: staging, intermediate, 14 marts, the product mapping across three versions of the CFPB product list, the fixed samples, and the dbt tests |
| `scripts/reconcile.py` | Recomputes the main counts from the raw files with its own SQL: `docs/RECONCILIATION.md` |
| `analysis/stats_util.py` | Wilson and exact Poisson intervals, bootstrap metrics, paired bootstrap, calibration, routing threshold |
| `analysis/descriptive.py` | Volumes and rates: `artefacts/descriptive.json` |
| `analysis/router.py` | Majority, TF-IDF + logistic regression and MiniLM embeddings + logistic regression: `artefacts/router.json`, and the browser model `site/data/model.json` |
| `analysis/llm_run.py`, `analysis/llm_eval.py` | The local language model on a fixed sample (one-letter answer, probabilities from the first token): `artefacts/llm_predictions.csv`, `artefacts/llm_eval.json` |
| `analysis/radar.py`, `analysis/novelty.py` | The alarm rule, the naive rule, the event backtest and the text-novelty variant: `artefacts/radar.json` |
| `scripts/build_site.py`, `site/` | The static site, including a "Try it" page that runs the tested router in the browser |
| `tests/` | pytest: known-answer tests for the statistics, contract checks on every mart, browser-model parity |

## Reproduce

Needs Python 3.12, about 4 GB of disk and 16 GB of RAM. The language-model step also needs
[Ollama](https://ollama.com) with `llama3.1:8b` pulled.

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m extract.pull
.venv/bin/python -m scripts.profile_data
cd dbt && ../.venv/bin/dbt build --profiles-dir . && cd ..
.venv/bin/python -m scripts.reconcile
.venv/bin/python -m analysis.descriptive
.venv/bin/python -m analysis.router
.venv/bin/python -m analysis.novelty
.venv/bin/python -m analysis.radar
.venv/bin/python -m analysis.llm_run
.venv/bin/python -m analysis.llm_eval
.venv/bin/python -m scripts.build_site
.venv/bin/pytest
```

The full router run takes about two hours on an Apple M4 and the language-model run about five and a half (9,900 calls at about 2 seconds each).
Every result file regenerates byte-identically: bootstraps are seeded and sort their rows first.
`artefacts/llm_predictions.csv` is committed so the evaluation can be rerun without the model.

## Data

CFPB Consumer Complaint Database Narratives Archive (complaints received 1 Dec 2011 to 14 Aug 2026),
from the CFPB FOIA reading room. US government work, public domain. Personal details in the text are
masked by the CFPB as `XXXX`.

## What this cannot show

Complaints are not a random sample of problems, and narratives are only those the consumer agreed to
publish. Labels are chosen by the consumer. Complaint counts are not incident counts, and nothing here
measures any company's conduct. US consumer finance only.

Medhansh Shekhawat · [GitHub](https://github.com/Ghostboy789) · [LinkedIn](https://www.linkedin.com/in/medhansh-shekhawat/)
