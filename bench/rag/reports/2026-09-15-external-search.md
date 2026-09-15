# Cell mitosis: external search spot-check

Date: 2026-09-15. Alibaba Beijing workspace supplied by the developer; model `qwen3.5-plus`, Responses API. Credentials were entered through a hidden terminal prompt and are absent from saved records.

## Result

Alibaba's web search returned useful learning resources. Its image tool returned plausible candidates, but the model's final selection was unreliable and the image records lacked source-page and license metadata. Commons was the strongest starting point for reusable diagrams in this small sample. Openverse needed a more specific query to surface diagrams.

This is a one-topic spot-check, not a provider ranking. Alibaba includes model planning and answer generation; Commons and Openverse return raw search results. Timings are single HTTP request durations from this machine, with no repeated runs, cold-start control, or latency percentiles. The Alibaba model rewrote the requested queries. Brave and Tavily were not called because credentials were unavailable; the developer chose the APIs already available.

## Runs

| Run | Actual search or fetch | Seconds | Observed result |
| --- | --- | ---: | --- |
| Alibaba `web_search` | `cell mitosis high school educational explanation site:.edu OR site:.org OR site:.gov` | 10.352 | One search call; 9 source links; final answer selected 5 |
| Alibaba `web_search_image` | `cell mitosis labelled diagram stages high school` | 24.543 | One search call; 10 image records; final answer selected only one |
| Commons API | `cell mitosis` | 1.839 | First 10 results included cell-cycle and stage diagrams, micrographs, and a mitosis/meiosis comparison |
| Openverse API | `cell mitosis` | 10.936 | First 10 of 240 results; mostly microscopy, some unrelated content; 6 had noncommercial license variants |
| Openverse follow-up | `mitosis diagram` | 1.291 | First 10 of 25 results; 9 titles concerned mitosis/stages, one was an unrelated daisy photo |
| Alibaba `web_extractor` with required settings | PMC256985 article URL | 16.526 | HTTP 200 and completed tool call, but only a browser security-check page; no article evidence |

The Openverse follow-up is a different query, not a repeated latency measurement. Most of its diagram hits came from Commons, so these are overlapping collections.

## Text search

The five sources selected by Alibaba were Khan Academy's article and video, a PMC page titled `WWW.Cell Biology Education`, HHMI BioInteractive's Crash Course episode 29, and CK-12's mitosis/cytokinesis lesson. All five URLs were present in the structured search source list; the final answer did not invent additional links. This is useful discovery, but not all descriptions were verified against full page content. The PMC article could not be read through either Alibaba's extractor or the session browser tool. The Khan and CK-12 pages exposed no readable body to the session web reader.

The session's general web-search baseline returned NHGRI, Khan Academy, MedlinePlus, NHS genomics education, and other sources. Its image results included Pinterest, Quizlet, stock images, and AI-diagram sites. This baseline's underlying provider and API bill are not exposed; it must not be labelled as a Brave or Tavily benchmark. See [baseline URLs](2026-09-15-external-search/session-search-baseline.json).

## Alibaba image search

The raw image result schema was only `index`, `title`, and `url`. All 10 lacked an explicit original page URL, author, license, and dimensions.

| Rank | Result title/source | Bounded URL check |
| ---: | --- | --- |
| 1 | Khan Academy cell-cycle regulation | Image response |
| 2 | Stock-vector title, Pinterest CDN | Image response |
| 3 | Teachers Pay Teachers | Image response |
| 4 | Facebook-hosted mitosis observation | HTTP 200, but HTML |
| 5 | CK-12, tiny-thumbnail URL | HTTP 206, content type absent; not classified |
| 6 | Nature Scitable | HTTP 404 |
| 7 | Teacher's Weebly site | GIF response over HTTP |
| 8 | SciDraw AI telophase | Image response |
| 9 | Shutterstock | Image response |
| 10 | Arizona State University, Ask A Biologist | Image response |

These checks read at most 2 KiB per response. An image content type does not establish full-file integrity, accuracy, or reuse permission. See [checks](2026-09-15-external-search/alibaba-image-url-checks.json).

The final model answer claimed only one image was returned, despite the 10 records. It selected rank 8 and omitted the other candidates. I opened that image and ASU's image in a browser:

