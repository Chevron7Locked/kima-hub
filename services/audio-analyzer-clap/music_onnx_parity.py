#!/usr/bin/env python3
"""
Parity run for the music CLAP ONNX export on real songs: the original checkpoint through
laion_clap and torch (the reference) against music_audio.onnx / music_text.onnx with the numpy
front end (the candidate), on the same decoded audio.

Stages, each writing into --work:
  decode   (any venv with librosa)  pick the clips, decode every window once, save them
  ref      (torch + laion_clap venv) reference vectors, the model loaded as v1.10.0 did
  cand     (torch-free venv)         candidate vectors, and the general model's for comparison
  compare  (any venv)                the parity table, written to --work/report.json
  fixture  (torch + laion_clap venv) test_fixtures/expected_music_embeddings.npy for verify_runtime.py
           (writes no --work)

Two window recipes, both reported:
  1.10  v1.10.0 analyzer.py:151-188, 223-229: the middle 60 s (all of a shorter song) as one
        clip, which laion_clap cuts to a random 10 s (rand_trunc) and embeds once.
  1.11  analyzer.py compute_window_offsets + _load_window: up to five 10 s windows, each embedded,
        averaged, L2-normalised.
laion_clap draws each random cut with np.random.randint; the reference seeds np.random before
every call and the candidate replays the same draw, so both cut at the same sample.
"""
import argparse
import ast
import csv
import glob
import json
import os
import subprocess
import sys
import time

import numpy as np

SVC = os.path.dirname(os.path.abspath(__file__))
SR = 48000
WIN = 480000
V110_SECONDS = 60
EAR_FRACTIONS = (0.1, 0.3, 0.5, 0.7, 0.9)

DATA = os.path.expanduser('~/kima-eval-data')
KIMA_EMBED_CACHE = os.path.expanduser('~/projects/kima/kima-rnd/kima-embed/eval/.cache/emb')
JULY_MTT = os.path.join(KIMA_EMBED_CACHE, 'engine-model8233f5c3223a-recipe0bf9b1af15e4',
                        'mtt_triplets.npz')
GENERAL_MTT = os.path.join(KIMA_EMBED_CACHE, 'v1-model37df17afb988-recipeb4c5cac9181b',
                           'mtt_triplets.npz')
GENERAL_POOL = os.path.join(KIMA_EMBED_CACHE, 'onnx-v1-laion-clap-htsat-unfused', 'pool.npz')
JULY_MEMO = os.path.join(DATA, 'memo2496', 'memo2496_emb.npz')
JULY_DEAM = os.path.join(DATA, 'deam', 'deam_clap.npz')

# Kima's prompts: analyzer.py PROMPTS (the same 24 v1.10.0 used), test_text_parity.py's, then
# search-style queries of every length, one past the 77-token cut.
SEARCH_PROMPTS = [
    'synthwave', 'solo piano', 'country music with banjo', 'a song with vocals and singing',
    'an instrumental track with no vocals',
    'epic orchestral trailer music with choir and huge drums building to a climax',
    'jazz', 'lo-fi hip hop beats to study to', 'death metal with blast beats',
    'bossa nova guitar and soft female vocals', 'dark ambient drone', 'upbeat 80s pop',
    'string quartet', 'reggae with heavy bass', 'chill house music for a sunset',
    'sad song about lost love', 'children singing a lullaby', 'aggressive trap beat with 808s',
    'flamenco guitar', 'gospel choir', 'dubstep wobble bass drop', 'acoustic folk with harmonica',
    'baroque harpsichord', 'punk rock', 'k-pop', 'smooth saxophone solo', 'techno at 130 bpm',
    'film noir soundtrack', 'sitar and tabla', 'mellow indie rock with reverb guitars',
    'Musique électronique douce', 'música latina para bailar', 'rock',
    'a slow, melancholic piano piece played in a large empty hall, with long reverb tails and '
    'the sound of rain outside the window, quiet and intimate, the kind of music you hear at two '
    'in the morning when you cannot sleep and the city is silent except for the occasional car '
    'passing on the wet street below, and the radiator ticking',
]


