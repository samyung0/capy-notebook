"""Structured-output schemas for local authors; Go validates before publication."""


def obj(properties, required=None):
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties) if required is None else required,
        "additionalProperties": False,
    }


def array(items, minimum=0, maximum=None):
    return {
        "type": "array",
        "items": items,
        "minItems": minimum,
        **({"maxItems": maximum} if maximum is not None else {}),
    }


TEXT = {"type": "string", "minLength": 1}
NUMBER = {"type": "number"}
BOOL = {"type": "boolean"}
INDEX = {"type": "integer", "minimum": 0}
PAIR = array(NUMBER, 2, 2)


def tagged(tag, props, required=None):
    return obj(
        {"type": {"const": tag}, **props},
        ["type", *(props if required is None else required)],
    )


ELEMENT = {
    "oneOf": [
        tagged(
            "functiongraph",
            {"id": TEXT, "term": TEXT, "domain": PAIR, "dash": BOOL, "hidden": BOOL},
            ["id", "term"],
        ),
        tagged(
            "point",
            {"id": TEXT, "name": TEXT, "coords": PAIR, "hidden": BOOL},
            ["id", "coords"],
        ),
        *[
            tagged(
                kind,
                {"id": TEXT, "points": array(TEXT, 2, 2), "dash": BOOL, "hidden": BOOL},
                ["id", "points"],
            )
            for kind in ("line", "segment")
        ],
        tagged(
            "circle",
            {
                "id": TEXT,
                "center": TEXT,
                "radius": NUMBER,
                "dash": BOOL,
                "hidden": BOOL,
            },
            ["id", "center", "radius"],
        ),
        tagged(
            "text",
            {"id": TEXT, "coords": PAIR, "text": TEXT, "hidden": BOOL},
            ["id", "coords", "text"],
        ),
    ]
}
BLOCK = {
    "oneOf": [
        tagged("text", {"text": TEXT, "label": TEXT}, ["text"]),
        tagged("table", {"header": BOOL, "rows": array(array(TEXT, 1, 10), 1, 30)}),
        tagged(
            "chart",
            {
                "kind": {"enum": ["bar", "hbar", "line", "area", "pie", "stacked"]},
                "title": TEXT,
                "labels": array(TEXT, 1, 50),
                "series": array(
                    obj({"name": TEXT, "values": array(NUMBER, 1, 50)}), 1, 8
                ),
                "unit": TEXT,
                "xTitle": TEXT,
                "yTitle": TEXT,
                "gridlines": {"enum": ["normal", "fine"]},
                "showValues": BOOL,
            },
            ["kind", "title", "labels", "series"],
        ),
        tagged(
            "graph",
            {
                "board": obj({"bbox": array(NUMBER, 4, 4), "axis": BOOL, "grid": BOOL}),
                "elements": array(ELEMENT, 1, 60),
                "image": {
                    "oneOf": [obj({"url": TEXT}), obj({"svg": {"type": "string"}})]
                },
                "width": NUMBER,
                "height": NUMBER,
                "description": TEXT,
                "attribution": TEXT,
            },
            ["board", "elements", "image", "width", "height", "description"],
        ),
        tagged(
            "image",
            {
                "url": TEXT,
                "width": NUMBER,
                "height": NUMBER,
                "description": TEXT,
                "attribution": TEXT,
            },
            ["url", "width", "height", "description"],
        ),
    ]
}
ANSWER = {
    "oneOf": [
        *[
            tagged(kind, {"options": array(TEXT, 2), "correct": array(INDEX, 1)})
            for kind in ("mcq", "multi")
        ],
        tagged("boolean", {"correct": BOOL}),
        tagged("short", {"accepted": array(TEXT, 1), "unit": TEXT}, ["accepted"]),
        tagged(
            "matching",
            {
                "options": array(TEXT, 1),
                "pairs": array(obj({"left": TEXT, "right": INDEX}), 1),
            },
        ),
        tagged("ordering", {"items": array(TEXT, 2)}),
        tagged("open", {"accepted": array(TEXT, 1), "hints": array(TEXT)}),
    ]
}
PART = obj(
    {
        "blocks": array(BLOCK, 1, 40),
        "answer": ANSWER,
        "markscheme": array(TEXT, 1, 20),
        "solution": array(BLOCK, 1, 40),
    }
)
QUESTION = obj(
    {
        "stem": array(BLOCK, 0, 40),
        "parts": array(PART, 1, 26),
        "layout": {"enum": ["paper", "split"]},
        "labels": {"enum": ["letters", "numbers"]},
        "level": {"enum": ["recall", "application", "analysis"]},
    },
    ["stem", "parts", "layout", "labels"],
)
WRITE = obj({"questions": array(QUESTION, 1, 50)})
REFERENCES = obj(
    {"references": array(obj({"url": TEXT, "title": TEXT, "notes": TEXT}), 1)}
)
STYLE = obj({"style": TEXT})
SOLVE = obj(
    {
        "answers": array(
            obj(
                {
                    "part_id": TEXT,
                    "answer": {
                        "oneOf": [TEXT, BOOL, INDEX, array({"oneOf": [TEXT, INDEX]})]
                    },
                }
            ),
            1,
        )
    }
)
JUDGE = obj({"score": {"enum": [0, 0.5, 1]}, "reason": TEXT})
