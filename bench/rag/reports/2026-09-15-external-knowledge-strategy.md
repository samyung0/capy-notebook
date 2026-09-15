# External knowledge for Capy: live retrieval and a curated library

Research date: 2026-09-15. This is a proposal, not an adopted product policy or an implementation. It follows the [cell-mitosis API spot-check](2026-09-15-external-search.md). Three GPT-5.6 Sol agents at high reasoning researched scientific assets, broader visual collections, and educational text sources. Source claims below come from official documentation; documented API availability is distinguished from live tests.

For cross-book topic organization, duplicate handling, and workspace assembly, see the follow-up [topic knowledge-base research](2026-09-15-topic-knowledge-base.md).

## Recommendation

Make a curated corpus of licensed textbooks, including their figures, the primary source for curriculum topics it covers. Textbooks already connect explanations, figures, captions, examples, and exercises; ingesting these relationships is more useful than independently finding prose and images for each lesson. Use Wikipedia and external text/image search to extend coverage, clarify terminology, and obtain current or alternative material.

The developer's follow-up highlighted Open Textbooks for Hong Kong and CUHK's OER guide. This changes the recommended priority from a live-first prototype to textbook-corpus-first retrieval. It remains a proposal; no books have been ingested or production settings changed by this research.

The useful unit to store ahead of time is often a catalog record, not a full image or a fully embedded document. Conversely, a small licensed textbook collection can be worth ingesting completely because its chapters, exercises, and cross-references work together.

For approved textbooks, keep the complete source and ingest the useful body content and figure metadata ahead of time. Metadata-only discovery is for titles we have not selected and large external collections. Expand in batches by subject and coverage rather than setting an arbitrary permanent limit on the number of books.

## What happens when

| Material | Before a user asks | At question time | After use |
| --- | --- | --- | --- |
| Small scientific illustration collections with published downloads | Import permitted metadata and previews; import original SVGs where the collection is small and the publisher provides a suitable distribution | Search local titles, tags, descriptions, and license fields; inspect the best candidates | Preserve the selected original and its attribution with the lesson |
| Commons, Openverse, and large museum/space collections | Keep source-specific retrieval rules and optional curated topic subsets | Query APIs when the local collection lacks a suitable asset; apply supported license filters and inspect the selected original record | Cache useful records; retain the selected asset version if its terms permit |
| Wikipedia | Start with no full encyclopedia mirror; optionally seed a small set of frequently taught topics | Resolve the topic and language, retrieve relevant sections and source revision metadata | Cache source pages by identity and revision; keep the cited version for saved lessons |
| Selected open textbooks | Download published HTML/EPUB/PDF/source releases, check the particular edition and exceptions, and index approved chapters | Retrieve relevant passages, examples, and exercises locally | Refresh on new editions or material changes; preserve the lesson's cited edition |
| Textbook discovery catalogs | Import titles, subjects, descriptions, license metadata, and original publisher URLs | Find a suitable book and fetch approved content only if needed | Add frequently useful books to the curated collection |
| General web results from Alibaba or another search API | Keep no wholesale mirror | Discover missing or current information; read selected source pages when access and reuse terms permit | Retain only what the applicable terms allow; the search subscription does not grant rights to third-party content |

An external search is useful on a new topic, when existing evidence is insufficient, or when freshness matters. It should not be repeated simply because another user asks about the same stable concept. Cache source content and asset records, while generating the explanation for the current learner and question.

### What a useful catalog record contains

- Original provider and stable asset/page ID, canonical source URL, and content revision or release.
- Title, subject, creator-provided description/tags, language, and available format/dimensions.
- Asset type such as a labeled process diagram, photograph, microscope image, map, or individual component icon. These serve different teaching purposes.
- License and version, attribution parties and notices, source of that declaration, and the date checked.
- Preview/original URLs and a local file reference when the content is retained.
- For selected content, the source passage or figure caption and any modifications made by Capy.

