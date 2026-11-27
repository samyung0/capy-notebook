"""Each second of one scene in both forms: its bytes drawn and as video, and which is smaller.

usage: python3 compare_forms.py <scene.drawn.cmv> <scene.video.cmv>

Both files come from `cmv-manimgx export --form drawn` and `--form video` of the same scene. A
chunk is one second. A drawn chunk codes its arrays against the second before, so its size
assumes the second before was drawn too: "best per second" is a floor for a film that switches
form, not what one would weigh (each switch back to drawn sends its shapes afresh).
"""

import json
import struct
import sys


def chunks(path: str) -> tuple[dict, dict[int, int]]:
    """A film's header, and its bytes by the second each chunk starts in (the forms may cut
    the last frames into chunks differently)."""
    data = open(path, "rb").read()
    if data[:4] != b"CMV0":
        sys.exit(f"{path}: not a CMV film")
    n = struct.unpack_from("<I", data, 4)[0]
    header = json.loads(data[8 : 8 + n])
    sizes: dict[int, int] = {}
    for i in range(header["chunks"]):
        _, draw, video, first, _ = struct.unpack_from("<QIIII", data, 8 + n + 24 * i)
        second = int(first // header["fps"])
        sizes[second] = sizes.get(second, 0) + draw + video
    return header, sizes


def main() -> None:
    (dh, by_d), (vh, by_v) = chunks(sys.argv[1]), chunks(sys.argv[2])
    if (dh["form"], vh["form"]) != ("drawn", "video") or dh["frames"] != vh["frames"]:
        sys.exit("pass the drawn film, then the video film, of one scene")
    seconds = sorted(by_d.keys() | by_v.keys())
    drawn = [by_d.get(s, 0) for s in seconds]
    video = [by_v.get(s, 0) for s in seconds]
    kb = lambda b: f"{b / 1024:8.1f}"  # noqa: E731
    print(f"{'second':>6} {'drawn KB':>9} {'video KB':>9}  smaller")
    picks = []
    for s, (d, v) in enumerate(zip(drawn, video)):
        picks.append("drawn" if d <= v else "video")
        print(f"{s:6d} {kb(d)} {kb(v)}  {picks[-1]}")
    switches = sum(a != b for a, b in zip(picks, picks[1:]))
    best = sum(min(d, v) for d, v in zip(drawn, video))
    print(
        f"drawn {sum(drawn) / 2**20:.2f} MB, video {sum(video) / 2**20:.2f} MB, "
        f"best per second {best / 2**20:.2f} MB "
        f"({picks.count('drawn')} s drawn, {picks.count('video')} s video, {switches} switches)"
    )


if __name__ == "__main__":
    main()
