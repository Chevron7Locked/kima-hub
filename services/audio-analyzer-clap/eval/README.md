# Vibe evaluation harness

Scores the CLAP audio embedding that powers the vibe map and "more like this"
against **human judgments**, so every vibe change can be measured instead of
eyeballed. It embeds each evaluation set's audio with the **shipped** analyzer
code (`analyzer.CLAPAnalyzer.get_audio_embedding` on ONNX Runtime,
`models/hf_audio.onnx`, five 10 s windows, mean, L2-normalise), caches the
vectors, and scores them.

It lives here, next to the analyzer, because it imports the analyzer module
itself rather than a copy of its recipe: if someone changes the windowing, the
decoder or the model file, the next run measures the change. It is Python like
the analyzer, and the Dockerfiles copy the analyzer files one by one, so none
of this ships in an image.

## One command

```bash
cd services/audio-analyzer-clap/eval
./fetch_data.sh                 # once: audio + non-redistributable labels, checksum-verified
./run.sh                        # v1's shipped model on every set present
./run.sh --models v1 engine     # add the new vibe engine's model for a head-to-head
./run.sh --sets mtt_triplets    # just one set;  ./run.sh --list  shows what is present
```

`run.sh` builds a throwaway environment with `uv` from the analyzer's own
`requirements.txt` (plus scipy), so the analyzer imports exactly as it does in
the image. Data defaults to `eval/.cache/data`; point `KIMA_EVAL_DATA` at a
bigger disk or at existing copies (symlinks are fine). Embeddings are cached in
`eval/.cache/emb/<model-sha>-<recipe-sha>/` (git-ignored): a re-run only scores,
which takes seconds. The cache key includes the sha256 of the model file and of
`analyzer.py`, `onnx_backend.py` and `music_clap_mel.py`, so any edit to those files
re-embeds rather than reusing stale vectors. Results go to
`eval/.cache/results-<timestamp>.json` (or `--out`).

First full run on a 28-core Mac: about 45 min for v1 (all eight sets, 10,544
clips), about 2 h for the new engine's larger model. `--models engine` needs a
read-only checkout of the new engine (`--engine-dir`, default
`~/projects/kima/kima-hub/services/vibe-engine`) and uses its own `Ear` code.

## The sets, where they come from, and what we may redistribute

The repo is GPL-3.0. Only labels whose licence allows redistribution are
committed (`labels/`); everything else is fetched by `fetch_data.sh` and
checked against `SHA256SUMS`.

| Set | What humans judged | Clips | Licence (checked on the dataset's own page, 2026-09-24) | In repo |
|---|---|---|---|---|
| MagnaTagATune similarity (`mtt_triplets`) | odd-one-out of three 29 s clips; 533 triplets, 446 with a clear majority | 1,019 | CC BY-NC-SA 3.0 (tagatune.org licence text, archived 2016; mirg.city.ac.uk now hosts it with no licence text) | fetch only |
| Soundtracks Set 1 / Set 2 (Eerola & Vuoskoski 2011) | expert mean valence, energy, tension (1-9) on 15 s film-score excerpts | 360 / 110 | OSF node p6vkg: CC BY 4.0. The audio is excerpts of commercial film scores, which the depositors' licence cannot cover | **labels vendored** (`labels/soundtracks/`, unmodified); audio fetch only |
| IsoVAT (Plut et al.) | a composer's low/medium/high versions of the same bars, varying one of valence, arousal, tension | 90 | GitHub repo has no licence file, so all rights reserved | fetch only (pinned commit) |
| DEAM (Aljanaki et al. 2017) | song-level mean valence/arousal (1-9), 45 s clips | 1,802 | audio Creative Commons (mixed sources, several NonCommercial); the paper releases the data under CC BY-NC | fetch only |
| MERGE Audio Complete (Louro et al. 2024) | valence/arousal (0-1), 30 s song clips | 3,554 | Zenodo 13939205: CC BY-NC 4.0 | fetch only |
| Memo2496 (Li et al. 2025) | 30 experts' per-second valence/arousal on full instrumental tracks | 2,496 | Figshare 25827034: CC BY 4.0 | **labels vendored** as per-track means (`labels/memo2496/`, derived; see below); 12.3 GB audio fetch only |
| PMEmo 2019 (Zhang et al. 2018) | mean valence/arousal (0-1) on chorus excerpts of chart songs | 767 | code repo MIT; the authors state the songs are copyright-restricted (only choruses shared) | fetch only, manual (Google Drive) |

Not included: **FME-24** (annotations only; the 275 film cues are not
distributed), **4Q/MER-taffc** (96% of it is inside MERGE), **EmoMusic** (DEAM's
own precursor).

Attribution for the vendored labels:
- Eerola, T. & Vuoskoski, J. K. (2011). A comparison of the discrete and dimensional
  models of emotion in music. *Psychology of Music* 39(1), 18-49.
  doi:10.1177/0305735610362821. Files from https://osf.io/p6vkg/ (CC BY 4.0), unchanged.
- Li, Q. et al., Memo2496, doi:10.6084/m9.figshare.25827034.v8 (CC BY 4.0). **Changed:**
  each track's per-second `valence_all_average.csv` / `arousal_all_average.csv` series
  is reduced to its mean. Rebuild with
  `python3 datasets.py derive-memo valence_all_average.csv arousal_all_average.csv songs_info_all.csv out.csv`
  (reproduces the committed file byte for byte).

**Memo2496 trap:** the Figshare record also has `arousal_all_std.csv`, the
per-second spread *between raters*, with the same shape. The copy the new
engine's research used is byte-identical to that std file (md5 `7524b16f…`, Figshare file
52358366), not to the average (md5 `a582e8b6…`, file 52358360). Its
"Memo2496 intensity labels are unusable" finding was measured against rater
disagreement, not arousal. With the real average, arousal is the most
predictable thing in the set (r = 0.84 below).

