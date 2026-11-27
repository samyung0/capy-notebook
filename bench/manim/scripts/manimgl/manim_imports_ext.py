"""Stand-in for 3b1b/videos' `manim_imports_ext` (ManimGL), for testing its scenes on ManimGX:
ManimGL's common names mapped onto ManimGX's (Manim CE's API). Put this folder before the
3b1b/videos root on the import path (run_files.py: `file.py:<this folder>:<repo root>`).

Not there, so scenes that need them fail: pi creatures, InteractiveScene's camera frame
(`self.frame`, `set_field_of_view`), GL-only mobjects and methods (`get_graph`, …).
"""

import itertools as it  # noqa: F401  (ManimGL's star import brings these)
import math  # noqa: F401
import random  # noqa: F401

import manimgx as _m
from manimgx import *  # noqa: F403

_CETex, _CEMathTex = _m.Tex, _m.MathTex


def Tex(*tex, t2c=None, tex_to_color_map=None, isolate=None, font_size=48, **kw):  # GL's Tex is math mode
    return _CEMathTex(*tex, tex_to_color_map=t2c or tex_to_color_map, font_size=font_size, **kw)


def TexText(*text, t2c=None, tex_to_color_map=None, isolate=None, font_size=48, **kw):  # GL's TexText is text mode
    return _CETex(*text, tex_to_color_map=t2c or tex_to_color_map, font_size=font_size, **kw)


class InteractiveScene(_m.Scene):
    def set_floor_plane(self, plane="xy"):  # which plane is the floor: the camera's concern only
        pass


ShowCreation = _m.Create
VFadeIn, VFadeOut, VFadeInThenOut = _m.FadeIn, _m.FadeOut, _m.FadeIn
GlowDot = TrueDot = _m.Dot
FlashAround = _m.Circumscribe
DEG = _m.DEGREES
FRAME_WIDTH, FRAME_HEIGHT = _m.config.frame_width, _m.config.frame_height
FRAME_X_RADIUS, FRAME_Y_RADIUS = FRAME_WIDTH / 2, FRAME_HEIGHT / 2
# so a file imports; its scenes that draw pi creatures or end screens still fail
TeacherStudentsScene = PiCreatureScene = SideScrollEndScreen = _m.Scene
