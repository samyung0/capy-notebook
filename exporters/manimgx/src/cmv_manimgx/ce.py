"""Run Manim CE scene files on ManimGX unchanged: `import manim` and any `manim.<sub.module>`
resolve to the `manimgx` package, which keeps every name at its top level (ManimGX's "Coming from
Manim CE" guide says to replace `manim` with `manimgx`; this does it at import time). It also
puts back the few names CE code commonly relies on that ManimGX dropped. A test aid: code that
needs more than this fails, and the bench counts it as not running.
"""

import importlib.abc
import importlib.machinery
import sys
import types
import typing

import manimgx


class _Proxy(types.ModuleType):
    def __getattr__(self, name):
        return getattr(manimgx, name)


def _manim() -> types.ModuleType:
    """`manim`: manimgx's names, plus the typing names CE's star import leaks (Iterable, …)."""
    module = types.ModuleType("manim")
    module.__dict__.update(
        {k: v for k, v in vars(typing).items() if not k.startswith("_")}
    )
    module.__dict__.update(
        {k: v for k, v in vars(manimgx).items() if not k.startswith("_")}
    )
    module.__path__ = []
    return module


class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path, target=None):
        if fullname == "manim" or fullname.startswith("manim."):
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        if spec.name == "manim":
            return _manim()
        module = _Proxy(spec.name)
        module.__path__ = []
        return module

    def exec_module(self, module):
        pass


def install() -> None:
    manimgx.ConvertToOpenGL = type  # CE's metaclass for OpenGL-or-Cairo classes
    mob, vmob = manimgx.Mobject, manimgx.VMobject
    mob.set_width = lambda self, w, stretch=False, **k: (
        self.stretch_to_fit_width if stretch else self.scale_to_fit_width
    )(w, **k)
    mob.set_height = lambda self, h, stretch=False, **k: (
        self.stretch_to_fit_height if stretch else self.scale_to_fit_height
    )(h, **k)
    mob.get_height = lambda self: self.height
    mob.get_z_index = lambda self: self.z_index
    vmob.set_fill_color = lambda self, color, **k: self.set_fill(color, **k)
    vmob.set_fill_opacity = lambda self, opacity, **k: self.set_fill(
        opacity=opacity, **k
    )
    vmob.set_stroke_width = lambda self, width, **k: self.set_stroke(width=width, **k)
    vmob.set_stroke_color = lambda self, color, **k: self.set_stroke(color, **k)
    manimgx.config.quality = "high_quality"  # CE's preset name; scenes branch on it
    sys.meta_path.insert(0, _Finder())
