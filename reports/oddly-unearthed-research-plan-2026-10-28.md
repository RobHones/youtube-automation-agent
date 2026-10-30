# Automatic research for Oddly Unearthed

28 October 2026. Recommendation and feasibility trial.

> **Status update (later the same day):** the proposed workflow has since been implemented: `utils/research-service.js`, `utils/research-contract.js`, the `research` and `research_audit` generation stages, and approval/upload gates. Fixture tests cover copied sources, conflicting dates, compound claims, retrieval failures, omitted text and edits after verification. A live end-to-end researched episode and the multi-topic trial have not been run yet. See [docs/providers.md](../docs/providers.md#research).

**Recommendation:** research the available evidence before selecting and writing each documentary. Use a dedicated research worker through the existing ChatGPT subscription, then a separate audit of the finished script. Populate the Evidence desk automatically and ask the operator to handle only unresolved exceptions and the final editorial approval.

## Channel brief

- Name: Oddly Unearthed
- Preferred handle: @OddlyUnearthed; backup: @OddlyUnearthedTV. Availability has not been checked.
- Tagline: Strange stories. Real history.
- Subject: forgotten inventions, abandoned megaprojects, ambitious failures, and overlooked historical stories told as short documentaries.

## What works today

The app already stores sources and factual claims and blocks unresolved provenance. Its topic research mostly gathers YouTube trend and competitor metadata. It does not retrieve historical evidence. Manual generation ordinarily begins with no supplied sources.

The subscription adapter intentionally disables search and tells the model not to use tools. Those defaults are appropriate for its existing text-only role. Add a separate research mode rather than changing every writing request.

The present evidence check validates source/claim links and reviewer statuses, rather than checking whether an actual passage supports the exact statement. A missing claim list is treated as not requiring review. The introduction template also invents first-person credibility statements, such as personal research experience. Both gaps must be addressed before relying on automatic factual checks.

## Feasibility established

A small live trial used the existing ChatGPT subscription login with Codex, live web search enabled, shell tools disabled, a read-only sandbox, and an isolated temporary working directory. API authentication overrides were removed from the child environment. No additional research-service credential was used.

For the Crystal Palace pneumatic railway, it searched, opened pages, and returned three candidate claims with source references, short supporting passages, and unresolved details. The JSON transcript records two completed search actions and an additional retrieval event opening three pages; six web events includes started/completed pairs, not six separate searches.

The resulting sources included a [Railway & Canal Historical Society paper](https://rchs.org.uk/wp-content/uploads/2021/05/7-019-Capsule-Pipelines.pdf) and [Subterranea Britannica's account](https://www.subbrit.org.uk/sites/crystal-palace-pneumatic-railway/). These support a documented 1864 experiment, but do not establish every operating detail. The latter explicitly says the precise tunnel route is unrecorded. The worker preserved that uncertainty.

A page opened during the trial, independently inspected afterward, also provides a contemporary illustration reference: [Dickinson College's archival record](https://hd.housedivided.dickinson.edu/node/43346) identifies an engraving in Frank Leslie's Illustrated Newspaper, 8 October 1864, page 44. This is a useful research lead; a catalogue description and an artist's impression alone cannot validate engineering performance.

This demonstrates that subscription-based retrieval is available in this environment. It does not establish reliable unattended production, independent corroboration, complete claim coverage, or throughput at the intended publishing cadence. The three draft claims are research output, not publication approval. The trial also needs an output validator: one claim combined mechanism and station locations while supplying a passage for only the mechanism.

Trial data: [oddly-unearthed-research-trial-2026-10-28.json](oddly-unearthed-research-trial-2026-10-28.json).

## Proposed workflow

1. **Find stories with enough evidence.** Generate candidate topics, then check source availability before committing to one. Prefer museums, archives, patents, contemporary engineering reports, parliamentary records, and reputable historical scholarship. Choose a different candidate when evidence is too thin. Do not hand routine source hunting back to the operator.
2. **Build a fact pack.** Retrieve pages or documents, not just search snippets. Save each narrowly worded claim with its source URL, publisher, source date where available, retrieval time, supporting passage, page/section location, and evidence hash. Record contradictions and the origins cited by secondary accounts. Keep short, relevant excerpts in the review UI.
3. **Write from that pack.** The writer can change structure and tone but may not add historical specifics without evidence. Distinguish proposed, advertised, built, tested, and operated. Attribute contemporary promotional claims instead of adopting them as proven performance. Preserve uncertainty in natural language.
4. **Audit the finished output.** A separate pass extracts claims from the complete narration, on-screen text, title, thumbnail wording, and description. Check dates, units, quantities, causal explanations, and whether every part of a compound claim is supported. The writer's own claim list is insufficient. A separate pass is a useful check, not a guarantee of independent judgment.
5. **Repair automatically within limits.** Search again, narrow the wording, remove a nonessential unsupported detail, or select another topic. After a bounded number of attempts, create a concise exception with the evidence and a proposed resolution. Complete these checks before spending on narration and visual generation.
6. **Show a ready-to-review documentary.** Attach the fact pack and source list automatically. Ordinary runs show a machine-checked research summary and the finished story. Only unresolved material claims need an operator decision. Keep final editorial approval and media-rights confirmation distinct from machine factual checking.

## Historical editorial rules

- An authoritative source must support the exact claim in context. Domain reputation alone is insufficient. Seek independent corroboration for surprising anecdotes, disputed firsts, dramatic numbers, and other central claims.
- Multiple pages copying the same unsourced account are one evidence chain. Follow citations to their origin where practical.
- Reconcile dates by event: design, proposal, construction, demonstration, opening, and closure. Never average conflicting dates or choose one silently.
- Do not invent dialogue, motives, witnesses, firsthand experience, or reasons for a project's failure. Label interpretations and reconstructions.
- Inaccessible evidence, poor OCR, contradictions, and unsuccessful searches remain explicit. Generated summaries and snippets alone do not establish support.
- A missing or incomplete audit cannot become a successful empty claim list. Source failure must not trigger an unsourced template fallback.
- Tie checks to the exact content revision and evidence. Factual edits invalidate the affected checks. Preserve who or what checked the evidence and when; distinguish machine checks from human review.

## Integration in this repository

| Location | Proposed change |
| --- | --- |
| `utils/subscription-text.js` | Add a dedicated research entry point with live search, JSON events and structured output; preserve the existing text-only defaults and process controls. |
| New `utils/research-service.js` | Retrieve and validate evidence, build the fact pack, audit and repair drafts, enforce limits and checkpoint results. |
| `index.js` generation stages | Run research after strategy; audit after writing and metadata generation, before paid media. Resume research from checkpoints. |
| `agents/script-writer-agent.js` | Write from fact IDs; remove fabricated credibility statements; block unsourced fallback for factual documentaries. |
| `utils/provenance-service.js` and database | Store evidence passages, provenance origins, audit coverage, revisions, machine-check status and unresolved exceptions. |
| Dashboard review and publishing checks | Populate sources automatically; show exceptions first; enforce matching, complete audits at approval and upload. |

Start with one episode through this path. Validate it against fixtures for copied sources, conflicting dates, omitted claims, compound claims, retrieval failure, and edits after verification. Then trial several different topics before enabling it for the daily schedule. Configure bounded research time, retries, and concurrency around observed subscription limits.

## Provider choice

Start with the existing subscription because the live test succeeded. Availability and account usage limits still apply; the test is not a promise of unlimited throughput. [Official OpenAI documentation](https://learn.chatgpt.com/docs/web-search) describes live search and search events in noninteractive JSON output.

Keep retrieval behind an adapter. If subscription limits or extraction coverage become a constraint, a later adapter can use [Gemini Search grounding](https://ai.google.dev/gemini-api/docs/google-search) plus [URL context](https://ai.google.dev/gemini-api/docs/url-context), or [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) plus [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract). Those routes require their own credentials and usage budget. Their citations still need the same evidence and coverage checks.
