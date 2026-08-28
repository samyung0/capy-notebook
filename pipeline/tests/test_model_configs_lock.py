"""Schema lock: embedding catalog rows cannot be retired or rewritten.

Workspace pins resolve a specific (provider slug, model slug, version) for life. Same width is a
different space and a different table, so another 2560-d model is a new
row, not an UPDATE of an old one. Chat versions can still be disabled, but
their provider/model/version identity cannot be retargeted. Two rows cannot
claim the same is_default_for surface.
"""

from __future__ import annotations

import re
import secrets
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration

_CHAT_PARAMS = '{"temperature":0.3}'
_LLM_COLS = """
                version, provider_name, model_name, provider_slug, model_slug,
                platform_enabled, byok_enabled, context_window_tokens,
                thinking_levels, default_thinking, params, surfaces,
                micros_per_input_token, micros_per_output_token,
                micros_per_cached_input_token, enabled, is_default_for
"""
_LLM_THINKING = "ARRAY['instant','low','mid','high','max']::text[], 'instant'"


def test_python_embedding_allowlist_matches_go():
    from pipeline.retrieval.store import _VECTOR_TABLES

    source = (
        Path(__file__).parents[2]
        / "server"
        / "internal"
        / "embeddingpins"
        / "allowlist.go"
    ).read_text(encoding="utf-8")
    go_tables = {
        (provider, "qwen/qwen3-embedding-4b", int(version)): table
        for provider, version, table in re.findall(
            r'ProviderSlug: "([^"]+)", ModelSlug: models\.SeededHopEmbedSlug\}, Version: (\d+)\}: \{\s*'
            r'VectorTable: "([^"]+)"',
            source,
        )
    }
    assert go_tables
    assert _VECTOR_TABLES == go_tables


