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

`scnet-large.onnx` was exported from ZFTurbo's SCNet Large v1.0.8 checkpoint
`model_scnet_sdr_9.3244.ckpt` using its matching
`config_musdb18_scnet_large.yaml`. The browser core keeps the same fixed input
shape as Base (`spectrogram` `[1,4,2049,476]`) and emits `separated` in the
same four-stem order. Internal FFT operations were converted to fixed MatMul
DFT bases; native ONNX LSTM nodes were retained.

- Upstream checkpoint SHA-256: `fe550315a76e8f4aed8475d7d5952137504a3b6c63b3adcef2443bfe73aac540`
- Exported ONNX SHA-256: `b604b88207a8b3830b7969c7aef708c56710a39bd1c8b196f105ee7b68c0f939`
- ONNX/PyTorch random-fixture correlation: `0.99999535`
- The same unresolved pretrained-weight licensing caveat applies to Large.

Sources:

- https://github.com/starrytong/SCNet
- https://github.com/elicwhite/scnet-web-wasm
- https://huggingface.co/elicwhite/scnet-browser-onnx
- https://github.com/starrytong/SCNet/issues/35
