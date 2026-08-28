from pipeline.retrieval.usage_extract import extract_usage


def test_deepseek_inclusive_cache_is_discounted():
    usage = extract_usage(
        {
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "prompt_cache_hit_tokens": 40,
            "prompt_cache_miss_tokens": 60,
        },
        provider="deepseek",
    )
    assert usage.cached_read_tokens == 40
    assert usage.anomaly == ""


def test_openai_nested_cached_tokens_are_discounted():
    usage = extract_usage(
        {
            "input_tokens": 80,
            "output_tokens": 5,
            "input_tokens_details": {"cached_tokens": 20},
        },
        provider="openai",
    )
    assert usage.cached_read_tokens == 20


def test_missing_or_invalid_cache_charges_full_input():
    missing = extract_usage(
        {"prompt_tokens": 50, "completion_tokens": 2}, provider="deepseek"
    )
    assert missing.cached_read_tokens == 0
    oversized = extract_usage(
        {"prompt_tokens": 10, "prompt_cache_hit_tokens": 40},
        provider="deepseek",
    )
    assert oversized.cached_read_tokens == 0
    assert oversized.anomaly == "cached_gt_input"
    unproven = extract_usage(
        {
            "prompt_tokens": 50,
            "prompt_tokens_details": {"cached_tokens": 10},
        },
        provider="anthropic",
    )
    assert unproven.cached_read_tokens == 0
    assert unproven.anomaly == "unproven_cache_shape"


def test_anthropic_disjoint_cache_counts_become_inclusive_input():
    usage = extract_usage(
        {
            "input_tokens": 30,
            "output_tokens": 5,
            "cache_read_input_tokens": 40,
            "cache_creation_input_tokens": 10,
        },
        provider="anthropic",
    )
    assert usage.input_tokens == 80
    assert usage.cached_read_tokens == 40
    assert usage.cache_write_tokens == 10
    assert usage.anomaly == ""