def kima_prompts():
    """analyzer.py PROMPTS, read from the source so the list cannot drift."""
    with open(os.path.join(SVC, 'analyzer.py')) as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], 'id', '') == 'PROMPTS':
            groups = ast.literal_eval(node.value)
            return [p for g in groups.values() for p in g]
    raise RuntimeError('PROMPTS not found in analyzer.py')


def all_prompts():
    seen, out = set(), []
    for p in kima_prompts() + SEARCH_PROMPTS:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def shipped_window_offsets():
    """analyzer.compute_window_offsets, taken from the source: importing analyzer would pull in
    redis, psycopg2 and its thread settings."""
    with open(os.path.join(SVC, 'analyzer.py')) as f:
        tree = ast.parse(f.read())
    fn = next(n for n in tree.body
              if isinstance(n, ast.FunctionDef) and n.name == 'compute_window_offsets')
    ns = {'WINDOW_COUNT': 5, 'WINDOW_SECONDS': 10}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), 'analyzer.py', 'exec'), ns)
    return ns['compute_window_offsets']


# ---- decode ---------------------------------------------------------------------------------

def _probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                          'stream=sample_rate,channels', '-of', 'json', path],
                         capture_output=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    return int(s['sample_rate']), int(s['channels'])


def pick_clips(scratch):
    clips = []

    def add(source, path, key=None):
        clips.append({'source': source, 'path': path, 'key': key})

    for f in sorted(glob.glob(os.path.join(SVC, 'test_fixtures', '*.wav'))):
        add('fixture', f)

    # Jamendo full tracks, one per first-listed genre.
    pool_audio = os.path.join(DATA, 'pool', 'audio')
    have = {os.path.splitext(f)[0] for f in os.listdir(pool_audio)}
    used = set()
    for tsv in ('train.tsv', 'valid.tsv'):
        with open(os.path.join(DATA, 'pool', 'meta', tsv)) as f:
            for row in csv.DictReader(f, delimiter='\t'):
                genres = ast.literal_eval(row['genres'])
                if row['id'] in have and genres and genres[0] not in used and len(used) < 15:
                    used.add(genres[0])
                    add(f'pool:{genres[0]}', os.path.join(pool_audio, row['id'] + '.opus'),
                        row['id'])

    # MagnaTagATune clips that kima-embed already embedded with the July engine and with 1.11.
    mtt_paths = {}
    with open(os.path.join(DATA, 'mtt', 'comparisons_final.csv')) as f:
        for row in csv.DictReader(f, delimiter='\t'):
            for i in (1, 2, 3):
                mtt_paths[row[f'clip{i}_id']] = row[f'clip{i}_mp3_path']
    ids = sorted(np.load(JULY_MTT)['ids'].tolist())
    for cid in ids[::len(ids) // 15][:15]:
        add('mtt', os.path.join(DATA, 'mtt', 'audio', mtt_paths[cid]), cid)

    deam_sids = sorted(int(s) for s in np.load(JULY_DEAM)['sid'])
    for sid in deam_sids[::len(deam_sids) // 12][:12]:
        add('deam', os.path.join(DATA, 'deam', 'MEMD_audio', f'{sid}.mp3'), str(sid))

    info = {r['song_id']: r['file_name'] for r in
            csv.DictReader(open(os.path.join(DATA, 'memo2496', 'songs_info_all.csv')))}
    memo_ids = sorted(int(s) for s in np.load(JULY_MEMO)['song_id'])
    for sid in memo_ids[::len(memo_ids) // 8][:8]:
        add('memo2496', os.path.join(DATA, 'memo2496', 'audio', info[str(sid)]), str(sid))

    # Excerpts cut from the clips above, for the formats the datasets lack.
    os.makedirs(scratch, exist_ok=True)
    deam0 = next(c for c in clips if c['source'] == 'deam')['path']
    pool0 = next(c for c in clips if c['source'].startswith('pool'))['path']
    memo0 = next(c for c in clips if c['source'] == 'memo2496')['path']
    for name, src, ss, t, extra in (
            ('short6s_44k_stereo.wav', deam0, 20, 6, []),
            ('short4s_48k_stereo.wav', pool0, 60, 4, []),
            ('excerpt30s_44k_mono.wav', memo0, 30, 30, ['-ac', '1'])):
        out = os.path.join(scratch, name)
        if not os.path.exists(out):
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(ss), '-t', str(t),
                            '-i', src, *extra, '-c:a', 'pcm_s16le', out], check=True)
        add('excerpt', out)

    for c in clips:
        c['sr'], c['channels'] = _probe(c['path'])
    return clips


def stage_decode(work):
    import librosa
    offsets_fn = shipped_window_offsets()
    clips = pick_clips(os.path.join(work, 'excerpts'))
    os.makedirs(os.path.join(work, 'audio'), exist_ok=True)
    for i, c in enumerate(clips):
        path = c['path']
        c['id'] = i
        # 1.10: v1.10.0 analyzer.py:151-188, 223-229 (librosa.get_duration then one load).
        duration = librosa.get_duration(path=path)
        if duration > V110_SECONDS:
            v110, _ = librosa.load(path, sr=SR, offset=(duration - V110_SECONDS) / 2,
                                   duration=V110_SECONDS, mono=True)
        else:
            v110, _ = librosa.load(path, sr=SR, mono=True)
        # 1.11: analyzer.py get_audio_embedding -> compute_window_offsets -> _load_window.
        offsets = offsets_fn(duration)
        v111 = []
        for start in offsets:
            start = max(0.0, min(start, max(0.0, duration - 1e-3)))
            take = min(10, max(0.0, duration - start))
            w, _ = librosa.load(path, sr=SR, offset=start, duration=(take if take > 0 else None),
                                mono=True)
            v111.append(w)
        # July engine (vibe_engine/ear): whole decode, five windows centred at 10..90 %.
        whole, _ = librosa.load(path, sr=SR, mono=True)
        if len(whole) <= WIN:
            ear = [whole]
        else:
            ear = []
            for frac in EAR_FRACTIONS:
                st = int(np.clip(int(frac * len(whole)) - WIN // 2, 0, len(whole) - WIN))
                ear.append(whole[st:st + WIN])
        # deam_clap.npz (~/kima-vibe-local/work/embed_deam.py): back-to-back windows from 0 s.
        nwin = min(5, max(1, len(whole) // WIN))
        deam = [whole[k * WIN:(k + 1) * WIN] for k in range(nwin)]
        c.update(duration=duration, offsets=[float(o) for o in offsets],
                 v111_lens=[len(w) for w in v111], v110_len=len(v110))
        np.savez(os.path.join(work, 'audio', f'{i:03d}.npz'), v110=v110,
                 **{f'v111_{k}': w for k, w in enumerate(v111)},
                 **{f'ear_{k}': w for k, w in enumerate(ear)},
                 **{f'deam_{k}': w for k, w in enumerate(deam)},
                 n_v111=len(v111), n_ear=len(ear), n_deam=len(deam))
        print(f'[decode] {i:3d} {c["source"]:22s} {duration:7.1f}s {c["sr"]}Hz '
              f'ch={c["channels"]} windows={len(v111)}', flush=True)
    json.dump(clips, open(os.path.join(work, 'clips.json'), 'w'), indent=1)


def load_audio(work, i):
    z = np.load(os.path.join(work, 'audio', f'{i:03d}.npz'))
    return (z['v110'], [z[f'v111_{k}'] for k in range(int(z['n_v111']))],
            [z[f'ear_{k}'] for k in range(int(z['n_ear']))])


def load_deam_windows(work, i):
    z = np.load(os.path.join(work, 'audio', f'{i:03d}.npz'))
    return [z[f'deam_{k}'] for k in range(int(z['n_deam']))]


def seed_for(clip_id, slot):
    return 100003 * clip_id + slot


def replay_crop(n_samples, seed):
    """The start laion_clap's get_audio_features draws after np.random.seed(seed)."""
    overflow = n_samples - WIN
    return int(np.random.RandomState(seed).randint(0, overflow + 1)) if overflow > 0 else None


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


# ---- reference --------------------------------------------------------------------------------

def stage_ref(work, ckpt, threads):
    import torch
    import laion_clap
    torch.set_num_threads(threads)
    model = laion_clap.CLAP_Module(enable_fusion=False, amodel='HTSAT-base', device='cpu')
    model.load_ckpt(ckpt, verbose=False)  # v1.10.0 analyzer.py:111-115
    model = model.eval()
    clips = json.load(open(os.path.join(work, 'clips.json')))

    def embed(audio, seed):
        np.random.seed(seed)
        with torch.no_grad():
            return model.get_audio_embedding_from_data([audio], use_tensor=False)[0]

    out = {'v110': [], 'v111': [], 'v111_win': [], 'ear_win': [], 'secs_per_window': []}
    for c in clips:
        v110, v111, ear = load_audio(work, c['id'])
        out['v110'].append(embed(v110, seed_for(c['id'], 0)))
        t0 = time.perf_counter()
        wins = np.stack([unit(embed(w, seed_for(c['id'], 1 + k))) for k, w in enumerate(v111)])
        out['secs_per_window'].append((time.perf_counter() - t0) / len(v111))
        out['v111'].append(unit(wins.mean(0)))
        out['v111_win'].append(wins)
        out['ear_win'].append(np.stack([embed(w, seed_for(c['id'], 10 + k))
                                        for k, w in enumerate(ear)]))
        print(f'[ref] {c["id"]:3d} {c["source"]}', flush=True)
    prompts = all_prompts()
    with torch.no_grad():
        text = model.get_text_embedding(prompts, use_tensor=False)
    np.savez(os.path.join(work, 'ref.npz'), v110=np.stack(out['v110']),
             v111=np.stack(out['v111']), text=text,
             secs_per_window=np.array(out['secs_per_window']),
             **{f'v111_win_{i}': w for i, w in enumerate(out['v111_win'])},
             **{f'ear_win_{i}': w for i, w in enumerate(out['ear_win'])})


FIXTURES = ('sine440.wav', 'white.wav', 'sine880.wav')  # verify_runtime.py's order


def stage_fixture(ckpt):
    """test_fixtures/expected_music_embeddings.npy, the vectors verify_runtime.py checks every image against:
    laion_clap's embedding of each fixture's first 10 s at 48 kHz (exactly 480000 samples, so no random cut),
    which is what the analyzer's backend embeds when handed the whole fixture."""
    import librosa
    import torch
    import laion_clap
    model = laion_clap.CLAP_Module(enable_fusion=False, amodel='HTSAT-base', device='cpu')
    model.load_ckpt(ckpt, verbose=False)
    model = model.eval()
    rows = []
    for name in FIXTURES:
        audio, _ = librosa.load(os.path.join(SVC, 'test_fixtures', name), sr=SR, mono=True)
        with torch.no_grad():
            rows.append(unit(model.get_audio_embedding_from_data([audio[:WIN]], use_tensor=False)[0]))
    out = os.path.join(SVC, 'test_fixtures', 'expected_music_embeddings.npy')
    np.save(out, np.stack(rows).astype(np.float32))
    print(f'[fixture] {out}')


# ---- candidate ---------------------------------------------------------------------------------

def stage_cand(work, onnx_dir, threads, general_audio, general_text, july_model):
    from music_clap_onnx import MusicClapAudio, MusicClapText
    audio = MusicClapAudio(os.path.join(onnx_dir, 'music_audio.onnx'), threads=threads)
    clips = json.load(open(os.path.join(work, 'clips.json')))
    res = {'v110': [], 'v111': [], 'v110_draws': [], 'secs_per_window': [], 'mel_secs': []}
    wins_all, ear_all = [], []
    for c in clips:
        v110, v111, ear = load_audio(work, c['id'])
        s0 = seed_for(c['id'], 0)
        res['v110'].append(audio.embed_windows([v110], [replay_crop(len(v110), s0)])[0])
        # How far apart two 1.10 runs land: three more random cuts of the same 60 s.
        res['v110_draws'].append(audio.embed_windows(
            [v110] * 3, [replay_crop(len(v110), s0 + 7 + d) for d in range(3)]))
        starts = [replay_crop(len(w), seed_for(c['id'], 1 + k)) for k, w in enumerate(v111)]
        t0 = time.perf_counter()
        wins = np.stack([audio.embed_windows([w], [s])[0] for w, s in zip(v111, starts)])
        res['secs_per_window'].append((time.perf_counter() - t0) / len(v111))
        t0 = time.perf_counter()
        for w, s in zip(v111, starts):
            audio.mel(w, s)
        res['mel_secs'].append((time.perf_counter() - t0) / len(v111))
        res['v111'].append(unit(wins.mean(0)))
        wins_all.append(wins)
        ear_all.append(audio.embed_windows(
            ear, [replay_crop(len(w), seed_for(c['id'], 10 + k)) for k, w in enumerate(ear)]))
        print(f'[cand] {c["id"]:3d} {c["source"]}', flush=True)
    text = MusicClapText(os.path.join(onnx_dir, 'music_text.onnx'), threads=threads)
    prompts = all_prompts()
    tvec = text.embed_text(prompts)
    t0 = time.perf_counter()
    for p in prompts:
        text.embed_text([p])
    text_secs = (time.perf_counter() - t0) / len(prompts)

    extra = {}
    if general_audio or general_text:
        import onnx_backend
    if general_audio:
        # The 1.11 shipped path for the general model: onnx_backend.OnnxCLAPBackend, first 480000
        # samples of each window, mean, L2 (analyzer.py get_audio_embedding).
        gb = onnx_backend.OnnxCLAPBackend(general_audio)
        gb.load_model()
        if threads:
            import onnxruntime as ort
            so = ort.SessionOptions()
            so.intra_op_num_threads = threads
            so.inter_op_num_threads = 1
            gb._sess = ort.InferenceSession(general_audio, sess_options=so,
                                            providers=['CPUExecutionProvider'])
            gb._run = lambda feeds: gb._sess.run([gb._out_name], feeds)
        gv, gsecs = [], []
        for c in clips:
            _, v111, _ = load_audio(work, c['id'])
            t0 = time.perf_counter()
            per = np.stack([gb.embed_clips([w])[0] for w in v111])
            gsecs.append((time.perf_counter() - t0) / len(v111))
            gv.append(unit(per.mean(0)))
        extra['general_v111'] = np.stack(gv)
        extra['general_secs_per_window'] = np.array(gsecs)
    if general_text:
        gt = onnx_backend.OnnxTextCLAPBackend(general_text)
        extra['general_text'] = gt.embed_text(prompts)
    if july_model:
        # The July engine's model file (vibe_engine/ear), fed one quantized 480000-sample window per
        # run as Ear._embed_window does, and also as a batch, as embed_deam.py did.
        import onnxruntime as ort
        from music_clap_mel import quantize
        js = ort.InferenceSession(july_model, providers=['CPUExecutionProvider'])

        def july_input(w):
            q = quantize(w)
            if len(q) < WIN:  # Ear._embed_window: tile, then cut
                q = np.tile(q, int(np.ceil(WIN / len(q))))
            return q[:WIN].astype(np.float32)

        def july(ws):
            return js.run(None, {'waveform': np.stack([july_input(w) for w in ws])})[0]

        for c in clips:
            _, _, ear = load_audio(work, c['id'])
            extra[f'july_ear_win_{c["id"]}'] = np.concatenate([july([w]) for w in ear])
            if c['source'] == 'deam':
                dw = load_deam_windows(work, c['id'])
                extra[f'july_deam_batched_{c["id"]}'] = july(dw).mean(0)
                extra[f'july_deam_single_{c["id"]}'] = np.concatenate(
                    [july([w]) for w in dw]).mean(0)
                extra[f'music_deam_{c["id"]}'] = audio.embed_windows(dw).mean(0)

    assert 'torch' not in sys.modules, 'the candidate path imported torch'
    np.savez(os.path.join(work, 'cand.npz'), v110=np.stack(res['v110']),
             v111=np.stack(res['v111']), text=tvec, text_secs=text_secs,
             secs_per_window=np.array(res['secs_per_window']),
             mel_secs=np.array(res['mel_secs']),
             **{f'v110_draws_{i}': d for i, d in enumerate(res['v110_draws'])},
             **{f'v111_win_{i}': w for i, w in enumerate(wins_all)},
             **{f'ear_win_{i}': w for i, w in enumerate(ear_all)}, **extra)


# ---- compare --------------------------------------------------------------------------------

def cos(a, b):
    return float(np.dot(unit(np.asarray(a, np.float64)), unit(np.asarray(b, np.float64))))


def summary(vals):
    v = np.asarray(vals, np.float64)
    return {'n': int(v.size), 'min': float(v.min()), 'median': float(np.median(v)),
            'max': float(v.max())}


def stage_compare(work):
    clips = json.load(open(os.path.join(work, 'clips.json')))
    ref = np.load(os.path.join(work, 'ref.npz'))
    cand = np.load(os.path.join(work, 'cand.npz'))
    real = [c['id'] for c in clips if c['source'] != 'fixture']
    rep = {'clips': len(clips), 'real_clips': len(real)}

    per_clip = []
    for c in clips:
        i = c['id']
        rw, cw = ref[f'v111_win_{i}'], cand[f'v111_win_{i}']
        per_clip.append({
            'id': i, 'source': c['source'], 'sr': c['sr'], 'channels': c['channels'],
            'duration': round(c['duration'], 2), 'windows': len(c['offsets']),
            'cos_v110': cos(ref['v110'][i], cand['v110'][i]),
            'cos_v111': cos(ref['v111'][i], cand['v111'][i]),
            'cos_v111_window_min': min(cos(a, b) for a, b in zip(rw, cw)),
            'maxabs_v110': float(np.abs(unit(ref['v110'][i]) - cand['v110'][i]).max()),
            'maxabs_v111': float(np.abs(ref['v111'][i] - cand['v111'][i]).max()),
            'cos_ear_window_min': min(cos(a, b) for a, b in
                                      zip(ref[f'ear_win_{i}'], cand[f'ear_win_{i}'])),
        })
    rep['per_clip'] = per_clip
    for key in ('cos_v110', 'cos_v111', 'cos_v111_window_min', 'cos_ear_window_min'):
        rep[key] = summary([p[key] for p in per_clip])
    rep['maxabs_v110'] = max(p['maxabs_v110'] for p in per_clip)
    rep['maxabs_v111'] = max(p['maxabs_v111'] for p in per_clip)

    rt, ct = ref['text'], cand['text']
    rep['text'] = summary([cos(a, b) for a, b in zip(rt, ct)])
    rep['text_maxabs'] = float(np.abs(unit(rt) - ct).max())
    rep['text_prompts'] = len(rt)

    # 1.10 picks a random 10 s of the middle 60 s, so two runs of 1.10 on one song differ.
    draws = []
    for i in real:
        d = cand[f'v110_draws_{i}']
        draws += [cos(d[a], d[b]) for a in range(3) for b in range(a + 1, 3)]
        draws += [cos(cand['v110'][i], d[a]) for a in range(3)]
    rep['v110_run_to_run'] = summary(draws)
    rep['v110_vs_v111_same_model'] = summary([cos(cand['v110'][i], cand['v111'][i])
                                              for i in real])

    if 'general_v111' in cand.files:
        rep['music_vs_general_v111'] = summary([cos(ref['v111'][i], cand['general_v111'][i])
                                                for i in real])
        rep['general_secs_per_window'] = summary(cand['general_secs_per_window'])
    if 'general_text' in cand.files:
        rep['music_vs_general_text'] = summary([cos(a, b) for a, b in
                                                zip(rt, cand['general_text'])])
    rep['ref_secs_per_window'] = summary(ref['secs_per_window'])
    rep['cand_secs_per_window'] = summary(cand['secs_per_window'])
    rep['cand_mel_secs_per_window'] = summary(cand['mel_secs'])
    rep['cand_text_secs_per_prompt'] = float(cand['text_secs'])

    # The July engine's model against the music checkpoint on identical windows.
    if 'july_ear_win_0' in cand.files:
        # Full 10 s windows only: Ear fills a short clip differently from laion_clap.
        rep['july_model_vs_music_ref_per_window'] = summary(
            [cos(a, b) for i in real if clips[i]['duration'] > 10.5
             for a, b in zip(ref[f'ear_win_{i}'], cand[f'july_ear_win_{i}'])])

    # Vectors already on disk for the same clips.
    stored = {}
    ear_mean = {i: unit(cand[f'ear_win_{i}'].mean(0)) for i in real}
    jm = np.load(JULY_MTT)
    jmap = dict(zip(jm['ids'].tolist(), jm['emb']))
    gm = np.load(GENERAL_MTT)
    gmap = dict(zip(gm['ids'].tolist(), gm['emb']))
    mtt = [c for c in clips if c['source'] == 'mtt']
    stored['july_engine_mtt_vs_music_ear_recipe'] = summary(
        [cos(jmap[c['key']], ear_mean[c['id']]) for c in mtt])
    stored['shipped_1_11_general_mtt_vs_music_v111'] = summary(
        [cos(gmap[c['key']], cand['v111'][c['id']]) for c in mtt])
    if 'general_v111' in cand.files:
        stored['shipped_1_11_general_mtt_vs_general_rerun'] = summary(
            [cos(gmap[c['key']], cand['general_v111'][c['id']]) for c in mtt])
    jmemo = np.load(JULY_MEMO)
    mmap = dict(zip([str(s) for s in jmemo['song_id']], jmemo['emb']))
    memo = [c for c in clips if c['source'] == 'memo2496']
    stored['july_engine_memo2496_vs_music_ear_recipe'] = summary(
        [cos(mmap[c['key']], ear_mean[c['id']]) for c in memo])
    gp = np.load(GENERAL_POOL)
    pmap = dict(zip(gp['ids'].tolist(), gp['emb']))
    pool = [c for c in clips if c['source'].startswith('pool') and c['key'] in pmap]
    if pool and 'general_v111' in cand.files:
        stored['kima_embed_general_pool_vs_general_rerun'] = summary(
            [cos(pmap[c['key']], cand['general_v111'][c['id']]) for c in pool])
    jd = np.load(JULY_DEAM)
    dmap = dict(zip([str(int(s)) for s in jd['sid']], jd['clap']))
    deam = [c for c in clips if c['source'] == 'deam']
    if 'music_deam_' + str(deam[0]['id']) in cand.files:
        for name in ('music_deam', 'july_deam_single', 'july_deam_batched'):
            stored[f'deam_clap_npz_vs_{name}'] = summary(
                [cos(dmap[c['key']], cand[f'{name}_{c["id"]}']) for c in deam])
    rep['stored'] = stored

    json.dump(rep, open(os.path.join(work, 'report.json'), 'w'), indent=1)
    print(json.dumps({k: v for k, v in rep.items() if k != 'per_clip'}, indent=1))
    worst = sorted(per_clip, key=lambda p: min(p['cos_v110'], p['cos_v111']))[:5]
    print('worst clips:', json.dumps(worst, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('stage', choices=['decode', 'ref', 'cand', 'compare', 'fixture'])
    ap.add_argument('--work')
    ap.add_argument('--ckpt', default=os.path.join(SVC, 'cache', 'music_ckpt',
                                                   'music_audioset_epoch_15_esc_90.14.pt'))
    ap.add_argument('--onnx-dir', default=os.path.join(SVC, 'cache', 'music_onnx'))
    ap.add_argument('--threads', type=int, default=1)
    ap.add_argument('--general-audio', default=None)
    ap.add_argument('--general-text', default=None)
    ap.add_argument('--july-model', default=None)
    a = ap.parse_args()
    if a.stage == 'fixture':
        return stage_fixture(a.ckpt)
    if not a.work:
        ap.error(f'{a.stage} needs --work')
    os.makedirs(a.work, exist_ok=True)
    if a.stage == 'decode':
        stage_decode(a.work)
    elif a.stage == 'ref':
        stage_ref(a.work, a.ckpt, a.threads)
    elif a.stage == 'cand':
        sys.path.insert(0, SVC)
        stage_cand(a.work, a.onnx_dir, a.threads, a.general_audio, a.general_text, a.july_model)
    else:
        stage_compare(a.work)


if __name__ == '__main__':
    main()
