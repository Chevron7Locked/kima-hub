#!/usr/bin/env python3
"""
Exports both towers of the music CLAP checkpoint (music_audioset_epoch_15_esc_90.14.pt, the one
v1.10.0 ran through laion_clap) to ONNX. Needs torch and laion_clap, so run it in a throwaway venv
with requirements-torch.txt; Kima's images never run it.

  music_audio.onnx  input  mel [batch, 1, 1001, 64] (music_clap_mel.MusicClapMel)
                    output embedding [batch, 512], L2-normalised
                    = audio_branch from bn0 on (htsat.py:885-895) + audio_projection
                      + F.normalize (model.py:739-741)
  music_text.onnx   inputs input_ids, attention_mask [batch, tokens] (int64; RobertaTokenizer
                    'roberta-base', padding='max_length', max_length=77, as hook.py:64-72)
                    output embedding [batch, 512], L2-normalised
                    = text_branch pooler_output + text_projection (model.py:629-636)
                      + F.normalize (model.py:715-716)

Usage: python -I export_music_onnx.py --ckpt path/to/music_audioset_epoch_15_esc_90.14.pt
       --out-dir dir
"""
import argparse
import hashlib
import os

import torch
import torch.nn.functional as F

CKPT_SHA256 = 'fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd'
OPSET = 17


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _window_reverse(windows, window_size, H, W):
    """htsat.window_reverse with the batch size left to view(-1). The original computes it with
    int() (htsat.py:273), which the tracer freezes at the traced batch of 1, so any bigger batch
    came out wrong. Same arithmetic otherwise."""
    C = windows.shape[-1]
    x = windows.view(-1, H // window_size, W // window_size, window_size, window_size, C)
    return x.permute(0, 1, 3, 2, 4, 5).contiguous().view(-1, H, W, C)


def load_music_clap(ckpt):
    """The model exactly as v1.10.0 analyzer.py:111-115 built and loaded it."""
    import laion_clap
    model = laion_clap.CLAP_Module(enable_fusion=False, amodel='HTSAT-base', device='cpu')
    model.load_ckpt(ckpt, verbose=False)
    return model.eval()


class AudioTower(torch.nn.Module):
    def __init__(self, clap):
        super().__init__()
        self.branch = clap.model.audio_branch
        self.projection = clap.model.audio_projection

    def forward(self, mel):
        x = mel.transpose(1, 3)
        x = self.branch.bn0(x)
        x = x.transpose(1, 3)
        x = self.branch.reshape_wav2img(x)
        emb = self.branch.forward_features(x)['embedding']
        return F.normalize(self.projection(emb), dim=-1)


class TextTower(torch.nn.Module):
    def __init__(self, clap):
        super().__init__()
        self.branch = clap.model.text_branch
        self.projection = clap.model.text_projection

    def forward(self, input_ids, attention_mask):
        pooled = self.branch(input_ids=input_ids, attention_mask=attention_mask)['pooler_output']
        return F.normalize(self.projection(pooled), dim=-1)


def check_batches(clap, audio_out, text_out):
    """Each exported graph, on a batch of 3, against torch row by row: a shape frozen at
    trace time shows up here."""
    import onnxruntime as ort
    g = torch.Generator().manual_seed(0)
    mel = torch.randn(3, 1, 1001, 64, generator=g) * 20 - 40
    tok = clap.tokenizer(['jazz', 'a slow sad piano piece in an empty hall', 'punk rock'])
    with torch.no_grad():
        want_a = AudioTower(clap).eval()(mel).numpy()
        want_t = TextTower(clap).eval()(tok['input_ids'], tok['attention_mask']).numpy()
    got_a = ort.InferenceSession(audio_out).run(None, {'mel': mel.numpy()})[0]
    got_t = ort.InferenceSession(text_out).run(None, {
        'input_ids': tok['input_ids'].numpy(), 'attention_mask': tok['attention_mask'].numpy()})[0]
    for name, want, got in (('audio', want_a, got_a), ('text', want_t, got_t)):
        cos = (want * got).sum(1)
        if cos.min() < 0.9999:
            raise SystemExit(f'{name} export differs from torch on a batch of 3: {cos}')
        print(f'{name}: batch-of-3 cosine to torch {cos.min():.7f}')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--out-dir', required=True)
    args = ap.parse_args()

    digest = sha256(args.ckpt)
    if digest != CKPT_SHA256:
        raise SystemExit(f'checkpoint sha256 {digest} is not the music checkpoint {CKPT_SHA256}')

    import laion_clap  # noqa: F401  puts its clap_module on sys.path; the model uses that copy
    from clap_module import htsat
    htsat.window_reverse = _window_reverse
    clap = load_music_clap(args.ckpt)
    os.makedirs(args.out_dir, exist_ok=True)
    audio_out = os.path.join(args.out_dir, 'music_audio.onnx')
    text_out = os.path.join(args.out_dir, 'music_text.onnx')

    with torch.no_grad():
        torch.onnx.export(
            AudioTower(clap).eval(), (torch.zeros(1, 1, 1001, 64),), audio_out,
            input_names=['mel'], output_names=['embedding'], opset_version=OPSET,
            dynamic_axes={'mel': {0: 'batch'}, 'embedding': {0: 'batch'}},
            do_constant_folding=True, dynamo=False)

        tok = clap.tokenizer(['a dummy prompt to trace with'])
        torch.onnx.export(
            TextTower(clap).eval(), (tok['input_ids'], tok['attention_mask']), text_out,
            input_names=['input_ids', 'attention_mask'], output_names=['embedding'],
            opset_version=OPSET,
            dynamic_axes={'input_ids': {0: 'batch', 1: 'tokens'},
                          'attention_mask': {0: 'batch', 1: 'tokens'},
                          'embedding': {0: 'batch'}},
            do_constant_folding=True, dynamo=False)

    check_batches(clap, audio_out, text_out)
    for path in (audio_out, text_out):
        print(f'{path}  {os.path.getsize(path)} bytes  sha256={sha256(path)}')


if __name__ == '__main__':
    main()