Start with source-provided metadata. Generate additional descriptions only for selected assets or measured search failures. A model-generated caption is a retrieval aid, not evidence of scientific accuracy or licensing. Deduplicate by original identity first and by content hash when bytes are available; Openverse frequently indexes Commons and other collections we may also query directly.

## Text sources

### Hong Kong collections and textbook-first ingestion

[Open Textbooks for Hong Kong's tertiary catalog](https://www.opentextbooks.org.hk/tertiary-institutions) exposes downloadable PDFs and individual book license declarations. Two concrete candidates checked on 2026-09-15:

- [Concepts Of Biology](https://www.opentextbooks.org.hk/tertiary-institutions/39711), attributed to Samantha Fowle, Rebecca Roush, and James Wise, has a PDF link and a CC BY-SA 4.0 declaration for its selection/arrangement. The record is dated 2016. Check the actual downloaded edition and individual credits; current terms on another publisher's website are not sufficient evidence for the rights of this historical copy.
- [Database Design](https://www.opentextbooks.org.hk/tertiary-institutions/33150), by Adrienne Watt and Nelson Eng, has a PDF link and a CC BY-SA 4.0 declaration. It is a candidate for a computing corpus with diagrams and worked examples, pending inspection of the actual file.

The same catalog contains noncommercial titles, including its record for Think Python, so selection must use book/edition terms rather than the site's default footer. These checks establish accessible candidate records and published licenses, not completed PDF parsing, figure review, or legal clearance of every component.

The supplied [CUHK OER ebooks/textbooks guide](https://libguides.lib.cuhk.edu.hk/oer/ebooks-textbooks) returned HTTP 429 to the web reader. Its individual links were not verified in this turn. Treat the guide as a discovery lead and verify the original book records before import.

### Preserve text and figures together

The proposed ingest result needs both searchable passages and linked figure records:

1. Acquire an approved edition through a published download/export. Preserve its source URL, license/credits, edition, and content hash.
2. Parse chapters, section headings, paragraphs, figure numbers, existing captions, and figure files or page/region references. Prefer a structured source when available; the current PDF parser remains useful for published PDFs.
3. Chunk the text while preserving its section context. Index the author's captions and retain the links between figure references, nearby explanations, and figure records. Generated captions for every figure are unnecessary and would contradict the current ingest design.
4. Retain a durable original image or reliable page-crop reference for each reusable figure, together with the applicable credit/license and its source location. Excluded figures can remain referenced by source/page without becoming reusable export assets.
5. Retrieve relevant text with its associated figures. Inspect selected visuals at question time when necessary, then include approved assets and their attribution in the lesson or export.

The existing parser bundle includes image files and geometry; ingestion indexes parser captions/footnotes, and `capture_page` lets the model inspect a cited page or crop. Those capabilities are not yet a durable figure library or an export insertion contract. The specific addition is a reliable passage-to-figure link and reusable asset/rights records, not another general image-search system or a return to captioning every document figure. See the [current figure behavior](../../../openwiki/agentic-retrieval.md#figures-are-read-at-question-time-not-captioned).

Process each approved public edition once into the shared corpus, with private notebook scope remaining separate. Evaluate representative books before increasing batch size. Storage, parsing, and embedding costs can then be measured per actual book/page instead of treating this as an unbounded web crawl.

### Complementary sources

Wikipedia is a reasonable first source for introductory factual explanations, terminology, topic relationships, and multilingual coverage. It is not a ready-made curriculum: prerequisites, teaching order, exercises, and worked examples vary. Selective textbooks complement it. Wikipedia's [research guidance](https://en.wikipedia.org/wiki/Wikipedia:Researching_with_Wikipedia) likewise describes it as a starting point and notes uneven quality. User age or educational level is not a substitute for checking the particular evidence.

| Source | Content and rights | Proposed acquisition |
| --- | --- | --- |
| [Wikipedia](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use/en) | Text generally uses CC BY-SA 4.0, with attribution, modification notices, license notices, and ShareAlike for distributed adaptations. Individual images have separate rights; Wikipedia-local non-free media should not enter the reusable image catalog without independent clearance. | Live API search/read plus a revision-aware cache. Pre-ingest frequently used topic subsets only when demand or offline use justifies it. |
| [Wikibooks / Wikiversity](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use/en) | Selected mature books/courses can provide teaching structure. Verify project/page license, completeness, and each media item. The Wikimedia text reuse requirements generally apply. | Secondary priority; curate particular books rather than ingesting entire projects. |
| [BCcampus Open Collection](https://collection.bccampus.ca/) | Broad textbook discovery; many BCcampus-published books are CC BY 4.0, but the collection has mixed licenses. BCcampus [explicitly notes that images can differ from a book's license](https://open.bccampus.ca/help/). | Select commercially compatible titles and ingest published PDF/EPUB/HTML/XML exports where available. |
| [LibreTexts](https://libretexts.org/terms-conditions) | Broad textbook chapters, worked material, and exercises. Its terms defer to the license of each item. Books/pages and embedded figures can have different terms, including noncommercial restrictions. | Pre-ingest a reviewed book/page subset. No stable public content API contract was verified in this research. |
| [OpenStax](https://openstax.org/books/biology-2e/pages/preface) | Strong introductory pedagogy, but the current Biology 2e preface states CC BY-NC-SA 4.0 and requires permission for training or ingestion into LLM/generative-AI offerings. Current [commercial-use guidance](https://help.openstax.org/s/article/Commercial-use-under-the-Creative-Commons-License) also restricts commercial reuse. | Defer use through current downloads in Capy's generative retrieval until permission is resolved. Live retrieval does not avoid the stated ingestion restriction. Historical editions with independently established earlier licenses require separate assessment; this is not a claim that previously granted valid CC licenses disappear. |
| [MIT OpenCourseWare](https://ocw.mit.edu/pages/privacy-and-terms-of-use/) | Valuable university courses, notes, assignments, and exams. Current terms are CC BY-NC-SA 4.0 with a specific AI clause imposing noncommercial and ShareAlike conditions. Third-party content has exceptions. | Source links/discovery initially. Published course ZIPs exist, but their availability does not grant commercial reuse permission. |
| [OpenLearn](https://www.open.edu/openlearn/about-openlearn/frequently-asked-questions-on-openlearn) | Guided self-study, activities, and downloadable formats. Courses commonly use noncommercial ShareAlike licenses, with third-party exclusions in acknowledgements. | Source links/discovery initially; a commercial reusable corpus needs separately compatible rights. |

### Wikipedia retrieval details

The [MediaWiki REST API](https://www.mediawiki.org/wiki/API:REST_API/Reference) provides search and page content. A suitable route is search, resolve a page, retrieve its metadata/revision, then read its HTML. The [Action API](https://www.mediawiki.org/wiki/API:Main_page) also supplies search, redirects, page metadata, revisions, and parsing operations. Use the API rather than extracting a search engine's snippet as if it were the article.

The text-source research agent made a bounded live REST check on 2026-09-15: search for `mitosis` returned page ID `20369`; the bare page endpoint returned revision `1371936568`, timestamp dated 2026-08-29, CC BY-SA 4.0 metadata, and an HTML URL. This verifies search and revision/license metadata retrieval, not a full article-ingestion or answer-quality benchmark. Other newly listed providers were researched through documentation rather than benchmarked end to end.

Keep page ID, title, language, canonical URL, revision ID/timestamp, retrieval time, license, and required attribution notices. A URL to the original article can supply attribution under Wikimedia's terms, but the license and modification requirements still apply. A cited external paper is a separate source with its own access and reuse terms. For genuinely large imports, use Wikimedia's [published dumps](https://meta.wikimedia.org/wiki/Data_dumps/What%27s_available_for_download) instead of crawling millions of pages. Follow the current [robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy) and [API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines).

### Textbook discovery and two additional text sources

| Source | Verified access and rights | Proposed role |
| --- | --- | --- |
| [Open Textbook Library](https://open.umn.edu/opentextbooks/discovery) | Catalog records are CC0. Published CSV/MARC batches, JSON resources through the `.json` extension, and RSS/Atom feeds support discovery. These are catalog records; each linked book has its own license. | Import catalog metadata first, then curate approved textbooks by subject and demand. |
| [OpenIntro](https://www.openintro.org/license/) | Most resources, including statistics textbooks, use CC BY-SA 3.0. File-specific licenses, teacher-only materials, partner books, branding, and third-party images have exceptions. Published downloads/source repositories are preferable to crawling its website. | A useful candidate for a deliberately selected statistics teaching corpus. Preserve the exact edition and adaptation/attribution requirements. |
| [Open Logic Project](https://openlogicproject.org/download/) | Provides section/chapter/book PDFs and a GitHub source repository. Default CC BY 4.0, except where noted. | Pre-ingest selected logic texts if philosophy or computer science is in scope. Its [main text starts at an intermediate level](https://openlogicproject.org/about/), so select an appropriate book for the learner. |

The [Open Textbook Library FAQ](https://open.umn.edu/opentextbooks/faq) describes it as a directory pointing to authors and publishers. A catalog's open license must not be applied to every linked book or figure.

## Visual source shortlist

### Scientific illustrations and components

| Source | Useful content and rights | Access and proposed acquisition |
| --- | --- | --- |
| [Bioicons](https://bioicons.com/) | Biology/chemistry/lab SVG components. Per-icon CC0, CC BY, CC BY-SA, MIT, or BSD terms; retain required notices and exclude or separately handle branded marks. | Its [GitHub repository](https://github.com/duerrsimon/bioicons) publishes SVGs and `static/icons/icons.json` with name/category/license/author. Strong first pre-import candidate: pin a repository version and index permitted icons locally. |
| [PhyloPic](https://www.phylopic.org/articles/image-usage) | Organism silhouettes linked to taxonomy. Per-image public-domain/CC licenses include noncommercial variants, so filter them. These are diagram components, not complete lessons. | [Documented API recipes](https://www.phylopic.org/articles/api-recipes) cover taxon search, image metadata, attribution, licenses, thumbnails, and vectors. Use live queries and cache selected metadata/files; respect published build/version identifiers. |
| [SciDraw, scidraw.io](https://scidraw.io/terms) | Scientist-contributed organisms, cells, anatomy, and experimental drawings. Current terms allow CC BY 4.0 or CC0 per item; the older general licensing page describes CC BY 4.0. Keep the actual item declaration. | The site has JSON routes, but no supported public API contract or bulk distribution was verified. Start with selected imports; assess access terms and stability before depending on those endpoints. This is distinct from `sci-draw.com`, the AI service returned in the earlier test. |
| [Servier Medical Art](https://smart.servier.com/how-to-cite-servier-medical-art/) | Medical illustrations are CC BY 4.0; website text, layout, logos, and other site materials are excluded. | [Official image kits](https://smart.servier.com/image-kits-by-category/) provide PowerPoint sets. Obtain the published packs through the supported download workflow and index their illustrations locally. [Terms prohibit automated site scraping/access](https://smart.servier.com/terms-of-use/), so a site crawler is not the proposed ingestion route. |
| [NIH BioArt Source](https://bioart.niaid.nih.gov/terms) | Curated biomedical art, including components and explanatory illustrations. Per-entry licenses include Public Domain and Creative Commons; NIH hosting alone is not the rights test. [FAQ](https://bioart.niaid.nih.gov/faqs). | Individual downloads in multiple formats are available. No supported public API or bulk release was verified; useful for selected curated imports initially. |

Bioicons is the simplest scientific catalog to import ahead of time. PhyloPic is a useful live addition for ecology/evolution/taxonomy. Servier offers useful ready-made packs without requiring a site crawler. SciDraw and NIH BioArt deserve inclusion in curation even though their supported automated access needs more investigation.

Concrete metadata examples checked during source research:

- [Bioicons alanine SVG](https://github.com/duerrsimon/bioicons/blob/main/static/icons/cc-0/Amino-Acids/B--Gideon-Bergheim/alanine.svg), CC0, author B--Gideon-Bergheim. Published metadata identifies name, category, license, and author.
- [NIH BioArt RNABrush](https://bioart.niaid.nih.gov/bioart/455), record BIOART-000455, Public Domain, Ryan Kissinger, courtesy of NIAID.
- [PhyloPic Thermoleophilia](https://www.phylopic.org/images/73171a1a-7a90-4398-9cdd-c10b78acf326/thermoleophilia), CC0, with vector/PNG/thumbnail and taxon links.

### Large catalogs and general clipart

| Source | Useful content and rights | Access and proposed acquisition |
| --- | --- | --- |
| [Wikimedia Commons](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia) | Broad diagrams, maps, photography, historical material, and SVGs. Per-file licenses and public-domain declarations control reuse. | [Action API image information](https://www.mediawiki.org/wiki/API:Imageinfo) provides metadata, file/thumbnail URLs, and rights fields. Use live search, then inspect and retain selected records/assets. The earlier spot-check tested this API. |
| [Openverse](https://docs.openverse.org/terms_of_service.html) | A discovery index of upstream collections, with creator/license/source metadata. It does not verify upstream licensing. | Use its image search API and license filters; verify selected upstream records. The earlier spot-check tested anonymous access. Deduplicate upstream assets rather than treating Openverse as an independent collection. |
| [Openclipart](https://openclipart.org/faq) | General SVG clipart under CC0. Skip unresolved `pd_issue` provenance flags and pending-review content. | The [beta API tutorial](https://openclipart.org/api/tutorial) describes an account/app API key. No supported current bulk export was verified. Curate a small local pack; do not make the beta API essential to every lesson request. |
| [Smithsonian Open Access](https://www.si.edu/openaccess/faq) | Art, history, culture, natural history, technology, and 3D objects. Select media explicitly designated CC0; an open metadata record does not mean all associated media is open. | [JSON search/content API](https://github.com/Smithsonian/smithsonian-openaccess) uses an `api.data.gov` key. [Published bulk metadata](https://github.com/Smithsonian/OpenAccess) supports selective import. Start with live search or curated metadata subsets and fetch full assets on selection. |
| [The Met Open Access](https://www.metmuseum.org/hubs/open-access) | Art and history. Open Access public-domain images and catalog metadata use CC0; filter media eligibility independently of metadata. | [No-key Collection API](https://metmuseum.github.io/) and [published CSV](https://github.com/metmuseum/openaccess). Import useful metadata subsets, gate images on public-domain/OA status and available image URLs, and fetch selected originals. |
| [NASA Images](https://www.nasa.gov/nasa-brand-center/images-and-media/) | Astronomy, Earth science, spaceflight, and engineering. NASA media is generally usable for factual educational/informational purposes with acknowledgment; third-party works, logos/endorsement, and identifiable people require additional care. | [Official Images API](https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf) supplies search, captions, previews, and asset manifests. No key requirement is stated in the checked docs. Query live and retain suitable assets selectively. |
| [Europeana](https://pro.europeana.eu/page/the-data-exchange-agreement) | European cultural heritage, manuscripts, art, and maps. Metadata is CC0 while media rights vary by record. Another aggregator with upstream overlap. | [Search API](https://europeana.atlassian.net/wiki/spaces/EF/pages/2385739812/Search+API+Documentation) requires a key and has rights/reusability filters; published bulk metadata does not grant bulk media rights. A later expansion source rather than an initial dependency. |

Smithsonian and the Met are particularly useful additions outside biology. They have explicit open-media programs and documented machine access. NASA adds subject coverage with more item-specific exceptions. Openclipart is useful for simple clipart, but its illustrations should not be assumed to be scientifically reviewed.

## Applying this to a request about mitosis

1. The agent resolves the intended scope, such as an introductory explanation of mitosis and how it differs from meiosis. It uses the learner's stated level and asks only if the ambiguity affects the lesson.
2. When sources are needed, search an existing approved text collection and asset catalog. Fetch the relevant Wikipedia sections if they are not cached. Text and asset work can overlap across providers while respecting each API's concurrency rules.
3. Prefer an existing complete stage diagram for the overview. A mitochondrion icon or a microscope photo is not a substitute for a process diagram, even if its keywords match.
4. If the catalog lacks a suitable diagram, query Commons/Openverse, filter rights, read the selected file record, and inspect legibility and scientific labels. Follow source links for additional evidence when the explanation needs it.
5. Produce the explanation and study activity using identified evidence. Preserve the source revision, selected image, and required attribution with the saved lesson.
6. Reuse those source records for subsequent requests. Refresh the source catalog independently; a saved lesson continues to cite the version that supported it.

For plots and elementary geometry, drawing from equations or explicit geometric definitions may be more useful than searching for a pre-existing image. This should use a verifiable mathematical representation, with any external facts or data cited.

## Fit with the current repository

The existing [agent loop and tool contracts](../../../openwiki/agentic-retrieval.md#tools) already support deliberate retrieval after the first model call. The current index and tools are scoped to a workspace; citations identify real uploaded files. External retrieval should be an explicit additional source path, with web URLs/revisions and asset attribution represented in the citation contract. It should not silently widen `search_workspace` or manufacture file IDs for URLs.

The proposed shared catalog contains developer-approved public sources. Private notebook uploads and their retrieval permissions retain their existing workspace scope. A global text/asset index would need its own consistent embedding model if vectors are added; existing workspace vectors are not interchangeable across model pins. Begin with metadata search and source APIs, then add embeddings only if a representative retrieval evaluation shows the need.

Source policy and local observations: [retrieval contract](../../../openwiki/agentic-retrieval.md), [stored retrieval decisions](../../../human/agentic-retrieval.md), and `pipeline/pipeline/retrieval/tools.py`. This research changes no application behavior or stored user decision.

## Operations and evaluation

- Prefer documented APIs, release archives, and bulk metadata exports. A copyright license and a website's permitted automated-access method are separate checks. Wikimedia explicitly recommends [caching, informative user agents, batching, and appropriate bulk data access](https://www.mediawiki.org/wiki/API:Etiquette).
- Fetch updates outside the interactive request where practical. Stable books can follow editions/releases; encyclopedia caches can revalidate current revision IDs. Exact refresh schedules should follow usage and freshness requirements rather than a universal daily recrawl.
- Store selected reusable assets locally when permitted, so exports and saved lessons do not depend on an external hotlink remaining valid. Keep the provenance attached to the retained file.
- Expand the collection in response to missing topics, repeated external fetches, and poor results. Do not start by captioning or embedding all of Commons, Openverse, or Wikipedia.
- Evaluate a small topic set across biology, chemistry, physics, mathematics, history, and art. Score whether we found a correct complete teaching visual, relevant level-appropriate text, usable rights metadata, correct attribution, source overlap, latency, and cost. Distinguish legal reuse eligibility from relevance and scientific correctness.

The previous mitosis spot-check is one topic and does not establish broad source quality or production latency. The next useful measurement is an end-to-end lesson retrieval sample across subjects, comparing live-only retrieval with the small catalog plus live expansion.

## Suggested first scope

1. Select representative approved textbooks from Open Textbooks for Hong Kong and other open textbook catalogs. Ingest their text, existing captions, and linked figure records into a shared public corpus, preserving edition and rights information.
2. Evaluate whether common curriculum questions retrieve the correct explanation and its teaching figure. Extend coverage by subject and add durable lesson/export asset handling.
3. Add Wikipedia live retrieval and Commons/Openverse discovery for gaps, current information, and alternative visuals. Cache and retain permitted source content with explicit citations and attribution.
4. Import Bioicons or Servier packs where component illustrations help. Add PhyloPic, NASA, Smithsonian, or the Met according to subject demand; one topic does not need a call to every provider. Add visual embeddings only after identifying retrieval failures that captions, context, and source APIs cannot solve.

This keeps the first implementation focused while leaving room for a broad subject catalog. Provider selection, source licensing support, persistence rules, and any new product behavior remain proposals for the developer to choose.