## What is scored

- **Triplet agreement** (the similarity question itself). For each MTT triplet
  the model's odd one out is the clip whose removal leaves the most similar pair
  (highest cosine). Scored against the human majority; chance is 1/3. Same rule
  as the new engine's 446-triplet "67.0%" measurement, which this harness
  reproduces exactly (299/446 with the engine's model).
- **kNN-10 neighbour agreement** (valence/arousal/energy/tension sets). Each
  clip's rating is predicted as the mean rating of its 10 nearest neighbours by
  cosine, never counting itself or clips from its own film/artist; Pearson r
  with the true rating. No training: this is "do the tracks the map puts next to
  each other feel the same to people".
- **Linear probe** (how much of the rating the embedding holds at all). Ridge
  regression, penalty picked by exact leave-one-out on the training folds only,
  5 folds, whole films/artists kept in one fold. Pearson r of the out-of-fold
  predictions.
- **Soundtracks Set 1 blunt test**: the new engine's four checks (tender above
  angry, tender above fearful, designed-positive above designed-negative, happy
  above sad), applied to the out-of-fold valence probe. Pass = right direction
  and Welch p < 0.05. Note this probe is trained *within* Soundtracks (other
  films), so it is not the same experiment as the engine's cross-corpus model.
- **IsoVAT medium-between-extremes**: for each composed low/medium/high trio, is
  the low-high pair the farthest apart? Chance 1/3. Ten trios per dimension.

Intervals are 95%: Wilson for proportions, Fisher z for correlations, and for
the paired model comparison an exact McNemar test plus a 10,000-draw paired
bootstrap.

## Baseline (2026-09-24)

v1 = `models/hf_audio.onnx` (sha256 `37df17af…`, laion/clap-htsat-unfused,
HTSAT-tiny) through the shipped analyzer. Engine = the new vibe engine's
`clap_audio_fp32.onnx` (sha256 `8233f5c3…`) through its own `Ear`. Every clip of
every set embedded; 0 clips failed for either model (v1's analyzer dropped one
unreadable 10 s window of one Memo2496 track and averaged the rest, which is its
shipped behaviour). Full numbers: `results/baseline-2026-09-24.json`.

**Triplets, same 446 judgments:**

