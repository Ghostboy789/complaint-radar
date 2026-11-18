# Memo: what to automate in complaint handling

To: head of complaints. From: Medhansh Shekhawat. Based on 17.5 million US consumer complaints
(CFPB, Dec 2011 to Aug 2026). Every figure is from `docs/FINDINGS.md`, with its 95% interval there.

## Recommendation in one line

Use a small, cheap text model to **suggest** the desk for every complaint and to send only the clearest
cases automatically, re-checking its threshold every month. Do not pay for a large language model for
this job. Do not rely on complaint counts alone as an early warning.

## What to automate

- **A desk suggestion on every complaint.** A TF-IDF + logistic regression model put 76.5% of 2026
  complaints on the right desk out of eleven, scored 1,000 complaints in under a tenth of a second on a
  laptop, and its stated confidence matched how often it was right.
- **Automatic sending for the desks where it held up.** On 2026 complaints, automatically routed
  debt-collection, mortgage and student-loan complaints were 97% to 99% correct.

## What not to automate yet

- **Blanket automatic routing.** A threshold tuned to be 95% correct on 2025 complaints was 88.8% correct
  on 2026 complaints, because the mix of complaints changed sharply. Almost all of the damage came from
  one desk: complaints sent automatically to credit reporting were only 47% correct. A threshold set
  once and left alone will drift. Set it per desk, and re-check it on a fresh labelled sample each month (a
  remedy suggested by these results, not tested here).
- **A large language model as the router.** On the same 3,300 complaints, an 8-billion-parameter model
  run locally was less accurate than the small model (macro-F1 0.617 against 0.656), was overconfident,
  and took about 2 seconds per complaint against well under a millisecond. Paying more for less
  accuracy has no cost per point to justify it. A larger hosted model was not tested and might do
  better; test it on the same sample before buying.

## Early warning

A seasonal control chart on weekly complaint counts per product caught 1 of 5 known public events in a
backtest (it caught the 2023 student-loan restart; it missed the Equifax breach by a hair, and three
events barely showed in weekly product counts at all). It raised about one unexplained alarm per six
product-years, so it is quiet, but quiet is not useful if it is blind. Use it as one input, not as the
alarm: watch finer series (one company, one issue) and the text itself, and test those against a
longer list of events before trusting them.

## Caveats

Complaints are not incidents, and consumers choose the product label themselves. The 2026 test period is
unusual: the CFPB published far fewer complaint narratives, almost none about credit reporting. These
results describe that period and the public data, not any bank's own complaints.
