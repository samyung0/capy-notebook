# Local statistics corpus

Downloaded 2026-09-16 from author/publisher links. PDFs are gitignored. The tracked [manifest](../../knowledge-base-pilot-books.json) pins each downloaded file by SHA256, exact edition and licence evidence.

| Book | Version | Pages | Licence |
| --- | --- | --- | --- |
| [OpenIntro Statistics](https://www.openintro.org/book/os/) | 4th edition, screen-reader PDF updated 2022-10-21 | 465 | CC BY-SA 3.0 |
| [Advanced High School Statistics](https://www.openintro.org/book/ahss/) | 4th edition, screen-reader PDF updated 2026-04-10 | 514 | CC BY-SA 3.0 |
| [Learning Statistics with jamovi: A Tutorial for Beginners in Statistical Analysis](https://davidfoxcroft.github.io/lsj-book/) | 2025, author-hosted PDF snapshot downloaded 2026-09-16 | 495 | CC BY-SA 4.0 |

## Scope and rights notes

- The two OpenIntro books share source lineage. They deliberately test repeated coverage; they are not independent confirmation.
- The OpenIntro screen-reader PDFs have different pagination from print. All page references are one-based PDF pages for the pinned files.
- Topic candidates come from these books' tables of contents. They are draft editorial labels, not a prerequisite graph.
- Original captions, equations and figure coordinates belong to their source excerpt. No image-caption model is used.
- Cover/front-matter figures are excluded from reuse. Per-figure credit exceptions are recorded in the manifest, including the Ryan Claussen iris photograph in both OpenIntro books.
- Study artifacts must preserve source attribution and applicable ShareAlike terms. Source book titles in attribution do not imply publisher endorsement.

## Frozen requests

The [request fixture](../../knowledge-base-pilot-questions.json) contains 16 development requests and 8 held out from catalog construction. Expected labels and source-check notes are evaluation-only. All labels are agent-authored and await independent review.

Book-manifest SHA256: `4cb9e87c272acdd67c6491e9a9b662a53f9511f1c447d3b9078615d6b163790f`.
Request-fixture SHA256: `f7d1dd5f8350c004774e6ccbed91a64f43d5e4926c7aa165535210ce4cd61416`.

## Restore the PDFs

Download each manifest `download_url` to its `pdf_path`, then verify its `sha256`. Author-hosted latest-build URLs can change: a mismatch requires a new manifest/run, not silent cache reuse. Download only these three selected books for this pilot.
