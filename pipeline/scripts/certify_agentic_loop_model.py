"""Record, replay, and certify one exact provider/model agentic loop."""

from __future__ import annotations

import argparse
import getpass
import os
import signal
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from prompt_toolkit import PromptSession
from prompt_toolkit.application import get_app
from prompt_toolkit.completion import WordCompleter
from prompt_toolkit.formatted_text import StyleAndTextTuples
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.keys import Keys
from prompt_toolkit.layout.containers import FloatContainer, WindowRenderInfo
from prompt_toolkit.layout.controls import UIContent
from prompt_toolkit.layout.margins import Margin
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.shortcuts import CompleteStyle
from prompt_toolkit.validation import Validator

from pipeline.config import env_name_for_provider
from pipeline.model_replay_cert import (
    ModelListAuthError,
    ModelListError,
    certified_model_slugs,
    certify_model,
    chat_provider_entries,
    fetch_available_model_slugs,
    load_manifest,
    require_chat_provider,
    selectable_model_slugs,
)


class SelectedCheckMargin(Margin):
    def get_width(self, get_ui_content: Callable[[], UIContent]) -> int:
        return 2

    def create_margin(
        self, window_render_info: WindowRenderInfo, width: int, height: int
    ) -> StyleAndTextTuples:
        state = get_app().current_buffer.complete_state
        selected = state.complete_index if state else None
        result: StyleAndTextTuples = []
        for lineno in window_render_info.displayed_lines:
            current = lineno == selected
            style = (
                "class:completion-menu.completion.current"
                if current
                else "class:completion-menu.completion"
            )
            result.append((style, "✓ " if current else "  "))
            result.append(("", "\n"))
        return result


def align_model_catalog_menu(session: PromptSession[str]) -> None:
    seen: set[int] = set()
    for node in session.layout.walk():
        if not isinstance(node, FloatContainer):
            continue
        for floating in node.floats:
            if id(floating) in seen or not isinstance(
                floating.content, CompletionsMenu
            ):
                continue
            seen.add(id(floating))
            floating.xcursor = False
            floating.left = 0
            window = floating.content.content
            if any(
                isinstance(margin, SelectedCheckMargin)
                for margin in window.left_margins
            ):
                continue
            window.left_margins = [SelectedCheckMargin(), *window.left_margins]


class CertificationInterrupted(KeyboardInterrupt):
    def __init__(self, signal_number: int | None = None) -> None:
        super().__init__()
        self.signal_number = signal_number


@contextmanager
def graceful_interrupts() -> Iterator[None]:
    managed = [signal.SIGINT, signal.SIGTERM]
    if hasattr(signal, "SIGHUP"):
        managed.append(signal.SIGHUP)
    previous = {item: signal.getsignal(item) for item in managed}

    def interrupt(signal_number, _frame) -> None:
        for item in managed:
            signal.signal(item, signal.SIG_IGN)
        raise CertificationInterrupted(signal_number)

    for item in managed:
        signal.signal(item, interrupt)
    try:
        yield
    finally:
        for item, handler in previous.items():
            signal.signal(item, handler)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Make two live streaming calls, replay the recorded cassette, and "
            "certify the exact provider/model pair for the agentic loop."
        )
    )
    parser.add_argument(
        "--provider",
        help="provider slug, such as openai, anthropic, or deepseek",
    )
    parser.add_argument("--model", help="exact provider model slug")
    return parser.parse_args(argv)


def choose_provider(requested: str | None) -> str:
    if requested:
        try:
            return require_chat_provider(requested)
        except ValueError as error:
            raise SystemExit(str(error)) from None
    if not sys.stdin.isatty():
        raise SystemExit("--provider is required outside an interactive terminal")
    entries = chat_provider_entries()
    if not entries:
        raise SystemExit("no chat providers are configured")
    print("Providers with conversational model support:")
    for index, entry in enumerate(entries, start=1):
        print(f"  {index}. {entry['slug']} ({entry['name']})")
    while True:
        value = input("Provider slug or number: ").strip()
        if value.isdigit() and 1 <= int(value) <= len(entries):
            return entries[int(value) - 1]["slug"]
        try:
            return require_chat_provider(value)
        except ValueError as error:
            print(error, file=sys.stderr)


