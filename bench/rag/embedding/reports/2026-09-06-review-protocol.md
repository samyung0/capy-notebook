# Answer review

These are Codex source checks, not independent human grading. The frozen question
labels and required evidence groups remain unchanged. The review reads each final
answer, its search/read calls and citation mapping, checks the source text behind
claims, and checks actual returned passages against the frozen workspace sources.
The helper prints the required evidence and maps citations to those groups. It
does not decide semantic correctness.

`task_correct` means the requested values, identifiers, relationships and current
versus historical distinctions are correct, or the negative answer properly
withholds information the sources cannot establish. `grounded` requires material
claims to follow from the observed source evidence or direct arithmetic.
`citations_supported` requires the cited passages to support the attached material
claims and the required chain. A correct negative conclusion can still overstate
what its searches establish. For example, a categorical claim that an identifier
appears nowhere is flagged when only ranked searches and partial reads were
observed, even if the complete source snapshot happens to confirm its absence.

All three labels are recorded separately. Strict supported success requires all
three plus a completed first attempt without a transport/model error. Missing
bridge cases must not infer an assay assignment or say that no incubation is
required merely because its settings cannot be determined. Likewise, saying no DNA sequence was measured goes beyond a source that only
says no sequence is provided. Absence of the accession registers in a complete
source inventory, together with the course brief assigning that role to them and
targeted identifier searches, supports a cannot-determine answer. Questions already
used for development are not a fresh test set, and repeats are dependent.
