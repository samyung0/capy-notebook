SKILL IS DISABLED
---
## name: layered-explain

description: Explains how a subsystem, feature, or flow in this repository works by layering complexity. Starts with the goal and ideal happy-path flow in plain language, then introduces the problems that simple picture ignores and how the code solves each one. Use when the user asks "how does X work", "explain X", "walk me through X", "help me understand X", or otherwise wants to build understanding of existing code from scratch.

# Layered explain

Linear walkthroughs fail readers who don't know the code yet. Listing facts in call order, or defining function names and domain terms before the reader knows why they exist, forces the reader to hold unexplained pieces in their head and assemble the picture themselves. Instead, explain in layers: give the simplest picture that captures the goal, then grow it by naming a problem with that picture and showing what the code does about it. Each layer is motivated by the previous one, so nothing arrives unexplained.

## Step 0: explore, then calibrate scope

Read the actual code before explaining. Check the `openwiki/` docs for the domain first (see AGENTS.md table), then trace the real flow through files. Never guess from file names.

How simplified layer 1 should be depends on the scope of the question:

- **Broad scope** ("how does rag work", "how does billing work", "how does a workspace work"). The topic spans many files, tables, and functions. Layer 1 covers only the main goal and the perfect-case scenario: no errors, no exceptions, no integrations with other mechanisms. Anything that introduces a second mechanism belongs in a later layer as a problem, not in layer 1. "Block users without remaining credits" is a problem of the simple ingest picture, because including it would pull billing into an explanation of rag.
- **Narrow scope** ("how do we handle multiple upload requests?"). The question itself tells you the reader already understands the surrounding flow. Layer 1 starts at the detail asked about (worker pool, queue), and the problem layers cover concurrency, ordering, billing under contention.
- **Integration scope** ("how do we verify a user can actually upload?"). The user explicitly asks how two mechanisms meet. Layer 1 must include both, not just one with the other deferred to a problem layer.

## Layer 1: the ideal picture

Open with one or two sentences stating the goal and the basic idea in plain language, before any code names. Example: "in this repo the goal of rag is to handle ingest and let users query. Ingest embeds text into vectors and indexes them; a query embeds the query text and compares vectors, so searching thousands of files is fast."

Then give the ideal flow as a short chain of steps. Rules:

- Happy path only. No errors, no edge cases, no cross-cutting mechanisms (per the scope calibration above).
- Each step is an action in plain words, with a file pointer in parentheses so the reader can look: "user uploads text files (`upload-dialog.tsx`) → go server records the request (`ingest.go`) → pipeline sends text to the embedding model (`embed.py`) → vectors are stored and indexed (`index.py`)".
- Keep it short enough to hold in the head at once. If it doesn't fit, layer 1 is too detailed.

## Layers 2+: problems and answers

After layer 1, state the problems with the simplified picture, then explain what the code does or does not about each. Each layer follows the same shape:

1. **Name the problem as a shortcoming of the picture so far.** "But pdfs aren't plain text; they need parsing before embedding, and they can contain tables and images that need special handling." The problem justifies the machinery before the machinery appears.
2. **Explain if the code answers or not**, again in plain words with file pointers, introducing function and type names only as they become needed. If it is addressed, explain where does the extra codes fit within the layer N-1 codes (N being the current layer).
3. **Recurse when the answer creates its own problems.** Parsing is expensive → we'd pay again when users upload the same document → so artifacts are saved keyed by file identity. That's a third layer nested under the parsing layer. Nest as deep as the code actually goes, one motivated step at a time.

Order the problem layers so each builds on vocabulary the previous layers established. Do NOT start a new layer if the new problems would not exist had the current layer not existed. Put them on the same layer.

## Terminology rule

Never use a function name, type name, or domain term before the reader has seen what it does in plain words. Describe the concept first, then attach the name: "parsed output is cached so re-uploads skip parsing (the code calls these artifacts)". After the concept is introduced, use the code's real name consistently. File paths are exempt; they are pointers, not vocabulary.

## After the core flow

Once the core layers are done, the reader knows the terminology and file layout. Now cover the remaining important factors: error handling, rate limiting, retries, observability, and whatever else matters for the topic.

- If a factor has substantial code of its own, explain it with the same layered treatment, treating it as its own core flow.
- If the related code is minimal, a short plain description with file pointers is enough. No layers needed.

Don't skip this section, but don't let it leak into the core layers either.

## Writing style

Apply the unslop skill (`.agents/skills/unslop/SKILL.md`). The rules that matter most here:

- Prefer the plain word. Say what a thing does, not how it feels. No abstract metaphor nouns ("primitive", "surface", "substrate", "load-bearing", "public-facing").
- Active voice, one idea per sentence. If the reader has to backtrack, split the sentence.
- Arrow chains are fine inside a layer-1 flow where each node is a plain-language action with a file pointer. Don't use them to compress explanations elsewhere. Use a new line for each arrow.

## Example of a good answer

For "how does rag work in this repo?":

1. Goal and basic idea in two sentences (embed text, compare vectors, fast search).
2. Ideal flow: upload → server records → embed → index → results back, each step with a file pointer.
3. Layer 1 Problem: PDFs are not plain text → parsing flow (Marker, RapidOCR, image captioning). Layer 2 problem: parsing is expensive and duplicate uploads waste money → artifact caching by file identity.
4. Layer 1 Problem: users want live ingestion progress → how sse streams progress back.
5. Layer 1 Problem: parsing costs credits and exhausted users must be blocked → how billing checks gate the flow.
6. After the core flow: error handling, rate limiting, and other factors, layered if substantial, brief file pointers if not.
