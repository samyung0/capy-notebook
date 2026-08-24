"""Schema lock: embedding catalog rows cannot be retired or rewritten.

Workspace pins resolve a specific (key, version) for life. Same width is a
different space and a different table, so another 2560-d model is a new
row, not an UPDATE of an old one. Chat versions can still be disabled or
retargeted. Two rows cannot claim the same is_default_for surface.
"""

from __future__ import annotations

import secrets

import pytest

pytestmark = pytest.mark.integration

_CHAT_PARAMS = (
    '{"reasoning":{"canDisable":true,"efforts":["low","high","max"],'
    '"defaultMode":"off","defaultEffort":"max"}}'
)


def test_embedding_rows_are_frozen(_test_infra):
    import psycopg

    with psycopg.connect(_test_infra, autocommit=True) as conn:
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs SET enabled=false
                 WHERE model_key='qwen-embed' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs SET surfaces=ARRAY['chat']
                 WHERE model_key='qwen-embed' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs SET provider_model_id='other-embed'
                 WHERE model_key='qwen-embed' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs
                   SET params='{"dimensions": 2560, "x": 1}'::jsonb
                 WHERE model_key='qwen-embed' AND version=1
                """
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                "DELETE FROM model_configs WHERE model_key='qwen-embed' AND version=1"
            )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    enabled, is_default_for
                ) VALUES (
                    'ghost-embed', 1, 'Ghost', 'openrouter', 'https://example.test',
                    'ghost',
                    '{"dimensions": 2560, "vector_table": "rag_chunk_vectors_2560"}'::jsonb,
                    ARRAY['embedding'],
                    50, 50, false, ARRAY[]::text[])
                """
            )

        chat_key = f"chat-disable-{secrets.token_hex(4)}"
        conn.execute(
            """
            INSERT INTO model_configs (
                model_key, version, display_name, provider_slug, base_url,
                provider_model_id, params, surfaces,
                micros_per_input_token, micros_per_output_token,
                enabled, is_default_for
            ) VALUES (
                %s, 1, 'Chat Disable', 'deepseek', 'https://example.test',
                'chat-disable', %s::jsonb, ARRAY['chat'],
                250, 1000, true, ARRAY[]::text[])
            """,
            (chat_key, _CHAT_PARAMS),
        )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs
                   SET surfaces=ARRAY['chat','embedding'],
                       params='{"dimensions": 2560}'::jsonb
                 WHERE model_key=%s
                """,
                (chat_key,),
            )
        conn.execute(
            "UPDATE model_configs SET provider_model_id='chat-disable-2' WHERE model_key=%s",
            (chat_key,),
        )
        conn.execute(
            "UPDATE model_configs SET enabled=false WHERE model_key=%s", (chat_key,)
        )
        conn.execute("DELETE FROM model_configs WHERE model_key=%s", (chat_key,))

        embed_key = f"lock-embed-{secrets.token_hex(4)}"
        conn.execute(
            """
            INSERT INTO model_configs (
                model_key, version, display_name, provider_slug, base_url,
                provider_model_id, params, surfaces,
                micros_per_input_token, micros_per_output_token,
                enabled, is_default_for
            ) VALUES (
                %s, 1, 'Lock Embed', 'openrouter', 'https://example.test',
                'other-2560',
                '{"dimensions": 2560, "vector_table": "rag_chunk_vectors_other_1"}'::jsonb,
                ARRAY['embedding'],
                50, 50, true, ARRAY[]::text[])
            """,
            (embed_key,),
        )
        with pytest.raises(psycopg.Error):
            conn.execute(
                "UPDATE model_configs SET provider_model_id='nope' WHERE model_key=%s",
                (embed_key,),
            )
        conn.execute(
            "UPDATE model_configs SET base_url='https://moved.example/v1' WHERE model_key=%s",
            (embed_key,),
        )
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                UPDATE model_configs
                   SET is_default_for = ARRAY['embedding']
                 WHERE model_key=%s
                """,
                (embed_key,),
            )


