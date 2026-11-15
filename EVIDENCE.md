# How Granted is tested

Granted is an automated accessibility checker. This page says how we test it and lists every accuracy number we
publish. Each number names the run it comes from and its date. The same numbers are in [`evidence/`](evidence/) as
JSON. The test sites and their answer keys are public, so you can rerun the comparisons yourself:
[grnted-benchmark](https://github.com/grnted/grnted-benchmark).

**The headline is a blind test**: brand-new sites that no checker, Granted included, had seen or been tuned on.
Results on our own training sites come second, labelled as training.

## Words used here

- **Planted failure:** a WCAG 2.2 Level A or AA failure the site's builder put on a page on purpose and wrote in the
  answer key.
- **Planted pass:** a look-alike that meets the criterion. A checker that fails it is wrong.
- **Recall:** planted failures found, out of all planted failures. **Recall where tested** leaves out the criteria a
  checker never tests.
- **Precision:** of the failures a checker reported on keyed items, the share that were real.
- **False-alarm rate:** planted passes the checker failed, out of the planted passes on criteria it tests.
- **95% CI:** the two-sided 95% Wilson interval. **LB:** its lower end. Items on one page or one template are
  related, so the intervals describe these items, not all websites.

## 1. The blind test (the headline)

Sites 71 and 72 are a fire and EMS special district (an older Bootstrap and jQuery site) and a county housing
authority (a React-style component front end). An AI site builder made them on 2026-11-14. It was never told that
Granted or any other checker exists. Its brief: build realistic sites with the subtle, unintentional mistakes real
teams make, and write the answer key. Neither we nor any other tool had seen these sites before the test, let alone
been tuned on them.

<!-- evidence:blind-facts -->
- Built 2026-11-14; tested the same day (run `2026-11-14-blind-7172`).
- 59 pages, 797 scored items: 474 planted failures and 323 planted passes (look-alikes that meet the criterion). 2 debatable entries left out.
- Every one of the 55 WCAG 2.2 Level A and AA criteria has at least one planted failure.
- Status: final.
<!-- /evidence:blind-facts -->

We publish these two sites after the test, so anyone can rerun it. Our next blind tests use new sites that stay
unpublished until they have been tested.

### Eight checkers, the same pages, one rule

<!-- evidence:blind-h2h -->
| Checker | Version | Keyed criteria it tests | Recall overall [95% CI] | Recall where tested | Precision [95% CI] | False-alarm rate [95% CI] |
| --- | --- | --- | --- | --- | --- | --- |
| **Granted** | 0.3.0 (engine 8408cb4f) | 44 of 55 | 71.1% (337/474) [66.9–75.0] | 78.7% (337/428) [74.6–82.4] | 94.7% (337/356) [91.8–96.6] | 10.4% (19/182) [6.8–15.7] |
| axe-core | 4.14.0 | 22 of 55 | 30.4% (144/474) [26.4–34.7] | 51.4% (144/280) [45.6–57.2] | 100.0% (144/144) [97.4–100.0] | 0.0% (0/140) [0.0–2.7] |
| Pa11y (axe runner) | 10.0.0 (bundles axe-core 4.13.0) | 21 of 55 | 20.3% (96/474) [16.9–24.1] | 42.3% (96/227) [36.0–48.8] | 97.0% (96/99) [91.5–99.0] | 2.2% (3/137) [0.7–6.2] |
| Lighthouse | 13.6.0 | 17 of 55 | 34.8% (165/474) [30.7–39.2] | 70.5% (165/234) [64.4–76.0] | 100.0% (165/165) [97.7–100.0] | 0.0% (0/132) [0.0–2.8] |
| Pa11y (HTML_CodeSniffer runner) | 10.0.0 (HTML_CodeSniffer 2.6.0) | 48 of 55 | 18.4% (87/474) [15.1–22.1] | 22.3% (87/390) [18.5–26.7] | 96.7% (87/90) [90.7–98.9] | 1.1% (3/282) [0.4–3.1] |
| IBM Equal Access | accessibility-checker-engine 4.0.34 | 40 of 55 | 36.7% (174/474) [32.5–41.1] | 43.2% (174/403) [38.4–48.1] | 90.6% (174/192) [85.7–94.0] | 10.0% (18/180) [6.4–15.3] |
| Siteimprove Alfa | alfa-rules 0.120.0 (alfa-playwright 0.84.3) | 23 of 55 | 30.6% (145/474) [26.6–34.9] | 46.9% (145/309) [41.4–52.5] | 100.0% (145/145) [97.4–100.0] | 0.0% (0/86) [0.0–4.3] |
| QualWeb | core 0.9.5 (ACT rules 0.8.6, WCAG techniques 0.4.9) | 29 of 55 | 37.6% (178/474) [33.3–42.0] | 55.8% (178/319) [50.3–61.1] | 90.8% (178/196) [86.0–94.1] | 9.9% (18/182) [6.3–15.1] |
<!-- /evidence:blind-h2h -->

<!-- evidence:blind-settings -->
Every checker got the same 59 pages, one page at a time: a 1280 by 900 window, at most 4 minutes per page, Linux machines with 4 CPU cores and 6 GiB memory, Chromium from Playwright (build 1228) for every checker, and no network beyond the local site server. Run `2026-11-14-blind-7172`, 2026-11-14, Granted engine 8408cb4f.
<!-- /evidence:blind-settings -->

Each checker ran in its default configuration for WCAG 2.x A and AA, untuned. Granted ran its default core tests,
one page per scan, with no AI. The scoring rule is under [How we count](#how-we-count).

What it says:

<!-- evidence:blind-reading -->
- Granted found 71.1% of the planted failures. The next checker, QualWeb, found 37.6%: Granted found 1.9 times as many.
- axe-core, Lighthouse and Siteimprove Alfa made no false alarms here: 100% precision. Granted's precision is 94.7%: 19 of its 356 failures on keyed items were planted passes, a false-alarm rate of 10.4%.
- Of the 159 more planted failures Granted found than QualWeb, 124 only show when someone uses the page (keyboard, hover, zoom, waiting, motion). On those, Granted found 66.5% (145/218); the best of the others, QualWeb, found 9.6%; axe-core, Lighthouse, Pa11y (HTML_CodeSniffer runner) and Siteimprove Alfa found none.
- On failures visible in the page as loaded, Granted found 75.0% and the others 34.0% to 67.6%.
- Every checker scanned every page (no page failed for any checker).
<!-- /evidence:blind-reading -->

Failures visible in the page as loaded, and failures that only show when someone uses the page:

<!-- evidence:blind-split -->
| Checker | Visible as loaded: recall | Visible as loaded: false alarms | Needs interaction: recall | Needs interaction: false alarms |
| --- | --- | --- | --- | --- |
| Granted | 75.0% (192/256) | 21.9% (16/73) | 66.5% (145/218) | 2.8% (3/109) |
| axe-core | 56.3% (144/256) | 0.0% (0/66) | 0.0% (0/218) | 0.0% (0/74) |
| Pa11y (axe runner) | 35.5% (91/256) | 4.8% (3/63) | 2.3% (5/218) | 0.0% (0/74) |
| Lighthouse | 64.5% (165/256) | 0.0% (0/64) | 0.0% (0/218) | 0.0% (0/68) |
| Pa11y (HTML_CodeSniffer runner) | 34.0% (87/256) | 1.1% (2/176) | 0.0% (0/218) | 0.9% (1/106) |
| IBM Equal Access | 67.6% (173/256) | 24.0% (18/75) | 0.5% (1/218) | 0.0% (0/105) |
| Siteimprove Alfa | 56.6% (145/256) | 0.0% (0/64) | 0.0% (0/218) | 0.0% (0/22) |
| QualWeb | 61.3% (157/256) | 18.6% (16/86) | 9.6% (21/218) | 2.1% (2/96) |
<!-- /evidence:blind-split -->

### Granted's normal scan on the blind sites, AI off and AI on

Granted normally scans a whole site, and a paid scan adds an AI review. No other checker here scans a whole site, so
these rows are not part of the comparison above. Scored with the same per-item rule as the head-to-head:

<!-- evidence:blind-whole-site -->
| Granted 0.3.0, normal whole-site scan | Run | Recall overall [95% CI] | Precision [95% CI] | False-alarm rate [95% CI] |
| --- | --- | --- | --- | --- |
| whole-site crawl from the home page, AI off | `2026-11-14-8408cb4f-rt7172` | 66.0% (313/474) [61.7–70.2] | 82.2% (313/381) [78.0–85.7] | 21.3% (68/319) [17.2–26.1] |
| whole-site scan of the keyed page list, AI off | `2026-11-14-8408cb4f-rt7172` | 78.5% (372/474) [74.6–81.9] | 84.4% (372/441) [80.7–87.4] | 21.6% (69/319) [17.5–26.5] |
| whole-site crawl from the home page, AI on | `2026-11-14-8408cb4f-rt7172-ai` | 69.8% (331/474) [65.6–73.8] | 81.7% (331/405) [77.7–85.2] | 23.0% (74/322) [18.7–27.9] |
<!-- /evidence:blind-whole-site -->

Our own test scorer (the one our release checks use) counts the same scans differently: the four site-wide criteria
(2.4.5, 3.2.3, 3.2.4, 3.2.6) once per site rather than once per page, and a problem inside a linked document once
per document. So its numbers differ from the per-item rule's:

<!-- evidence:blind-own-scorer -->
| Granted 0.3.0, our test scorer | Run | Recall (k/n; LB) | Precision (k/n; LB) | False-alarm rate (k/n; LB) |
| --- | --- | --- | --- | --- |
| Crawl from the home page, AI off | `2026-11-14-8408cb4f-rt7172` | 73.6% (327/444; LB 69.4%) | 94.5% (327/346; LB 91.6%) | 9.9% (19/191; LB 6.5%) |
| Keyed page list, AI off | `2026-11-14-8408cb4f-rt7172` | 76.8% (341/444; LB 72.7%) | 94.5% (341/361; LB 91.6%) | 10.5% (20/191; LB 6.9%) |
| Crawl from the home page, AI on | `2026-11-14-8408cb4f-rt7172-ai` | 77.7% (345/444; LB 73.6%) | 93.2% (345/370; LB 90.2%) | 13.1% (25/191; LB 9.0%) |
| Site 71 only: crawl, AI off | `2026-11-14-8408cb4f-rt7172` | 76.7% (165/215; LB 70.7%) | 95.9% (165/172; LB 91.8%) | 6.7% (7/104; LB 3.3%) |
| Site 72 only: crawl, AI off | `2026-11-14-8408cb4f-rt7172` | 70.7% (162/229; LB 64.5%) | 93.1% (162/174; LB 88.3%) | 13.8% (12/87; LB 8.1%) |
| Site 71 only: crawl, AI on | `2026-11-14-8408cb4f-rt7172-ai` | 80.9% (174/215; LB 75.2%) | 94.6% (174/184; LB 90.3%) | 9.6% (10/104; LB 5.3%) |
| Site 72 only: crawl, AI on | `2026-11-14-8408cb4f-rt7172-ai` | 74.7% (171/229; LB 68.7%) | 91.9% (171/186; LB 87.1%) | 17.2% (15/87; LB 10.7%) |
<!-- /evidence:blind-own-scorer -->

<!-- evidence:blind-ai -->
With the AI review on, Granted's crawl found more failures and made more false alarms:

- Same rule as the head-to-head: recall 66.0% with AI off and 69.8% with AI on; precision 82.2% and 81.7%; false alarms 21.3% and 23.0%.
- Our test scorer: recall 73.6% and 77.7%; precision 94.5% and 93.2%; false alarms 9.9% and 13.1%.
<!-- /evidence:blind-ai -->

## 2. Our training sites (secondary)

Sites 01 to 08 are our training sites: eight invented public-agency sites (a city, a county, two school districts, a
water district, a transit agency, a parks district and a library). Each was built by an AI site builder to stress
one hard area: colour and contrast, keyboard and focus, documents and media, reflow and zoom, structure, live updates,
motion, and pop-ups and third-party widgets. The people building Granted could see these sites, and we tuned Granted
on them. Read these numbers as a training score, not as a fair comparison.

### Eight checkers on the training sites

<!-- evidence:training-h2h -->
Run `2026-11-14-train-030` (finished 2026-11-15, UTC), Granted engine 8408cb4f. 431 pages, 1,830 scored items (1,015 planted failures, 815 planted passes).

| Checker | Version | Keyed criteria it tests | Recall overall [95% CI] | Recall where tested | Precision [95% CI] | False-alarm rate [95% CI] |
| --- | --- | --- | --- | --- | --- | --- |
| **Granted** | engine 8408cb4f | 42 of 50 | 71.6% (727/1,015) [68.8–74.3] | 75.1% (727/968) [72.3–77.7] | 97.8% (727/743) [96.5–98.7] | 2.8% (16/577) [1.7–4.5] |
| axe-core | 4.14.0 | 21 of 50 | 11.7% (119/1,015) [9.9–13.8] | 18.5% (119/643) [15.7–21.7] | 96.0% (119/124) [90.9–98.3] | 1.3% (5/395) [0.5–2.9] |
| Pa11y (axe runner) | 10.0.0 (bundles axe-core 4.13.0) | 20 of 50 | 13.0% (132/1,015) [11.1–15.2] | 21.1% (132/625) [18.1–24.5] | 79.0% (132/167) [72.3–84.5] | 8.9% (35/393) [6.5–12.1] |
| Lighthouse | 13.6.0 | 17 of 50 | 14.9% (151/1,015) [12.8–17.2] | 31.4% (151/481) [27.4–35.7] | 96.8% (151/156) [92.7–98.6] | 1.6% (5/318) [0.7–3.6] |
| Pa11y (HTML_CodeSniffer runner) | 10.0.0 (HTML_CodeSniffer 2.6.0) | 43 of 50 | 10.9% (111/1,015) [9.2–13.0] | 11.4% (111/972) [9.6–13.6] | 89.5% (111/124) [82.9–93.8] | 1.8% (13/729) [1.0–3.0] |
| IBM Equal Access | accessibility-checker-engine 4.0.34 | 38 of 50 | 20.2% (205/1,015) [17.8–22.8] | 22.1% (205/927) [19.6–24.9] | 78.8% (205/260) [73.5–83.4] | 10.0% (55/551) [7.7–12.8] |
| Siteimprove Alfa | alfa-rules 0.120.0 (alfa-playwright 0.84.3) | 22 of 50 | 13.5% (137/1,015) [11.5–15.7] | 20.1% (137/682) [17.3–23.3] | 96.5% (137/142) [92.0–98.5] | 1.3% (5/379) [0.6–3.1] |
| QualWeb | core 0.9.5 (ACT rules 0.8.6, WCAG techniques 0.4.9) | 28 of 50 | 31.0% (315/1,015) [28.3–33.9] | 41.8% (315/753) [38.4–45.4] | 87.3% (315/361) [83.4–90.3] | 8.8% (46/521) [6.7–11.6] |

The same rule as the blind test: a 1280 by 900 window, at most 4 minutes per page, Linux machines with 4 CPU cores and 8 GiB memory, Chromium from Playwright (build 1228) for every checker, and no network beyond the local site server. No page failed for any checker.
<!-- /evidence:training-h2h -->

### Granted 0.3.0 and 0.2.1 on the training sites

Our test scorer, whole-site scans with the deep tests, AI off:

<!-- evidence:training-releases -->
| Release (whole-site scan, AI off) | Run | Recall (k/n; LB) | Precision (k/n; LB) | False-alarm rate (k/n; LB) |
| --- | --- | --- | --- | --- |
| Granted 0.3.0, crawl | `2026-11-14-8408cb4f` | 85.5% (868/1,015; LB 83.2%) | 99.8% (868/870; LB 99.2%) | 0.3% (2/615; LB 0.1%) |
| Granted 0.3.0, keyed page list | `2026-11-14-8408cb4f` | 86.3% (876/1,015; LB 84.1%) | 99.8% (876/878; LB 99.2%) | 0.3% (2/615; LB 0.1%) |
| Granted 0.2.1, crawl | `2026-11-12-19041198` | 68.0% (690/1,015; LB 65.0%) | 99.6% (690/693; LB 98.7%) | 0.5% (3/615; LB 0.2%) |
| Granted 0.2.1, keyed page list | `2026-11-12-19041198` | 69.6% (706/1,015; LB 66.7%) | 99.6% (706/709; LB 98.8%) | 0.5% (3/615; LB 0.2%) |
<!-- /evidence:training-releases -->

## 3. Real public websites (a pilot, AI-adjudicated)

Test sites are not the web. In a pilot, we froze 5 pages from each of 5 public agency websites, drawn at random from
the national school-district directory and the .gov domain list. They run on five different content-management
systems. We do not name them. Each page was captured once and replayed offline, so every checker saw the same copy.

The answer key is **AI-adjudicated, not certified by any human auditor**: two AI auditors keyed every page on their
own, an AI adjudicator ruled on every disagreement, every failure a checker reported that the key lacked was reviewed,
and a second adjudication produced key v2.

<!-- evidence:real-site -->
25 pages of 5 public agency websites (2 school districts, 2 cities or towns, 1 special district), 55 criteria per page. Key v2 (2026-11-14): 244 failing page-criterion units, 1,070 passing or not applicable, 61 "cannot tell" (left out).

| Checker (AI-adjudicated key v2, not human-certified) | Precision (k/n; LB) | Recall (k/n; LB) |
| --- | --- | --- |
| Granted 0.2.1 (released), AI off | 80.8% (122/151; LB 73.8%) | 50.0% (122/244; LB 43.8%) |
| Granted development build (batch 18), AI off | 76.3% (129/169; LB 69.4%) | 52.9% (129/244; LB 46.6%) |
| Granted development build (batch 18), AI on | 75.9% (123/162; LB 68.8%) | 50.4% (123/244; LB 44.2%) |
| Granted development build (batch 19 precision work, c34d3813), AI off | 88.2% (120/136; LB 81.7%) | 49.2% (120/244; LB 43.0%) |
| axe-core alone (its run inside a Granted scan, scored on its own) | 84.8% (56/66; LB 74.3%) | 23.0% (56/244; LB 18.1%) |

- Two AI auditors keyed the pages independently. On the first key they agreed on 92.1% of all units, but on only 68.6% of failures (kappa 0.65): two careful auditors disagree on about a third of real failures.
- Across the Granted builds above, precision on these real pages was 75.9% to 88.2% and recall 49.2% to 52.9%, both below Granted's blind-test numbers (94.7% and 71.1%). Against a key no human has certified, on 25 pages.
- The offline copy is faithful: 1,361 of 1,375 of Granted's page-criterion results (99.0%) were the same live and replayed.
<!-- /evidence:real-site -->

No real-site score of the released 0.3.0 engine is in this pack yet. 0.3.0 is built from batches 16 to 18 with
batch 19's precision work; the development builds above are the closest measured.

## 4. Every release

<!-- evidence:release -->
- **Release gate.** 13 test suites passed on 2026-11-14 (release commit 2419f6eee, engine 8408cb4f): notices, build, typecheck, engine, report, deliverables-report-mac, deliverables-delivery-mac, worker, worker-node, web, gold, hostedai, hostedgold.
- **Simulation labs.** 86 labs with 18,350 known-answer cases. 1,451 cases (7.9%) are still wrong and recorded as known misses. 0 regressions against each lab's saved record. 2 labs not run (code unchanged since 0.2.1); 16 labs have no saved record yet.
- **Identity check.** Every item of training sites 01-08 compared with the live 0.2.1: 3,674 items, 493 changed, all 493 explained one by one. Among them: 357 missed failures now caught, 2 false alarms removed, 0 new false alarms, 9 deliberate moves to Needs review.
- **Gold standard.** 377 reference scans re-run (batch 19): exact: only recorded changes.
<!-- /evidence:release -->

## 5. W3C ACT rules

The W3C's Accessibility Conformance Testing (ACT) rules come with test cases and their expected outcomes. We run the
checkers on the pinned test cases and judge, rule by rule, whether each one's results agree, the way the W3C's
implementation reports do. This is our own run, not yet submitted to the W3C. Lighthouse and the HTML_CodeSniffer
runner were not part of it.

<!-- evidence:act -->
58 ACT rules, 865 pinned test cases. Granted engine of 2026-11-11; the other checkers at the versions below.

| Checker | Consistent | Partially consistent | Blocked by a false alarm | Not detected |
| --- | --- | --- | --- | --- |
| Granted (core tests, engine 7dfaebac) | 33 | 5 | 6 | 14 |
| Granted (full tests, engine 7dfaebac) | 33 | 5 | 7 | 13 |
| axe-core | 23 | 2 | 5 | 28 |
| Siteimprove Alfa | 20 | 1 | 12 | 25 |
| QualWeb | 19 | 2 | 15 | 22 |
| IBM Equal Access | 9 | 0 | 22 | 27 |
| Pa11y (axe runner) | 19 | 1 | 11 | 27 |
<!-- /evidence:act -->

## How we count

An **item** is one answer-key entry: a page and a WCAG criterion, with an expected outcome.

- A planted failure is **found** when the checker reports a failure on that page for that criterion. Which criterion
  a finding belongs to is decided by the checker's **own** published mapping of its rules to WCAG criteria (for
  example, the WCAG tags on each axe-core rule), not by us.
- A planted pass is a **false alarm** when the checker reports a failure on that page for that criterion.
- Debatable entries are left out.
- A criterion a checker never tests, by its own mapping, is **not tested** for that checker. It counts in recall
  overall; it is left out of recall where tested and of the false-alarm rate.
- Only definite failures count. "Needs review", "incomplete", "potential" and "can't tell" never count, for any
  checker.
- A page a checker fails to scan is retried once. If it still fails, its planted failures count as misses.

## Limits

- **No answer key here is certified by human auditors.** The site builders wrote the test-site keys. The blind sites'
  keys had an independent second review before publication (a different AI model from the builder's, plus our own
  tool checks of every PDF, Office file and flashing video): 301 items audited, 1 changed to "debatable". The
  real-site key is AI-adjudicated.
- **The training sites are ours.** We built them to stress Granted and tuned Granted on them. That is why the blind
  test is the headline.
- **Small samples.** Two blind sites (59 pages), eight training sites, five real sites (25 pages). Read the
  intervals. Many items share a page or a template.
- **Page-level credit.** A finding counts when the checker fails the right criterion on the right page. It does not
  prove the checker found the exact planted element. This holds for every checker alike.
- **Media and interaction gaps.** Granted misses most on video and audio, and on failures that need a particular
  interaction (time limits, status messages, keyboard use of custom widgets). One page per scan, Granted runs its core
  tests; hover content (1.4.13) and flashing (2.3.1) are tested by the deep tests of a whole-site scan.

<!-- evidence:training-weak -->
Criteria where Granted (engine 8408cb4f, one page per scan, no AI, run `2026-11-14-train-030`) found fewer than half of at least 5 planted failures on the training sites:

| Criterion | Found | Tested by Granted per page |
| --- | --- | --- |
| 1.2.1 | 0 of 11 | yes |
| 1.2.2 | 1 of 22 | yes |
| 1.2.5 | 0 of 5 | yes |
| 1.4.5 | 0 of 11 | yes |
| 1.4.13 | 0 of 13 | no |
| 2.1.1 | 6 of 47 | yes |
| 2.1.2 | 3 of 8 | yes |
| 2.2.1 | 0 of 16 | yes |
| 2.3.1 | 0 of 20 | no |
| 2.4.3 | 2 of 8 | yes |
| 2.4.6 | 0 of 5 | yes |
| 2.4.11 | 4 of 11 | yes |
| 2.5.7 | 0 of 8 | no |
| 3.2.2 | 0 of 6 | yes |
| 4.1.3 | 4 of 48 | yes |
<!-- /evidence:training-weak -->

- **Defaults, one page at a time, one point in time.** Each checker ran in its default configuration. Some offer
  extra rule sets, paid services or manual review that could change their results. Criteria about consistency across
  pages cannot be judged from one page by any checker. Versions change, and results on other sites can differ.
- **The sites were made to test checkers.** The kinds of problems in them reflect what makes automated checking
  hard, which is the area Granted was designed for.

## The checkers compared

<!-- evidence:tools -->
| Checker | Version | How it was run |
| --- | --- | --- |
| Granted | 0.3.0 (engine 8408cb4f) | Its library call, as its command-line tool makes it: one page per scan, its default core tests, no AI. Results are its own per-criterion table. |
| axe-core (Deque) | 4.14.0 | `axe.run` with its defaults on the loaded page; violations only. |
| Pa11y (axe runner) | 10.0.0 (bundles axe-core 4.13.0) | Standard WCAG2AA; errors only (its default). |
| Lighthouse (Google) | 13.6.0 | The accessibility category only, desktop settings; an audit that scores 0 is a failure; each audit in its own process and browser. |
| Pa11y (HTML_CodeSniffer runner) | 10.0.0 (HTML_CodeSniffer 2.6.0) | Standard WCAG2AA; errors only (its default). |
| IBM Equal Access (IBM) | accessibility-checker-engine 4.0.34 | Ruleset IBM_Accessibility; only "violation" and "fail" results, the checker's default fail levels. |
| Siteimprove Alfa (Siteimprove) | alfa-rules 0.120.0 (alfa-playwright 0.84.3) | All stable rules; only "failed" outcomes. |
| QualWeb | core 0.9.5 (ACT rules 0.8.6, WCAG techniques 0.4.9) | ACT rules and WCAG techniques modules; only "failed" outcomes; one QualWeb instance per page. |
<!-- /evidence:tools -->

Every checker drove the same browser build. None was tuned for these sites.

## Rerun it

1. Get the benchmark: [grnted-benchmark](https://github.com/grnted/grnted-benchmark). It holds the training sites
   01 to 08 with their answer keys, and the blind sites 71 and 72 once published, with a scorer and a static server.
   Node 18 or later, nothing to install.
2. `node score.mjs --self-check` checks the scorer: a perfect checker built from the answer keys must score 100%
   recall, 100% precision and 0% false alarms.
3. `node serve.mjs` serves each site on this computer. Run any checker on every keyed page, write one line of
   findings per page, and score it with `node score.mjs --findings findings.jsonl`. The benchmark's README has the
   format.
4. On the blind head-to-head (`2026-11-14-blind-7172`) and on both training head-to-heads (`2026-11-14-train-030`
   and `2026-11-11-train`), the benchmark's scorer gives exactly the counts of our internal scorer for all eight
   checkers.
