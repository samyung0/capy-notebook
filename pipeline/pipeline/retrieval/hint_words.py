"""How a Chinese, Japanese or Korean message's words are counted for the
unindexed-edit hints (``pending_hints.message_units``; Epo 2026-10-20, review
hints-round S3 and its re-review R1-R3).

Overlapping two-character pairs would let 什么是 count as words, so each
language gets a word rule, with hand-picked lists only where measured
necessary (bench/rag/reports/2026-10-20-hints-cjk-rule.md):

- Chinese: split by longest match over the HSK 3.0 words (hsk_words.tsv, MIT)
  and the lists below. Function words, question words, request verbs,
  measure words and locatives are dropped; other list words end a word and
  characters between them join the next. A character left alone takes a
  one-character measure word, locative, 对 or 能 next to it, so 对数,
  动能 and 中子 stay terms.
- Japanese: pairs made only of hiragana do not count (です, とは).
- Korean: a word loses one ending (광합성이란 → 광합성) and question words
  (무엇, 어떻게, 역할) are dropped; a word needs two of its pairs.
"""

from __future__ import annotations

from functools import cache
from importlib import resources

from .chunking import tokenize_for_search

# Dropped and never part of a term. Simplified, then Traditional forms.
_CHINESE_STOP = """
的 地 得 了 着 过 吗 呢 吧 啊 呀 嘛 哦
我 你 您 他 她 它 我们 你们 他们 她们 它们 咱们 这 那 这个 那个 这些 那些
这里 那里 这儿 那儿 这样 那样 这么 那么 自己 大家
什么 为什么 怎么 怎样 怎么样 如何 哪 哪里 哪儿 哪个 哪些 谁 多少 是否 是不是
有没有 能不能 可不可以 会不会 什么样 为何
请 请问 帮 帮我 帮忙 告诉 解释 介绍 说明 讲讲 讲解 说说 一下 知道 意思 总结
复习 你好 谢谢
是 有 没有 在 会 要 可以 想 应该 需要 必须 进行
和 与 跟 及 或 或者 还是 但 但是 而 而且 因为 所以 如果 就 也 都 还 又 再 很
太 最 更 比较 非常 把 被 给 从 到 向 关于 为 为了 以 并 才 已经 一定
一些 一点 有点 之间 里面 上面 下面 中间 旁边 以后 以前 之后 之前
著 過 嗎 妳 這 這個 那個 這些 這裏 這裡 那裏 那裡 這兒 那兒 這樣 那樣
這麼 那麼 什麼 為什麼 怎麼 怎麽 怎樣 怎麼樣 哪裏 哪裡 哪兒 哪個 誰 有沒有
會 會不會 什麼樣 為何 請 請問 幫 幫我 幫忙 告訴 解釋 介紹 說明 講講 講解
說說 總結 復習 複習 謝謝 沒有 應該 必須 進行 與 還是 因為 還 比較 給 從 關於
為 爲 為了 並 纔 已經 一點 有點 之間 裡面 中間 旁邊 以後 之後
""".split()  # noqa: SIM905 - grouped lines keep the hand-picked list reviewable
# Dropped too, but a character left alone next to one keeps it: 对数, 动能, 中子.
_CHINESE_JOINABLE = """
对 能 个 种 次 位 本 张 条 件 颗 只 块 段 篇 道 类 几 里 上 下 中 内 外
前 后 间
對 個 箇 種 張 條 顆 隻 塊 類 幾 裏 裡 內 後 間
""".split()  # noqa: SIM905 - grouped lines keep the hand-picked list reviewable

