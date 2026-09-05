"""Per-chunk language detection feeding the lexical index."""

from __future__ import annotations

import pytest

from pipeline.retrieval.lang import TS_CONFIG, UND, detect_lang


@pytest.mark.parametrize(
    ("text", "lang"),
    [
        (
            (
                "The rate of photosynthesis is limited by the light intensity and "
                "the concentration of carbon dioxide in the air."
            ),
            "en",
        ),
        (
            (
                "La vitesse de la photosynthèse est limitée par l'intensité de la "
                "lumière et la concentration du dioxyde de carbone dans l'air."
            ),
            "fr",
        ),
        (
            (
                "Die Geschwindigkeit der Photosynthese wird durch die Lichtintensität "
                "und die Konzentration von Kohlendioxid in der Luft begrenzt."
            ),
            "de",
        ),
        (
            (
                "La velocidad de la fotosíntesis está limitada por la intensidad de "
                "la luz y la concentración de dióxido de carbono en el aire."
            ),
            "es",
        ),
        ("光合作用的速率受到光照强度和空气中二氧化碳浓度的限制。", "zh"),
        ("光合成の速度は、光の強さと空気中の二酸化炭素濃度によって制限される。", "ja"),
        ("광합성 속도는 빛의 세기와 공기 중 이산화탄소 농도에 의해 제한된다.", "ko"),
    ],
)
def test_each_supported_language_is_recognised(text, lang):
    assert detect_lang(text) == lang


def test_a_bilingual_chunk_follows_its_dominant_script():
    """The token model decides, not the character count: a Chinese sentence
    with an English gloss is Chinese even though the gloss has more letters."""
    text = "光合作用是植物把光能转化为化学能的过程。(photosynthesis, chlorophyll)"
    assert detect_lang(text) == "zh"
    assert (
        detect_lang(
            "Photosynthesis (光合作用) converts light energy to chemical energy in the chloroplast"
        )
        == "en"
    )


def test_text_without_a_signal_is_undetermined():
    assert detect_lang("Hoga | 2.10 | 0.05") == UND
    assert detect_lang("") == UND
    # A language outside the list must not be forced into one.
    assert detect_lang("Скорость фотосинтеза ограничена интенсивностью света") == UND


def test_every_detected_language_has_a_search_configuration():
    assert set(TS_CONFIG) == {"en", "fr", "de", "es", "zh", "ja", "ko", UND}
    assert TS_CONFIG[UND] == "simple"
