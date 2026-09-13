"""Two small live checks through EliteLLM; requires DEEPSEEK_API_KEY."""

from __future__ import annotations

import asyncio
import base64
import io
import json

from PIL import Image, ImageDraw

from pipeline.elitellm import complete
from pipeline.registry import ModelConfig, bind_request_llm


async def main() -> None:
    spec = ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash 4.1",
        provider_slug="deepseek",
        model_slug="deepseek-flash",
        platform_enabled=True,
        byok_enabled=False,
        thinking_levels=("instant", "low", "mid", "high", "max"),
        default_thinking="instant",
        context_window_tokens=1000000,
        slots=("chat", "captioning"),
    )
    picture = Image.new("RGB", (360, 160), "white")
    ImageDraw.Draw(picture).multiline_text(
        (20, 15),
        "Item       Count\nApples     17\nPears      29",
        fill="black",
        font_size=26,
    )
    buffer = io.BytesIO()
    picture.save(buffer, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
    bind_request_llm(paid_by="platform", thinking="instant")
    vision = await complete(
        spec,
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Read the table. Return JSON with lowercase item names as keys and integer counts as values.",
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        response_format={"type": "json_object"},
        max_tokens=512,
        temperature=0,
    )
    observed = json.loads(vision.choices[0].message.content)
    assert observed == {"apples": 17, "pears": 29}, observed
    bind_request_llm(paid_by="platform", thinking="max")
    thinking = await complete(
        spec,
        [{"role": "user", "content": "What is 17 + 29? Reply with just the number."}],
        max_tokens=512,
    )
    answer = thinking.choices[0].message.content.strip()
    assert answer == "46", answer
    assert thinking.choices[0].message.reasoning_content
    print(
        json.dumps(
            {
                "model": spec.model_slug,
                "vision": {
                    "passed": True,
                    "observed": observed,
                    "usage": vars(vision.usage),
                },
                "max_thinking": {
                    "passed": True,
                    "answer": answer,
                    "usage": vars(thinking.usage),
                },
            },
            indent=2,
            default=vars,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
