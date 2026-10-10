"""parity.py: test scanning, evidence checks, scoring and the CI exit code."""

import contextlib
import io
import subprocess
import tempfile
import unittest
from pathlib import Path

import parity

HEADER = " ¦ ".join(parity.COLUMNS)


def row(id_, view="-", edit="-", evidence="", prio="P0"):
    cells = [
        id_,
        "Area",
        f"Feature {id_}",
        prio,
        view,
        edit,
        "-",
        "-",
        "3",
        "S",
        evidence,
        "",
        "",
    ]
    return " ¦ ".join(cells)


def trees(fork_tests=None, capy_tests=None, root=Path(".")):
    return parity.Trees(root, root, capy_tests or {}, fork_tests or {})


class ScanTests(unittest.TestCase):
    def test_rust_takes_the_function_after_each_test_attribute(self):
        text = '#[test]\n#[ignore]\nfn plain() {}\n#[tokio::test(flavor = "multi_thread")]\nasync fn flavoured() {}\n#[test] fn inline() {}\nmacro_rules! cases { () => { #[test] fn $name() {} } }\nfn helper() {}\n#[cfg(test)]\nmod tests {}'
        self.assertEqual(parity.rust_tests(text), ["plain", "flavoured", "inline"])

    def test_ts_reads_literal_titles_only(self):
        text = "test('one', () => {});\nit.skip(\"two\", () => {});\ntest(\n  'three across lines',\n  () => {},\n);\ntest.each([[1]])('four %s', () => {});\ntest.each(Object.keys(cases))('five %s', () => {});\ntest.each([\n  ['a', 1],\n] as const)(\n  \"six after a table\",\n  () => {},\n);\ntest.describe('a group', () => {});\ntest.step('a step', () => {});\ntest(name, () => {});"
        self.assertEqual(
            sorted(parity.ts_tests(text)),
            [
                "five %s",
                "four %s",
                "one",
                "six after a table",
                "three across lines",
                "two",
            ],
        )


class CheckTests(unittest.TestCase):
    def test_every_y_needs_a_resolving_test_for_its_aspect(self):
        rows, problems = parse(
            row("a", "Y", evidence="fork:crates/x.rs::works"),
            row("b", "Y", evidence="code:fork:crates/x.rs"),
            row("c", "Y", "Y", evidence="view@fork:crates/x.rs::works"),
            row("d", "U", "N"),
            row("e", "Y", evidence="matrix:docx-breaks"),
        )
        self.assertEqual(problems, [])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "crates").mkdir()
            (root / "crates/x.rs").write_text("")
            (root / "shared/matrix/baseline").mkdir(parents=True)
            (root / "shared/matrix/baseline/docx-breaks.tsv").write_text(
                "# docx-breaks: 1 rows\n"
            )
            found = parity.check(rows, trees({"crates/x.rs": ["it_works"]}, root=root))
        self.assertEqual(
            found, ["b: view is Y without a test", "c: edit is Y without a test"]
        )

    def test_unresolved_references_name_the_reason(self):
        t = trees({"crates/x.rs": ["it_works"]}, {"e2e/a.spec.ts": ["opens a file"]})
        self.assertEqual(
            parity.resolve("fork:crates/x.rs::WORKS", t)[:2], ("test", True)
        )
        self.assertEqual(parity.resolve("capy:e2e/a.spec.ts", t)[:2], ("test", True))
        self.assertIn("no such test", parity.resolve("fork:crates/x.rs::renamed", t)[2])
        self.assertIn(
            "no tests in that file", parity.resolve("fork:crates/y.rs::x", t)[2]
        )
        self.assertIn("unknown kind", parity.resolve("bun:crates/x.rs", t)[2])
        self.assertFalse(parity.resolve("code:fork:crates/missing.rs", t)[1])

    def test_malformed_rows_are_problems(self):
        _, problems = parse(
            row("a", "y"),
            row("a", prio="P3"),
            "only ¦ three ¦ cells",
        )
        self.assertEqual(len(problems), 3)
        self.assertIn("view 'y'", problems[0])
        self.assertIn("prio 'P3', duplicate id", problems[1])
        self.assertIn("3 cells", problems[2])
        _, problems = parse(row("a"), header="id ¦ feature")
        self.assertIn("header must be", problems[0])