def choose_model(
    requested: str | None,
    *,
    available: list[str] | None = None,
    certified: list[str] | None = None,
) -> str:
    if requested:
        model_id = requested.strip()
    else:
        if not sys.stdin.isatty():
            raise SystemExit("--model is required outside an interactive terminal")
        choices = selectable_model_slugs(available or [], certified or [])
        if not choices:
            model_id = input("Exact model slug: ").strip()
        else:
            metadata = {
                model_id: (
                    "certified"
                    if model_id in (certified or [])
                    else "available from provider"
                )
                for model_id in choices
            }
            bindings = KeyBindings()

            @bindings.add(Keys.Down)
            def select_next(event) -> None:
                buffer = event.app.current_buffer
                if buffer.complete_state is None:
                    buffer.start_completion(select_first=True)
                    return
                buffer.complete_next()

            @bindings.add(Keys.Up)
            def select_previous(event) -> None:
                buffer = event.app.current_buffer
                if buffer.complete_state is None:
                    buffer.start_completion(select_last=True)
                    return
                buffer.complete_previous()

            session: PromptSession[str] = PromptSession(
                completer=WordCompleter(
                    choices,
                    ignore_case=True,
                    match_middle=True,
                    meta_dict=metadata,
                    sentence=True,
                ),
                complete_while_typing=True,
                complete_style=CompleteStyle.COLUMN,
                key_bindings=bindings,
                reserve_space_for_menu=8,
                validator=Validator.from_callable(
                    lambda value: bool(value.strip()),
                    error_message="Model slug is required",
                    move_cursor_to_end=True,
                ),
            )
            align_model_catalog_menu(session)

            def show_choices() -> None:
                get_app().current_buffer.start_completion(select_first=False)

            answer = session.prompt(
                "Model slug (type to filter; Up/Down selects): ",
                pre_run=show_choices,
            )
            model_id = answer.strip()
    if not model_id:
        raise SystemExit("model slug is required")
    return model_id


def print_certified_models(provider_slug: str) -> None:
    models = certified_model_slugs(provider_slug)
    print(f"Certified model slugs for {provider_slug}:")
    if not models:
        print("  (none)")
        return
    for model_id in models:
        print(f"  - {model_id}")


def read_api_key(provider_slug: str) -> str:
    env_name = env_name_for_provider(provider_slug)
    value = os.environ.get(env_name, "").strip()
    if value:
        print(f"Using {env_name} from the environment.")
        return value
    if not sys.stdin.isatty():
        raise SystemExit(f"{env_name} is required outside an interactive terminal")
    value = getpass.getpass(f"{env_name}: ").strip()
    if not value:
        raise SystemExit(f"{env_name} is required")
    return value


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    provider_slug = choose_provider(args.provider)
    print(f"Provider: {provider_slug}")
    print_certified_models(provider_slug)
    certified_models = certified_model_slugs(provider_slug)

    api_key: str | None = None
    available_models: list[str] | None = None
    if args.model is None:
        api_key = read_api_key(provider_slug)
        print("Fetching model slugs available to this API key...")
        try:
            available_models = fetch_available_model_slugs(provider_slug, api_key)
        except ModelListAuthError as error:
            raise SystemExit(str(error)) from None
        except ModelListError as error:
            print(f"Warning: {error}", file=sys.stderr)
            print("You can still type an exact model slug.", file=sys.stderr)

    model_id = choose_model(
        args.model,
        available=available_models,
        certified=certified_models,
    )
    certified = model_id in (load_manifest().get(provider_slug) or {})

    print(f"Model: {model_id}")
    if certified:
        print("The existing certification and cassette will be replaced.")
    else:
        print("A new certification entry and cassette will be created.")

    sys.stdout.flush()
    if api_key is None:
        api_key = read_api_key(provider_slug)
    print("Recording two live turns, then replaying the cassette...")
    result = certify_model(provider_slug, model_id, api_key)
    if result.kept:
        print(f"Certified {provider_slug}/{model_id}.")
        return 0
    if not result.recorded:
        if result.existed:
            print(
                "Recording failed. The previous certification and cassette were restored.",
                file=sys.stderr,
            )
        else:
            print("Recording failed. No certification was added.", file=sys.stderr)
        return 1
    if result.existed:
        print(
            "Replay failed. The previous certification was removed.",
            file=sys.stderr,
        )
        return 1
    print("Replay failed. No certification was added.", file=sys.stderr)
    return 1


def cli(argv: list[str] | None = None) -> int:
    try:
        with graceful_interrupts():
            return main(argv)
    except CertificationInterrupted as error:
        print(
            "\nCertification cancelled. No partial certification was kept.",
            file=sys.stderr,
        )
        if error.signal_number is None:
            return 130
        return 128 + error.signal_number
    except (EOFError, KeyboardInterrupt):
        print(
            "\nCertification cancelled. No partial certification was kept.",
            file=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(cli())
