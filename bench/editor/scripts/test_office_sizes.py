"""office_sizes.py's XML/media/other split on a committed fixture."""

import os
import unittest

from office_sizes import kind, sizes

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures", "office")


class SplitTests(unittest.TestCase):
    def test_package_relationships_are_xml(self):
        self.assertEqual(kind("_rels/.rels", {}, {}), "xml")
        self.assertEqual(kind("word/_rels/document.xml.rels", {}, {}), "xml")

    def test_gradebook_is_all_xml(self):
        out = sizes(os.path.join(FIXTURES, "large-gradebook.xlsx"))
        self.assertEqual((out["otherParts"], out["mediaParts"]), (0, 0))
        self.assertEqual(out["xmlBytes"], out["unzippedBytes"])


if __name__ == "__main__":
    unittest.main()