class ReportTests(unittest.TestCase):
    def test_parity_weighs_rows_by_priority(self):
        rows, _ = parse(row("a", "Y", "Y"), row("b", "N", "P", prio="P2"))
        total, by_prio = parity.parity(rows, parity.VERIFIED)
        self.assertAlmostEqual(total, 100 * (3 * 1 + 1 * 0.25) / 4)
        self.assertEqual(by_prio, {"P0": (100.0, 1), "P2": (25.0, 1)})

    def test_fidelity_reads_the_benchmark_tables(self):
        sha = "ab" * 20
        tables = "".join(
            f'### {fmt}\n\n<table>\n<tr><th></th><th>BetterOffice (<a href="x/commit/{sha}">abababab</a>)'
            '</th></tr>\n<tr><td>SSIM</td><td align="right">0.8368</td></tr>\n</table>\n\n'
            for fmt in ("DOCX", "PPTX", "XLSX")
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "fidelity.md")
            path.write_text(
                f"## Benchmarks\n\n{tables}For scoring see the methodology.\n", "utf-8"
            )
            commit, found = parity.read_fidelity(path)
            path.write_text("### DOCX\n<table></table>\n", "utf-8")
            self.assertEqual(parity.read_fidelity(path), (None, {}))
        self.assertEqual(commit, sha)
        self.assertEqual(
            found["xlsx"], [["", "BetterOffice (abababab)"], ["SSIM", "0.8368"]]
        )


class RunTests(unittest.TestCase):
    def test_check_fails_and_writes_nothing_when_a_test_is_renamed(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            capy, fork, family = (
                Path(tmp, name) for name in ("capy", "fork", "family")
            )
            for path in (
                capy,
                fork / "crates/a/tests",
                family / "fixtures",
                family / "reports",
            ):
                path.mkdir(parents=True)
            test_file = fork / "crates/a/tests/open.rs"
            test_file.write_text("#[test]\nfn opens_a_document() {}\n")
            git = ["git", "-C", str(fork), "-c", "user.name=t", "-c", "user.email=t@t"]
            subprocess.run([*git, "init", "-q"], check=True)
            subprocess.run([*git, "add", "."], check=True)
            subprocess.run([*git, "commit", "-qm", "seed"], check=True)
            for fmt in parity.FORMATS:
                body = row(
                    f"{fmt}.open", "Y", evidence="fork:crates/a/tests/open.rs::opens"
                )
                (family / "fixtures" / f"{fmt}.tsv").write_text(
                    f"{HEADER}\n{body}\n", "utf-8"
                )
            self.assertEqual(parity.run(capy, fork, family, check_only=True), 0)
            self.assertEqual(list((family / "reports").iterdir()), [])
            self.assertEqual(parity.run(capy, fork, family, check_only=False), 0)
            report = (family / "reports/PARITY-DOCX.md").read_text("utf-8")
            pin = subprocess.run(
                [*git, "rev-parse", "--short=8", "HEAD"],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn(f"against BetterOffice `{pin.stdout.strip()}`", report)
            test_file.write_text("#[test]\nfn renamed() {}\n")
            for path in (family / "reports").iterdir():
                path.unlink()
            self.assertEqual(parity.run(capy, fork, family, check_only=False), 1)
            self.assertEqual(list((family / "reports").iterdir()), [])


def parse(*rows, header=HEADER):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp, "docx.tsv")
        path.write_text("# comment\n" + "\n".join([header, *rows]) + "\n", "utf-8")
        return parity.load_checklist(path)


if __name__ == "__main__":
    unittest.main()
