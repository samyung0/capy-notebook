# Page and region prompt source review

Review date: 2026-09-16. Independent review of the same sixteen frozen textbook crops through DeepSeek `deepseek-flash`, with thinking disabled. This compares the developer's literal page/search prompt with the authorized crop-specific revision. The reviewer made no provider calls or code changes. The source gold and its two existing abstentions remain unchanged.

## Results

The literal prompt preserves the table contents well but loses grouping in a pendulum equation. The region revision repairs that equation and another nearby expression, but changes a velocity symbol from Latin `v` to Greek `ν`.

| Frozen source check | Prior DeepSeek transcription prompt | Literal page/search prompt | Revised region prompt |
| --- | ---: | ---: | ---: |
| Semantic mathematical checks | 57/57 | 56/57 | 57/57 |
| Correct values and row/column associations | 35/36 | 36/36 | 35/36 |
| Semantically complete tables | 5/6 | 6/6 | 5/6 |
| Neighboring text/caption anchors | 27/27 | 27/27 | 27/27 |

The literal arm scores 13/13 prior-known and 43/44 new-family mathematical checks. The region arm scores 13/13 and 44/44. HTML and LaTeX absence are not failures in the literal arm. Unicode superscripts, plain text and Markdown count when they preserve the source meaning and associations. The region arm asks for explicit LaTeX grouping, but neither arm requires HTML tables.

The six-table metric covers the frozen headers, labels, values and associations. It does not certify every sentence or neighboring equation inside each crop. One such additional equation is wrong in the literal arm, described below. Neither prompt requests a confidence score or uncertainty array; their absence is not an assertion of certainty.

## Concrete source differences

### Lost square-root scope in the literal prompt

The source pendulum equation is:

```latex
p = \ell^{1/2}g^{-1/2} \cdot \hat{f}(\theta)
  = \sqrt{\ell/g} \cdot \hat{f}(\theta)
```

The literal prompt returns:

```text
p = ℓ¹/²g⁻¹/² · f̂(θ) = √ℓ/g · f̂(θ)
```

The source radical covers the ratio `ℓ/g`. The output provides no grouping around that ratio, leaving `√ℓ/g`. The half-power notation also loses explicit exponent grouping around the slash. The complete pinned equation therefore fails; a reviewer must not infer the missing scope from their physics knowledge. The separate `f̂(θ) = 2π` check passes.

The revised region prompt returns `\sqrt{\ell/g}` and grouped half powers. Both pinned checks pass.

### Damaged neighboring exponent indices outside the frozen score

The prose after the pendulum table contains:

```latex
p^{p_1}\ell^{p_2}m^{p_3}g^{p_4}\theta^{p_5}
```

The literal output is `pᴾ¹ℓᴾ²mᴾ³gᴾ⁴θᴾ⁵`. It changes the lowercase exponent variable to modifier capital P, U+1D3E, and loses the nested subscript indices. Source PDF font positions confirm the small indices sit below the exponent's lowercase p. This is an additional mathematical failure, outside the frozen 57 checks.

The region revision preserves the lowercase p and subscript indices in LaTeX. Its nearby clipped phrase, `To use the second fact, to find which`, remains clipped in both arms; neither invents its continuation.

### Velocity symbol improves, then regresses

The source wave-table label is Latin `v`, confirmed by the frozen gold, original crop and PDF text. The literal page arm correctly emits `velocity of the wave v`. The revised region arm emits `velocity of the wave \(\nu\)` instead. Its dimensional formula is correct, but the row-label symbol is not. That cell fails the association check and makes the region arm's wave table incomplete.

The literal arm therefore improves this case over the earlier DeepSeek transcription run; the region revision reintroduces its error. A stronger instruction does not guarantee that every symbol will be preserved on a fresh generation.

### Tables and printed source mistakes

Both arms preserve the LSJ regression table's two response dimensions and all four beta expressions. The literal arm uses plain-text rows; the region arm uses Markdown columns. The `read textbook` grouping label, column responses and attendance row responses remain identifiable. No HTML or exact row-span encoding penalty is applied.

Both also retain the AHSS textbook's printed equations, including the inconsistent coefficients `0.0431` and `0.431` and printed result `-18.8`. Neither silently corrects the source. Both preserve the OS4 example-ending line, all scored neighboring anchors, prose hats and the checked conditions in the Exo7 definition and inverse-function crops. No substantive prose omission or paraphrase was identified in these inspected crops. Minor typography changes and the omitted final period after the LSJ prose do not change the scored facts.

## Generated image captions

The developer's prompt explicitly asks for brief image captions, so new caption sentences are assessed against the pictures rather than treated as forbidden additions.

Both arms correctly describe the pendulum's horizontal support, string and bob. Both identify the two differently sized bodies and dotted line in the orbit illustration. The literal arm adds `representing mean separation`. That interpretation is plausible from the adjacent table, but it is not an explicit label on the depicted line. It is not scored as a false mathematical fact; it is a generated interpretation worth distinguishing from exact source text.

The revised arm omits that interpretation and describes only the visible bodies and dotted line. No invented numerical measurement, solved result or substantive new scientific claim was identified in either arm.

## Evidence and timing

Every request contains one user message with the corresponding prompt verbatim and no added system message. All thirty-two image payloads match the original crop PNG bytes. Frozen case objects, input hashes, source-input hashes, raw response text, result text and transcript files were independently checked. All requests completed, and none of the decoded outputs contains an unexpected control character.

| Receipt measure | Literal page prompt | Region revision |
| --- | ---: | ---: |
| Calls | 16 | 16 |
| Client command duration | 7.05 s | 6.33 s |
| Summed individual request time | 22.12 s | 22.87 s |
| Input tokens | 5,003 | 5,995 |
| Output tokens | 1,852 | 2,086 |
| Reported cached input tokens | 0 | 512 |
| Reported reasoning tokens | 0 | 0 |

Both used four workers. These are single runs, with different prompts and some caching in the region arm. The timing difference does not establish a repeatable speed advantage.

Results and the per-case audit are under `bench/parsers/reports/local/2026-09-16-selective-recovery/r2/`:

- Literal results: `deepseek-page-prompt/crops/results.json`, SHA256 `b907194e51cf534b18d60095109b781535ab6e99755c3a501bb7200bad554a71`.
- Region results: `deepseek-region-prompt/crops/results.json`, SHA256 `6fce0b38ad0a549bfc4f1e9e6b0fefc8ecbd97ff23aad4ead939f31c6ce6ce95`.
- Source judgments: `page-prompt-source-review.json`.

The region instruction resolves the observed grouping and exponent-index failures, and its captions stay closer to visible content. The remaining symbol substitution shows why these results support source checks rather than automatic replacement without review. This report covers crops only; it does not score the separate full-page experiment or demonstrate downstream retrieval quality.
