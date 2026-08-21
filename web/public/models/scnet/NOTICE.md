# SCNet browser model notice

`scnet-base.onnx` is an ONNX conversion of pretrained SCNet weights obtained
from `elicwhite/scnet-browser-onnx`, which traces the checkpoint to ZFTurbo's
Music-Source-Separation-Training releases and the official SCNet project.

- SCNet source code: MIT.
- Browser conversion/demo source code: MIT.
- Pretrained checkpoint weights: no explicit weight license was published at
  the time this proof of concept was assembled (August 2026).

The model is included for local technical evaluation only. Do not assume that
the source-code MIT licenses grant permission to redistribute or commercially
ship the pretrained weights. Resolve the upstream weight license before a
production release.

Sources:

- https://github.com/starrytong/SCNet
- https://github.com/elicwhite/scnet-web-wasm
- https://huggingface.co/elicwhite/scnet-browser-onnx
- https://github.com/starrytong/SCNet/issues/35
