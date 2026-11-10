"""The model the layout service runs, built with its image (layout/Dockerfile):
PP-DocLayout_plus-L with its convolutions in int8.

    python quantise.py FLOAT_ONNX INT8_ONNX

Convolutions only, as QDQ with int8 weights per channel and uint8 activations;
the decoder and post-processing stay float, since quantising them loses
regions. The activation ranges come from calibration-ranges.json beside this
file (MinMax over 97 pages), so this step reads no page and needs no network.
Against the float model it costs 528 CPU-ms a page for 970 and scores the same
on the gold figures: bench/extraction/reports/2026-11-10-layout-int8.md.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import onnx
from onnxruntime.quantization import (
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_static,
)
from onnxruntime.quantization.shape_inference import quant_pre_process

RANGES = Path(__file__).with_name("calibration-ranges.json")
# What the measured model was built with.
SETTINGS = {
    "quant_format": QuantFormat.QDQ,
    "op_types_to_quantize": ["Conv"],
    "per_channel": True,
    "weight_type": QuantType.QInt8,
    "activation_type": QuantType.QUInt8,
    "calibrate_method": CalibrationMethod.MinMax,
}


def quantise(float_model: Path, int8_model: Path) -> None:
    with tempfile.TemporaryDirectory() as folder:
        # Constant folding and shape inference: the graph the ranges name.
        prepared = Path(folder) / "prepared.onnx"
        quant_pre_process(float_model, prepared, skip_symbolic_shape=True)
        # No data reader: the ranges are read, and a missing file is an error.
        quantize_static(
            prepared, int8_model, None, calibration_cache_path=RANGES, **SETTINGS
        )
    # onnxruntime carries on when its preparation fails; a convolution left
    # float means the model is not the measured one.
    nodes = onnx.load(int8_model, load_external_data=False).graph.node
    int8 = {name for n in nodes if n.op_type == "DequantizeLinear" for name in n.output}
    left = [
        n.name for n in nodes if n.op_type == "Conv" and not set(n.input[:2]) <= int8
    ]
    if left:
        raise SystemExit(f"{len(left)} convolutions stayed float, {left[0]} first")


if __name__ == "__main__":
    quantise(Path(sys.argv[1]), Path(sys.argv[2]))
