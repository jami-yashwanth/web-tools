import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MODELS, modelFiles, modelUrl } from '../../src/ai/config';
import { WHISPER_FILES, WHISPER_GPU_FILES, WHISPER_REVISION, WHISPER_SHA256 } from '../../src/ai/whisper/files';
import { STRIDE_S, WINDOW_S, ownSpan, planWindows } from '../../src/ai/whisper/windows';
import { usesWebGpu } from '../../src/ui/transcribe';

describe('planWindows: 30 s windows that overlap by 5 s, as the transformers.js pipeline cuts them', () => {
  const R = 16_000;

  it('audio of 30 s or less is one window, with nothing shared', () => {
    expect(planWindows(2 * R, R)).toEqual([{ start: 0, end: 2 * R, strideLeft: 0, strideRight: 0 }]);
    expect(planWindows(30 * R, R)).toEqual([{ start: 0, end: 30 * R, strideLeft: 0, strideRight: 0 }]);
  });

  it("longer audio moves on 20 s at a time; inner edges share 5 s, the audio's own ends nothing", () => {
    expect(planWindows(65 * R, R)).toEqual([
      { start: 0, end: 30 * R, strideLeft: 0, strideRight: 5 * R },
      { start: 20 * R, end: 50 * R, strideLeft: 5 * R, strideRight: 5 * R },
      { start: 40 * R, end: 65 * R, strideLeft: 5 * R, strideRight: 0 },
    ]);
  });

  it('covers 30 minutes in 90 windows, the last ending at the end', () => {
    const w = planWindows(30 * 60 * R, R);
    expect(w).toHaveLength(90);
    expect(w.at(-1)!.end).toBe(30 * 60 * R);
  });

  it("each window's own part (unshared) tiles the audio without gaps or overlaps", () => {
    const w = planWindows(65 * R, R);
    expect(w.map((x) => ownSpan(x, R))).toEqual([
      [0, 25],
      [25, 45],
      [45, 65],
    ]);
  });

  it('windows are 30 s with 5 s shared', () => {
    expect([WINDOW_S, STRIDE_S]).toEqual([30, 5]);
  });
});

describe('Whisper model files', () => {
  it('every file is pinned to one commit of Xenova/whisper-base, and the model size is their sum', () => {
    expect(WHISPER_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(MODELS.whisper.path).toBe(`Xenova/whisper-base/resolve/${WHISPER_REVISION}`);
    const sum = Object.values(WHISPER_FILES).reduce((n, f) => n + f.bytes, 0);
    expect(MODELS.whisper.bytes).toBe(sum);
    expect(Math.round(sum / 1e6)).toBe(80);
    for (const h of Object.values(WHISPER_SHA256)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists what the pipeline loads: config, generation config, preprocessor, tokenizer and the q8 encoder and decoder', () => {
    expect(Object.keys(WHISPER_FILES).sort()).toEqual(
      [
        'config.json',
        'generation_config.json',
        'onnx/decoder_model_merged_quantized.onnx',
        'onnx/encoder_model_quantized.onnx',
        'preprocessor_config.json',
        'tokenizer.json',
        'tokenizer_config.json',
      ].sort(),
    );
  });

  it('the WebGPU set shares the configuration and tokenizer, with q4f16 encoder and decoder', () => {
    const shared = Object.keys(WHISPER_FILES).filter((f) => !f.endsWith('.onnx'));
    expect(Object.keys(WHISPER_GPU_FILES).sort()).toEqual(
      [...shared, 'onnx/encoder_model_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx'].sort(),
    );
    expect(MODELS.whisperGpu.path).toBe(MODELS.whisper.path);
    expect(MODELS.whisperGpu.bytes).toBe(Object.values(WHISPER_GPU_FILES).reduce((n, f) => n + f.bytes, 0));
    expect(Object.keys(WHISPER_SHA256).sort()).toEqual([...new Set([...Object.keys(WHISPER_FILES), ...Object.keys(WHISPER_GPU_FILES)])].sort());
  });

  it('modelFiles gives each file of a directory model its own URL and size, and a single-file model itself', () => {
    const files = modelFiles('whisper');
    expect(files).toHaveLength(Object.keys(WHISPER_FILES).length);
    expect(files[0]!.url).toBe(`${modelUrl('whisper')}/${Object.keys(WHISPER_FILES)[0]}`);
    expect(files.reduce((n, f) => n + f.bytes, 0)).toBe(MODELS.whisper.bytes);
    expect(modelFiles('upscale')).toEqual([{ url: modelUrl('upscale'), bytes: MODELS.upscale.bytes }]);
  });

  it("the WebGPU runtime is onnxruntime-web's asyncify .wasm, from the model host, at its real size", () => {
    const file = createRequire(import.meta.url).resolve('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm');
    expect(MODELS.ortWebgpu.bytes).toBe(statSync(file).size);
    expect(MODELS.ortWebgpu.path).toBe('onnxruntime-web/1.30.0/ort-wasm-simd-threaded.asyncify.wasm');
    expect(MODELS.ortWebgpu.sameOrigin).toBeUndefined();
  });
});

describe('usesWebGpu', () => {
  it('on a computer with WebGPU that runs 16-bit shaders only, where the model host was set', () => {
    const gpu = { webgpu: true, webgpuF16: true, mobile: false };
    expect(usesWebGpu(gpu, true)).toBe(true);
    expect(usesWebGpu({ ...gpu, webgpuF16: false }, true)).toBe(false);
    expect(usesWebGpu({ ...gpu, mobile: true }, true)).toBe(false);
    expect(usesWebGpu({ ...gpu, webgpu: false, webgpuF16: false }, true)).toBe(false);
  });

  it('never on the default model host (it has no WebGPU runtime), which a build without PUBLIC_MODEL_BASE_URL uses', () => {
    expect(usesWebGpu({ webgpu: true, webgpuF16: true, mobile: false }, false)).toBe(false);
    expect(usesWebGpu({ webgpu: true, webgpuF16: true, mobile: false })).toBe(false); // this unit build sets none
  });
});