| | agreement [95% CI] |
|---|---|
| v1 | **0.655** [0.609, 0.697] (292/446) |
| engine | **0.670** [0.625, 0.712] (299/446; reproduces the engine's published 67.0%) |
| v1 minus engine | −0.016 [−0.058, +0.027]; McNemar p = 0.53 (42 triplets only v1 got right, 49 only the engine) |

No measurable difference: the interval straddles zero and a gap this size
would need about 14 times as many triplets (~6,500) to resolve at 80% power. (Wilson bounds and the
McNemar p were re-checked in Wolfram|Alpha.)

**Valence / arousal (Pearson r [95% CI]; n = clips):**

| set (n) | dimension | v1 kNN-10 | v1 probe | engine kNN-10 | engine probe |
|---|---|---|---|---|---|
| Soundtracks 1 (360) | valence | 0.785 [0.742, 0.822] | 0.841 [0.808, 0.869] | 0.786 [0.743, 0.823] | 0.844 [0.811, 0.871] |
| | energy | 0.783 [0.739, 0.820] | 0.856 [0.825, 0.881] | 0.775 [0.731, 0.814] | 0.850 [0.818, 0.876] |
| | tension | 0.818 [0.781, 0.849] | 0.846 [0.814, 0.873] | 0.815 [0.777, 0.847] | 0.852 [0.821, 0.878] |
| Soundtracks 2 (110) | valence | 0.612 [0.480, 0.717] | 0.775 [0.687, 0.840] | 0.748 [0.652, 0.820] | 0.796 [0.715, 0.856] |
| | energy | 0.838 [0.772, 0.886] | 0.877 [0.826, 0.914] | 0.857 [0.798, 0.900] | 0.857 [0.798, 0.900] |
| | tension | 0.725 [0.622, 0.803] | 0.820 [0.747, 0.873] | 0.786 [0.702, 0.848] | 0.837 [0.771, 0.886] |
| DEAM (1,802) | valence | 0.714 [0.691, 0.736] | 0.754 [0.733, 0.773] | 0.725 [0.702, 0.746] | 0.762 [0.742, 0.781] |
| | arousal | 0.766 [0.746, 0.784] | 0.807 [0.790, 0.822] | 0.791 [0.773, 0.807] | 0.822 [0.807, 0.837] |
| MERGE (3,554) | valence | 0.619 [0.599, 0.639] | 0.632 [0.612, 0.651] | 0.664 [0.646, 0.682] | 0.685 [0.667, 0.702] |
| | arousal | 0.703 [0.686, 0.719] | 0.713 [0.696, 0.729] | 0.721 [0.705, 0.737] | 0.748 [0.733, 0.762] |
| Memo2496 (2,496) | valence | 0.667 [0.644, 0.688] | 0.690 [0.669, 0.710] | 0.680 [0.658, 0.701] | 0.698 [0.677, 0.718] |
| | arousal | 0.817 [0.804, 0.830] | 0.838 [0.826, 0.850] | 0.826 [0.813, 0.838] | 0.843 [0.832, 0.854] |
| PMEmo (767) | valence | 0.734 [0.699, 0.765] | 0.766 [0.735, 0.793] | 0.766 [0.736, 0.794] | 0.786 [0.757, 0.811] |
| | arousal | 0.787 [0.758, 0.813] | 0.859 [0.839, 0.876] | 0.811 [0.786, 0.834] | 0.871 [0.853, 0.887] |

The two intervals for one row are computed separately; overlapping intervals are
not a paired test. They fail to overlap only for MERGE valence (both scores) and
the MERGE arousal probe, engine ahead by about 0.04-0.05. Everywhere else the two
models are within noise of each other.

**Soundtracks Set 1 blunt test** (out-of-fold valence probe, 30 excerpts per group):
both models pass 3 of 4. Tender above angry, tender above fearful and
designed-positive above designed-negative all pass at p < 1e-13. Happy above sad
fails for both, in the wrong direction (v1 −0.34 [−0.74, +0.05], p = 0.08; engine
−0.41 [−0.81, −0.02], p = 0.04). The experts themselves separate happy from sad by only
5.37 vs 5.04 on a 9-point scale.

**IsoVAT medium-between-extremes** (chance 0.333): v1 17/30 = 0.567
[0.392, 0.726] (valence 3/10, arousal 9/10, tension 5/10); engine 16/30 = 0.533
[0.361, 0.698] (4/10, 7/10, 5/10). Only arousal is clearly above chance, and ten
trios per dimension cannot tell the models apart.

### Which checkpoint is the new engine's 285 MB model?

It is the audio half of **`music_audioset_epoch_15_esc_90.14.pt`** from
`lukewys/laion_clap` on Hugging Face (LAION-CLAP, HTSAT-base, licence CC0-1.0).
Evidence: its graph is HTSAT-base (embed 128, depths 2/2/12/2, 71.1 M params,
raw 480,000-sample waveform in, 512-d out, laion_clap tensor names), and all 167
named weight tensors are **exactly equal** (max difference 0.0) to that
checkpoint's, as are 75 of the 96 unnamed matrices; the other 21 are constants
the exporter folded (all 18 relative-position biases equal
`table[index]` from the checkpoint; 3 are shifted-window masks). It does **not**
match any Hugging Face `laion/larger_clap_*` model: against `larger_clap_music`
the batch-norm running mean differs by up to 59.8. (`larger_clap_general` matches
`music_speech_audioset_epoch_15_esc_89.98.pt` and `larger_clap_music_and_speech`
matches `music_speech_epoch_15_esc_89.25.pt` on the same probe tensors.)

A matching **text encoder exists**: the same `.pt` file carries the text tower
(200 `text_branch` RoBERTa tensors plus `text_projection`). No ONNX export of it
is published (the Xenova ONNX ports cover `clap-htsat-unfused` and
`larger_clap_general`, i.e. different weights), so using it for text search
would need our own export plus a parity test. v1's `models/text_model.onnx` is
Xenova's `clap-htsat-unfused` text model (sha256 `6df7c51f…`), the right partner
for v1's audio model and not for the engine's.

## Post-processing experiments (2026-09-24): nothing beats plain cosine

Question: without changing the model, can a transform applied to the stored
512-d vectors (using statistics of the user's library) make "similar" agree
better with people? `postprocess_eval.py` re-scores the cached v1 vectors
under each transform in about 2 minutes; full output in
`results/postprocess-2026-09-24.json`.

**Answer: no.** No transform gave a significant triplet gain, the best ones
move agreement by +0.011 (5 triplets of 446), and every transform that the
anisotropy literature recommends most strongly (all-but-the-top, whitening)
makes matching much *worse*. v1 keeps plain cosine on the raw vectors.

**Why these ideas.** The space is anisotropic: the mean of the unit vectors has
length 0.73-0.90 depending on the set, the average pairwise cosine is 0.54-0.81,
and the top 10 principal directions carry 67-75% of the variance. For
anisotropic text embeddings, subtracting the mean and the top directions
("eliminate the common mean vector and a few top dominating directions",
Mu & Viswanath, *All-but-the-Top*, ICLR 2018, arXiv:1702.01417) and PCA
whitening (Su et al. 2021, arXiv:2103.15316) improve similarity. Separately,
nearest-neighbour search in high dimensions suffers from "hubs", tracks that
turn up in everyone's neighbour list (Radovanović et al., JMLR 2010); centering
("shifts the origin of the space to the data centroid, provides an effective
way to reduce hubs", Suzuki et al., EMNLP 2013, doi:10.18653/v1/d13-1058),
mutual proximity (Schnitzer, Flexer, Schedl & Widmer, JMLR 2012, a music-similarity
paper) and CSLS (`2cos(x,y) - r(x) - r(y)`, r = mean cosine to the 10 nearest
library neighbours; Conneau et al., ICLR 2018, arXiv:1710.04087, eq. 6) are the
standard remedies. Database-side augmentation / α-weighted query expansion
(Radenović et al., arXiv:1711.02512) smooths each vector with its neighbours.

**How it was measured.** Each evaluation set stands in for a library: its
statistics come from its own clips, without labels ("own library", which is
what Kima would do). "Foreign library" takes them from the union of the other
seven sets instead, i.e. a cold start or a library unlike the tracks being
compared. Overfitting guard: the 446 triplets were split once (seed 20260924)
into halves A and B of 223; each family's parameter was picked on A only and
reported on B. Every variant is also scored on the 14 valence/arousal/energy/
tension kNN-10 neighbour correlations; their paired change against baseline is
a 2,000-draw bootstrap over clips. Triplet comparisons use the exact McNemar
test (p values re-checked in Wolfram|Alpha: 28 vs 23 discordant → 0.576;
23 vs 14 → 0.188; 31 vs 26 → 0.597).

Own-library results (baseline 0.655 [0.609, 0.697], half B 0.673; "kNN" is the
change in r over the 14 mood rows, and how many of them have a 95% interval
entirely above / below zero):

| transform | triplets [95% CI] | change vs baseline [95% CI] | discordant, McNemar p | half B | kNN median change (range) | kNN up / down |
|---|---|---|---|---|---|---|
| centre (subtract library mean) | 0.666 [0.621, 0.708] | +0.011 [−0.020, +0.043] | 28/23, p = 0.58 | 0.695 | −0.002 (−0.019 to +0.066) | 1 / 1 |
| centre, foreign library | 0.643 [0.598, 0.687] | −0.011 [−0.052, +0.029] | 38/43, p = 0.66 | 0.664 | −0.001 | 0 / 2 |
| all-but-the-top, D = 1 | 0.435 [0.390, 0.481] | −0.220 [−0.274, −0.164] | 38/136, p = 4e−14 | 0.480 | −0.022 | 0 / 10 |
| all-but-the-top, D = 5 (best on A) | 0.381 | −0.274 | 40/162, p = 1e−18 | 0.350 | −0.196 | 0 / 14 |
| PCA whitening, 32 dims (best on A) | 0.480 | −0.175 | 42/120, p = 7e−10 | 0.471 | −0.015 | 0 / 5 |
| PCA whitening, all 512 dims | 0.354 | −0.300 | 54/188, p = 1e−18 | 0.354 | −0.085 | 0 / 12 |
| shrunk whitening (Σ + 4·mean eig·I)^−½ (best on A) | 0.527 | −0.128 | 38/95, p = 8e−7 | 0.529 | +0.003 | 1 / 0 |
| centre + keep top 64 PCs (best on A) | 0.666 | +0.011 [−0.020, +0.043] | 28/23, p = 0.58 | 0.695 | −0.001 | 1 / 0 |
| centre + sharpen top PCs, eig^0.5 (best on A) | 0.661 | +0.007 [−0.027, +0.043] | 33/30, p = 0.80 | 0.673 | −0.013 | 0 / 5 |
| neighbour smoothing (DBA, k = 1, best on A) | 0.659 | +0.004 [−0.020, +0.029] | 17/15, p = 0.86 | 0.668 | −0.018 | 0 / 8 |
| CSLS, k = 10 | 0.635 [0.589, 0.678] | −0.020 [−0.047, +0.004] | 13/22, p = 0.18 | 0.646 | +0.005 | 4 / 0 |
| centre + CSLS, k = 10 | 0.650 [0.605, 0.693] | −0.004 [−0.038, +0.029] | 28/30, p = 0.90 | 0.686 | +0.009 (−0.004 to +0.065) | 5 / 0 |
| mutual proximity | 0.655 | +0.000 | 12/12, p = 1 | 0.691 | +0.002 | 0 / 1 |
| centre + mutual proximity (best on A) | 0.666 [0.621, 0.708] | +0.011 [−0.022, +0.045] | 31/26, p = 0.60 | 0.704 | +0.002 (−0.012 to +0.078) | 3 / 0 |

Picked-on-A, confirmed-on-B: centring +0.022 [−0.018, +0.063] (McNemar
p = 0.38); centre + mutual proximity +0.031 [−0.009, +0.076] (p = 0.21);
every other family's pick is flat or significantly worse on B.

What the numbers say, in words:

1. **Centring is harmless and useless here.** +5 triplets with the own
   library, −5 with a foreign one, no mood row moves beyond noise except
   Soundtracks Set 2 valence (+0.066, n = 110 film excerpts). The reason
   it does little: this space has almost no hub problem to fix. The skewness
   of the "how often is a clip someone's top-10 neighbour" count is 0.75 on the
   MTT clips (0.65 after centring), and the re-scorings built specifically
   against hubs (CSLS, mutual proximity) leave triplets flat too.
2. **Removing or flattening the dominant directions destroys the signal.** In
   word vectors the top directions encode word frequency, which is noise for
   meaning. In this CLAP space they encode what people hear as similar:
   dropping only the first direction takes triplet agreement from 0.655 to
   0.435, and full whitening leaves it at chance (0.354 vs 1/3). The whitening
   code was cross-checked against scikit-learn's `PCA(whiten=True)` (0.480 vs
   0.482 at 32 dims, identical at 128) and large-penalty shrinkage reproduces
   plain centring exactly, so this is the space, not a bug. It is the
   opposite of the text-embedding result and a reason not to port NLP recipes
   blindly.
3. **Hub-reduction re-scorings trade the core question for small mood gains.**
   Centre + CSLS nudges 13 of 14 mood-neighbour correlations up (+0.001 to
   +0.012 on the four large sets, up to +0.021 on Soundtracks Set 1 and +0.065
   on Set 2) while triplet
   agreement is flat (−0.004). About 80 transform/library combinations were
   scored on 15 outcomes each, so a handful of small intervals clearing zero
   is expected by chance; this is a lead, not a result. It would also change
   what "distance" means everywhere (no longer a cosine, so the pgvector index
   cannot rank by it directly) for ~0.01 of correlation. Not shipped.
4. **Cold start is not a reason to precompute anything.** Library means differ
   (cosine between two sets' mean vectors 0.56-0.97), and a foreign mean is
   slightly worse than none, so a shipped "global" mean would not help either.

**Window pooling (idea 2) could not be tested on the cached vectors**: the cache
holds only the final pooled vector per clip, not the five window vectors.
Re-embedding is needed, and was not run on this Mac. More importantly, the
human data mostly cannot answer it: windows actually used per clip (40-clip
sample per set, `min(5, duration // 10 s)`) are MTT 2.0, Soundtracks 1.0-1.2,
IsoVAT 1.0, MERGE 2.6, PMEmo 3.3, DEAM 4.0, Memo2496 5.0. The one human
*similarity* set has two 10 s windows per clip, so mean vs
max vs GeM (generalised-mean pooling, Radenović et al.) would barely differ
there. Only Memo2496 (2,496 full instrumental tracks) spans a whole track, and
it carries valence/arousal only. What a test-server run needs:
- an embedder variant that returns the per-window vectors
  (`OnnxCLAPBackend.embed_clips` over the `compute_window_offsets` windows) and
  caches them under a new key, e.g. `v1win-...` with shape (n, 5, 512);
- about 12,500 window inferences for Memo2496 alone (~36% of the 34,000
  windows in the whole 45-minute Mac run, so roughly 15-20 minutes at that
  speed; not measured) plus ~7,200 for DEAM;
- a pooling sweep scored with the same kNN metrics (mean [shipped], median,
  trimmed mean, GeM p ∈ {2, 3}, mean of centred windows), picked on DEAM and
  confirmed on Memo2496;
- for the similarity question itself, a human-judged set built from full tracks
  (none of the eight sets here is one). Without it, a pooling change could only
  be justified by mood-neighbour numbers.

Not checked: text search (a query's text embedding against the library). No
set here pairs text queries with human relevance labels (the MTT tag file is
not in the data root), so no transform was scored for search. Note that
subtracting a library mean from the audio vectors alone does not change the
dot product ranking for a fixed text query, only the per-track norms, so any
effect on search would come through those norms.

## Files

- `vibe_eval.py`: the CLI (loads sets, embeds with cache, scores, writes JSON).
- `postprocess_eval.py`: post-processing experiments on the cached vectors (section above).
- `datasets.py`: one loader per set, plus `derive-memo`.
- `fit_feel_probe.py`: fits the feel probe on DEAM and writes `backend/src/services/matching/feelProbe.json`.
- `calibrate_platt.py`, `calibration/`: fits the valence and arousal sigmoid on a labelled set (`--fit-on`) and writes `calibration/platt-<set>.json`. The analyzer's `VA_CALIB` is the `platt-memo2496.json` fit.
- `matching_parity_fixture.py`, `map_parity_fixture.py`: write the fixtures the backend's matching and map tests compare the TypeScript against (`parity.json`, `map-parity.json`).
- `mert_bakeoff.py`: scores a Hugging Face music encoder against the shipped model on the human sets.
- `run.sh`: the one-command runner from the section above.
- `embedders.py`: the v1 and engine embedders and the cache.
- `metrics.py`: every score and interval.
- `fetch_data.sh`, `SHA256SUMS`: downloads and their checksums.
- `labels/`: the redistributable labels (CC BY 4.0).
- `results/`: the committed baseline JSON behind the tables above.