def test_credit_rates_zero_only_for_byok(_test_infra):
    import psycopg

    with psycopg.connect(_test_infra, autocommit=True) as conn:
        bad = f"zero-platform-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    auth_mode, enabled, is_default_for
                ) VALUES (
                    %s, 1, 'Zero Platform', 'deepseek', 'https://example.test',
                    'zero-platform', %s::jsonb, ARRAY['chat'],
                    0, 0, 'platform', true, ARRAY[]::text[])
                """,
                (bad, _CHAT_PARAMS),
            )
        byok = f"zero-byok-{secrets.token_hex(4)}"
        conn.execute(
            """
            INSERT INTO model_configs (
                model_key, version, display_name, provider_slug, base_url,
                provider_model_id, params, surfaces,
                micros_per_input_token, micros_per_output_token,
                auth_mode, enabled, is_default_for
            ) VALUES (
                %s, 1, 'Zero BYOK', 'openai', 'https://example.test',
                'zero-byok', %s::jsonb, ARRAY['chat'],
                0, 0, 'user_key', true, ARRAY[]::text[])
            """,
            (byok, _CHAT_PARAMS),
        )
        conn.execute("DELETE FROM model_configs WHERE model_key=%s", (byok,))

        hybrid = f"zero-hybrid-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    auth_mode, enabled, is_default_for
                ) VALUES (
                    %s, 1, 'Zero Hybrid', 'deepseek', 'https://example.test',
                    'zero-hybrid', %s::jsonb, ARRAY['chat'],
                    0, 0, 'platform_or_user', true, ARRAY[]::text[])
                """,
                (hybrid, _CHAT_PARAMS),
            )
        vision = f"zero-vision-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    auth_mode, enabled, is_default_for
                ) VALUES (
                    %s, 1, 'Zero Vision', 'google', 'https://example.test',
                    'zero-vision', '{}'::jsonb, ARRAY['vision'],
                    0, 0, 'platform', true, ARRAY[]::text[])
                """,
                (vision,),
            )
        embed_in0 = f"embed-in0-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    auth_mode, enabled, is_default_for
                ) VALUES (
                    %s, 1, 'Embed In0', 'openrouter', 'https://example.test',
                    'embed-in0',
                    '{"dimensions": 2560, "vector_table": "rag_chunk_vectors_in0"}'::jsonb,
                    ARRAY['embedding'],
                    0, 0, 'platform', true, ARRAY[]::text[])
                """,
                (embed_in0,),
            )
        embed = f"embed-out0-{secrets.token_hex(4)}"
        conn.execute(
            """
            INSERT INTO model_configs (
                model_key, version, display_name, provider_slug, base_url,
                provider_model_id, params, surfaces,
                micros_per_input_token, micros_per_output_token,
                auth_mode, enabled, is_default_for
            ) VALUES (
                %s, 1, 'Embed Out0', 'openrouter', 'https://example.test',
                'embed-out0',
                '{"dimensions": 2560, "vector_table": "rag_chunk_vectors_out0"}'::jsonb,
                ARRAY['embedding'],
                50, 0, 'platform', true, ARRAY[]::text[])
            """,
            (embed,),
        )
        conn.execute(
            "UPDATE model_configs SET is_default_for='{}' WHERE model_key=%s",
            (embed,),
        )


def test_llm_rows_require_catalog_reasoning(_test_infra):
    import psycopg

    with psycopg.connect(_test_infra, autocommit=True) as conn:
        missing = f"no-reason-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    enabled, is_default_for
                ) VALUES (
                    %s, 1, 'No Reason', 'deepseek', 'https://example.test',
                    'no-reason', '{}'::jsonb, ARRAY['chat'],
                    250, 1000, true, ARRAY[]::text[])
                """,
                (missing,),
            )
        wrong_default = f"wrong-default-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    enabled, is_default_for
                ) VALUES (
                    %s, 1, 'Wrong Default', 'deepseek', 'https://example.test',
                    'wrong-default',
                    '{"reasoning":{"canDisable":true,"efforts":["low","high","max"],"defaultMode":"off","defaultEffort":"medium"}}'::jsonb,
                    ARRAY['chat'],
                    250, 1000, true, ARRAY[]::text[])
                """,
                (wrong_default,),
            )
        embed_reason = f"embed-reason-{secrets.token_hex(4)}"
        with pytest.raises(psycopg.Error):
            conn.execute(
                """
                INSERT INTO model_configs (
                    model_key, version, display_name, provider_slug, base_url,
                    provider_model_id, params, surfaces,
                    micros_per_input_token, micros_per_output_token,
                    enabled, is_default_for
                ) VALUES (
                    %s, 1, 'Embed Reason', 'openrouter', 'https://example.test',
                    'embed-reason',
                    '{"dimensions": 2560, "vector_table": "rag_chunk_vectors_reason", "reasoning":{"canDisable":true,"efforts":["low"],"defaultMode":"off","defaultEffort":"low"}}'::jsonb,
                    ARRAY['embedding'],
                    50, 50, true, ARRAY[]::text[])
                """,
                (embed_reason,),
            )
