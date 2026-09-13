"""OpenDataLoader parsing with the reviewed native repairs and selective OCR.

The modules here are the production port of the September 2026 parser
benchmarks under ``bench/parsers/scripts`` (the ``refined`` variant of
``measure_odl_native_pipeline.py`` plus ``experiment_odl_selective_ocr.py``).
The block output of :func:`odl.refine.parse_pdf` must stay equal to the
``refined-final-r1`` lab outputs those scripts produced; change a rule here
only together with a fresh lab replay.
"""