# Question words and set phrases a Korean word is dropped for, after its ending.
_KOREAN_STOP = frozenset(
    """
무엇 뭐 뭔 어떻게 어떤 어때 왜 언제 어디 누구 얼마나 몇 역할 의미 뜻 설명
알려 주세요 이건 이것 그것 저것 이거 그거 저거 안녕하세요 안녕 감사합니다
""".split()  # noqa: SIM905 - grouped lines keep the hand-picked list reviewable
)
# One ending is taken off a Korean word, longest first, if two characters stay.
_KOREAN_ENDINGS = sorted(
    """
인가요 입니까 습니까 습니다 이에요 예요 이란 란 이다 나요 가요 까요 어요 아요 세요
에서 에게 으로 은 는 이 가 을 를 의 에 로 와 과 도 만 한 요
""".split(),  # noqa: SIM905 - grouped lines keep the hand-picked list reviewable
    key=len,
    reverse=True,
)


@cache
def _chinese_words() -> tuple[dict[str, int], frozenset[str], frozenset[str], int]:
    """HSK 3.0 words and their Traditional forms by level (hsk_words.tsv, MIT)
    with the hand-picked words, the dropped words, the joinable ones, and the
    longest's length."""
    text = resources.files("pipeline.retrieval").joinpath("hsk_words.tsv")
    levels = {}
    for line in text.read_text("utf-8").splitlines():
        if line and not line.startswith("#"):
            word, level = line.split("\t")
            levels[word] = int(level)
    joinable = frozenset(_CHINESE_JOINABLE)
    stop = frozenset(_CHINESE_STOP) | joinable
    words = {**levels, **dict.fromkeys(stop - levels.keys(), 0)}
    return words, stop, joinable, max(map(len, words))


def chinese_pieces(run: str) -> list[str]:
    """A Chinese run's words: 什么是光合作用 gives 光合作, 什么是对数 对数."""
    words, stop, joinable, longest = _chinese_words()
    tokens, i = [], 0
    while i < len(run):
        size = next(
            (
                n
                for n in range(min(longest, len(run) - i), 1, -1)
                if run[i : i + n] in words
            ),
            1,
        )
        tokens.append(run[i : i + size])
        i += size
    # Pieces as [start, end) token spans; a list word ends its piece.
    spans: list[list[int]] = []
    start, ended = None, False
    for k, token in enumerate(tokens):
        if token in stop:
            if start is not None:
                spans.append([start, k])
            start, ended = None, False
            continue
        if ended:
            spans.append([start, k])
            start = None
        if start is None:
            start = k
        ended = len(token) > 1
    if start is not None:
        spans.append([start, len(tokens)])
    pieces = []
    for a, b in spans:
        if b - a == 1 and len(tokens[a]) == 1:
            # A character left alone takes a joinable neighbour, before first.
            if a > 0 and tokens[a - 1] in joinable:
                a -= 1
            elif b < len(tokens) and tokens[b] in joinable:
                b += 1
        piece = "".join(tokens[a:b])
        if len(piece) > 1:
            pieces.append(piece)
    return pieces


def _pairs(text: str) -> list[str]:
    return tokenize_for_search(text).split()


def _is_hiragana(ch: str) -> bool:
    return 0x3040 <= ord(ch) <= 0x309F


def japanese_unit(run: str) -> str:
    """A Japanese run once, matched by any of its pairs not made only of
    hiragana."""
    pairs = [p for p in _pairs(run) if not all(map(_is_hiragana, p))]
    return " or ".join(pairs) if len(run) > 1 else ""


def korean_unit(run: str) -> str:
    """A Korean word without its ending, matched by two of its pairs (or its
    one pair); a question word or set phrase counts none."""
    if run in _KOREAN_STOP:
        return ""
    stem = next(
        (
            run[: -len(end)]
            for end in _KOREAN_ENDINGS
            if run.endswith(end) and len(run) - len(end) >= 2
        ),
        run,
    )
    if stem in _KOREAN_STOP or len(stem) < 2:
        return ""
    pairs = _pairs(stem)
    if len(pairs) < 2:
        return " ".join(pairs)
    return " or ".join(f"{a} {b}" for i, a in enumerate(pairs) for b in pairs[i + 1 :])