def test_embedding_rows_are_frozen(_test_infra):
    import psycopg

    with psycopg.connect(_test_infra, autocommit=True) as conn:
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs SET enabled=false
                 WHERE provider_slug='openrouter' AND model_slug='qwen/qwen3-embedding-4b' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs SET surfaces=ARRAY['chat']
                 WHERE provider_slug='openrouter' AND model_slug='qwen/qwen3-embedding-4b' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs SET model_slug='other-embed'
                 WHERE provider_slug='openrouter' AND model_slug='qwen/qwen3-embedding-4b' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs
                   SET params='{"dimensions": 2560, "x": 1}'::jsonb
                 WHERE provider_slug='openrouter' AND model_slug='qwen/qwen3-embedding-4b' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                "DELETE FROM model_configs WHERE provider_slug='openrouter' AND model_slug='qwen/qwen3-embedding-4b' AND version=1"
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'Ghost', 'Ghost', 'openrouter', 'ghost',
                    true, false, 0, ARRAY[]::text[], '',
                    '{{"dimensions": 2560, "vector_table": "rag_chunk_vectors_2560"}}'::jsonb,
                    ARRAY['embedding'],
                    50, 50, 0, false, ARRAY[]::text[])
                """
            )

        chat_slug = f"chat-disable-{secrets.token_hex(4)}"
        conn.execute(
            f"""
            INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                1, 'Chat', 'Disable', 'deepseek', %s,
                true, false, 100000, {_LLM_THINKING}, %s::jsonb, ARRAY['chat'],
                250, 1000, 250, true, ARRAY[]::text[])
            """,
            (chat_slug, _CHAT_PARAMS),
        )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs
                   SET surfaces=ARRAY['chat','embedding'],
                       params='{"dimensions": 2560}'::jsonb
                 WHERE provider_slug='deepseek' AND model_slug=%s
                """,
                (chat_slug,),
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                "UPDATE model_configs SET model_slug='chat-disable-2' WHERE provider_slug='deepseek' AND model_slug=%s",
                (chat_slug,),
            )
        conn.execute(
            "UPDATE model_configs SET enabled=false WHERE provider_slug='deepseek' AND model_slug=%s",
            (chat_slug,),
        )
        conn.execute(
            "DELETE FROM model_configs WHERE provider_slug='deepseek' AND model_slug=%s",
            (chat_slug,),
        )

        embed_slug = f"lock-embed-{secrets.token_hex(4)}"
        conn.execute(
            f"""
            INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                1, 'Lock', 'Embed', 'embedtest', %s,
                true, false, 0, ARRAY[]::text[], '',
                '{{"dimensions": 2560, "vector_table": "rag_chunk_vectors_other_1"}}'::jsonb,
                ARRAY['embedding'],
                50, 50, 0, true, ARRAY[]::text[])
            """,
            (embed_slug,),
        )
        with pytest.raises(psycopg.Error):
            conn.execute(
                "UPDATE model_configs SET model_slug='nope' WHERE provider_slug='embedtest' AND model_slug=%s",
                (embed_slug,),
            )
        conn.execute(
            "UPDATE model_configs SET model_name='Lock Embed Moved' WHERE provider_slug='embedtest' AND model_slug=%s",
            (embed_slug,),
        )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs
                   SET is_default_for = ARRAY['embedding']
                 WHERE provider_slug='embedtest' AND model_slug=%s
                """,
                (embed_slug,),
            )


def test_credit_rates_zero_only_for_byok(_test_infra):
    import psycopg

    with psycopg.connect(_test_infra, autocommit=True) as conn:
        bad = f"zero-platform-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'Zero', 'Platform', 'deepseek', %s,
                    true, false, 100000, {_LLM_THINKING}, %s::jsonb, ARRAY['chat'],
                    0, 0, 0, true, ARRAY[]::text[])
                """,
                (bad, _CHAT_PARAMS),
            )
        byok = f"zero-byok-{secrets.token_hex(4)}"
        conn.execute(
            f"""
            INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                1, 'Zero', 'BYOK', 'openai', %s,
                false, true, 100000, {_LLM_THINKING}, %s::jsonb, ARRAY['chat'],
                0, 0, 0, true, ARRAY[]::text[])
            """,
            (byok, _CHAT_PARAMS),
        )
        conn.execute(
            "DELETE FROM model_configs WHERE provider_slug='openai' AND model_slug=%s",
            (byok,),
        )

        hybrid = f"zero-hybrid-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'Zero', 'Hybrid', 'deepseek', %s,
                    true, true, 100000, {_LLM_THINKING}, %s::jsonb, ARRAY['chat'],
                    0, 0, 0, true, ARRAY[]::text[])
                """,
                (hybrid, _CHAT_PARAMS),
            )
        vision = f"zero-vision-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'Zero', 'Vision', 'gemini', %s,
                    true, false, 100000, ARRAY[]::text[], '',
                    '{{}}'::jsonb, ARRAY['vision'],
                    0, 0, 0, true, ARRAY[]::text[])
                """,
                (vision,),
            )
        embed_in0 = f"embed-in0-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'Embed', 'In0', 'openrouter', %s,
                    true, false, 0, ARRAY[]::text[], '',
                    '{{"dimensions": 2560, "vector_table": "rag_chunk_vectors_in0"}}'::jsonb,
                    ARRAY['embedding'],
                    0, 0, 0, true, ARRAY[]::text[])
                """,
                (embed_in0,),
            )
        embed = f"embed-out0-{secrets.token_hex(4)}"
        conn.execute(
            f"""
            INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                1, 'Embed', 'Out0', 'embedtest', %s,
                true, false, 0, ARRAY[]::text[], '',
                '{{"dimensions": 2560, "vector_table": "rag_chunk_vectors_out0"}}'::jsonb,
                ARRAY['embedding'],
                50, 0, 0, true, ARRAY[]::text[])
            """,
            (embed,),
        )
        conn.execute(
            "UPDATE model_configs SET is_default_for='{}' WHERE provider_slug='embedtest' AND model_slug=%s",
            (embed,),
        )


def test_llm_rows_require_thinking(_test_infra):
    import psycopg

    with psycopg.connect(_test_infra, autocommit=True) as conn:
        missing = f"no-think-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'No', 'Think', 'deepseek', %s,
                    true, false, 100000, ARRAY[]::text[], '',
                    '{{}}'::jsonb, ARRAY['chat'],
                    250, 1000, 250, true, ARRAY[]::text[])
                """,
                (missing,),
            )
        wrong_default = f"wrong-default-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'Wrong', 'Default', 'deepseek', %s,
                    true, false, 100000,
                    ARRAY['instant','low']::text[], 'high',
                    '{{}}'::jsonb, ARRAY['chat'],
                    250, 1000, 250, true, ARRAY[]::text[])
                """,
                (wrong_default,),
            )
        embed_think = f"embed-think-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                f"""
                INSERT INTO model_configs ({_LLM_COLS}) VALUES (
                    1, 'Embed', 'Think', 'openrouter', %s,
                    true, false, 0, ARRAY['instant']::text[], 'instant',
                    '{{"dimensions": 2560, "vector_table": "rag_chunk_vectors_think"}}'::jsonb,
                    ARRAY['embedding'],
                    50, 50, 0, true, ARRAY[]::text[])
                """,
                (embed_think,),
            )