- [Selected SciDraw image](https://pub-8c0ddfa5c0454d40822bc9944fe6f303.r2.dev/seo/tools/mitosis-diagram/telophase.png): readable labels, but only telophase. The left `decondensing chromosomes` arrow points to a centriole outside the nucleus. This is an observed labelling defect, not a complete scientific review.
- [ASU image](https://askabiologist.asu.edu/sites/default/files/resources/articles/cells/Mitosis_Mysid_0.png): a readable overview of replication/division, but only 540 by 196 pixels and without individual mitotic stage labels.

This separates two findings: search found options; Qwen3.5-Plus's final response did not faithfully use the returned list. It does not establish how another Qwen model or another prompt would behave.

## Commons and Openverse metadata

Commons returned a license label for all 10 items and an explicit license URL for 7. Results included `Animal cell cycle-en.svg` and `Mitosis cells sequence English.svg` marked CC0, and `Mitosis Stages.svg` marked CC BY-SA 4.0. Some hits were partial diagrams or in another language. Metadata and source-page verification are still needed before reuse; discovery is not a scientific review.

Openverse supplied creators, landing pages, licenses, and image URLs. With the broad query, six of the ten results carried noncommercial license variants. The narrower `mitosis diagram` query yielded nine relevant-looking titles and one noncommercial daisy image. I did not visually verify all those images. Query specificity and license filtering matter; the two timings alone say nothing about relative steady-state speed.

## Extractor requirements and limitation

Two initial parameter probes returned HTTP 400:

1. With thinking disabled: `Normal mode does not support web_extractor. Please set enable_thinking to true.`
2. With thinking enabled and only the extractor offered: `The web_extractor tool must be executed with web_search tool.`

Offering both tools and enabling thinking succeeded. Only the extractor was actually called. It returned the PMC browser-check text, and the final model answer correctly reported that the requested article information was unavailable. A successful tool status therefore does not mean useful source content was retrieved. The [extractor documentation](https://www.alibabacloud.com/help/en/model-studio/web-extractor) describes these configuration requirements.

## Usage and cost

| Successful Alibaba request | Input tokens | Output tokens | Tool calls | Estimated USD |
| --- | ---: | ---: | --- | ---: |
| Web search | 1,576 | 454 | 1 web search | 0.00106700 |
| Image search | 2,571 | 373 | 1 text-to-image search | 0.00399229 |
| Extractor | 1,541 | 433 | 1 extractor, no web search | 0.00047512 |
| Total | 5,688 | 1,260 | 3 | 0.00553441 |

The image request reported 1,538 image input tokens. The extractor's output included 216 reasoning tokens. Estimates use published Beijing prices checked on 2026-09-15: [Qwen3.5-Plus](https://www.alibabacloud.com/help/en/model-studio/model-pricing), $0.115 per million input tokens and $0.688 per million output tokens; [web search](https://www.alibabacloud.com/help/en/model-studio/web-search), $0.573411 per 1,000 calls; [text-to-image search](https://www.alibabacloud.com/help/en/model-studio/web-search-image), $3.44 per 1,000 calls. The extractor tool itself is temporarily free. These are estimates from usage, not an inspected account bill, and exclude any account-specific terms or discounts. Failed parameter probes reported no usage.

## Recommendation

Prototype Alibaba web search as an evidence-discovery tool and consume its structured results directly. Use Commons or a license-filtered Openverse query for diagrams. If broader image search is added, verify content, dimensions, source page, and rights before selecting an asset. Do not use the model's image prose as the authoritative result list.

## Reproduction and records

[Runner](../scripts/compare_external_search.py) uses the Python standard library and prompts for the Alibaba key without echo. `--tool` can be repeated. Use `--thinking --tool web_extractor --tool web_search` for extraction. It makes one request per invocation without automatic retries. Complete prompts, model/tool parameters, timestamps, latency, usage, and provider responses are saved in the [raw-record directory](2026-09-15-external-search/). No private notebook content was sent.

Validation: live requests above; `pnpm run fmt:py`; targeted Ruff formatting/lint with `--isolated` because the repository configuration excludes this experiment path; CLI help and recorded-result consistency checks. No application behavior changed.
