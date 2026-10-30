# NVIDIA GPU

Kima runs on the processor by default and nothing about the graphics card is touched until an administrator turns it on. If the container can see an NVIDIA card, two jobs can run on it:

- **Vibe embeddings:** the sound vector of each song (the CLAP model). In one test on an RTX 4060 Ti the model took 11.7 milliseconds for a 10-second clip, against 114 on the processor, and the processor stays free for everything else. How much faster a whole library finishes depends on the other steps too.
- **Audio analysis:** the MusiCNN models behind tempo, key, energy, valence and arousal.

The GPU runtime is for Linux on x86-64 only. Kima on ARM, on a Mac or without a card runs on the processor as usual.

## What you need

- An NVIDIA card and a host driver that supports CUDA 12.4 or newer. `nvidia-smi` should work on the host.
- The [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html), which lets Docker give a container the card.
- The all-in-one image or the split stack, started with the card passed through as below.

## Give the container the card

Run the all-in-one image with:

```bash
docker run -d --name kima --gpus all \
  --device /dev/nvidia0 --device /dev/nvidiactl \
  --device /dev/nvidia-uvm --device /dev/nvidia-uvm-tools \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v kima_data:/data \
  chevron7locked/kima:latest
```

The `--device` lines keep the card available after the host reloads its services (`systemctl daemon-reload`). Without them, on hosts where systemd manages Docker's control groups, anything the container starts afterwards cannot open the card. NVIDIA describes this in its [troubleshooting notes](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/troubleshooting.html).

With the split stack, add the same lines to the `audio-analyzer` and `audio-analyzer-clap` services in `docker-compose.yml`:

```yaml
        gpus: all
        devices:
            - /dev/nvidia0
            - /dev/nvidiactl
            - /dev/nvidia-uvm
            - /dev/nvidia-uvm-tools
```

Then run `docker compose up -d`.

To check that the container sees the card, run `docker exec kima nvidia-smi`. It should list your card.

## Turn it on

Seeing the card is not enough. An administrator chooses what uses it. Open **Settings > Library Enrichment** and use the two switches:

- **NVIDIA GPU for vibe embeddings**
- **NVIDIA GPU for audio analysis**

Both switches are off by default. The window that opens after an update asks the same question once. The switches only appear on Linux on x86-64.

The first switch you turn on downloads the GPU runtime: twelve pinned packages from PyPI, about 2 GB. Kima checks every file against a fixed fingerprint before installing, and the packages take about 3.4 GB in your data folder. Nothing about your library leaves your server. Nothing is added to the Docker image, so if you never turn a switch on, you download nothing. When both switches are off again, the download stays on disk and does nothing, so turning a switch on later uses it at once with no new download. To get the space back, turn both switches off and stop Kima. With the single image, the runtime is the `gpu-onnx` folder inside whatever you mounted at `/data`: delete it from that host folder, or, for a named volume such as `kima_data`, run `docker run --rm -v kima_data:/data alpine rm -rf /data/gpu-onnx`. With the split stack, the runtime lives in its own Docker volume: run `docker compose down`, then `docker volume rm` on the volume whose name ends in `gpu_runtime_data` (`docker volume ls` lists it). Start Kima again. Turning a switch on after that downloads the runtime again.

A switch takes effect within about a minute, without restarting Kima. The analyzer finishes the songs it is on, then restarts with the card on or off. It is safe to turn on partway through a run.

## Check that it is working

Each switch shows a status line. "Active" means the card is doing the work. The other states say what is happening, or why not:

| Status line | Meaning |
| --- | --- |
| Off (CPU) | The switch is off and no runtime is installed. |
| Runtime installed; GPU is off. | The runtime is on disk but this switch is off. It is kept so you can switch back on without downloading again. |
| Waiting for the vibe embeddings analyzer, which does the download | A switch is on, but the vibe embeddings analyzer, which does the download, has not checked in for 90 seconds. It may be starting up or stopped. |
| Enabled, downloading | A switch is on and the download is about to start. |
| Downloading GPU runtime (~2 GB)… | The first download is running. |
| Installed, applying (the analyzer restarts between songs) | The analyzer restarts between songs, then uses the card. |
| Active | The card is doing the work. |
| Installed, but the GPU session fell back to the CPU | The card could not be used. The work carries on on the processor. |
| Failed: no NVIDIA GPU visible | The container cannot see the card. Check the steps above. |
| Failed: NVIDIA driver too old | The host driver does not support CUDA 12.4. |
| Failed: Linux x86_64 only | This machine or image is not Linux on x86-64. |
| Failed: package index unreachable | Kima could not reach PyPI to download the runtime. |
| Failed: checksum mismatch | A downloaded file did not match its fixed fingerprint, so it was not installed. |

An administrator can also ask the API:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3030/api/system-settings/gpu
```

For vibe embeddings the reply has `"effective": true` when the card is in use. For audio analysis it is `"analysisEffective": true`. If the container cannot see the card, `"reason"` is `"no_gpu"`.

Whenever the card cannot be used, the work continues on the processor.
