// What this device and browser can do, read once before a tool runs. Every probe is best effort: a probe that
// throws reports "not available" rather than failing the tool.

export interface Caps {
  /** A hardware WebGPU adapter (a software one, such as SwiftShader, is far slower than WebAssembly: not counted). */
  webgpu: boolean;
  /** That adapter runs 16-bit float shaders (shader-f16). */
  webgpuF16: boolean;
  deviceMemoryGB?: number;
  mobile: boolean;
  /** On mobile data (only Chromium on Android reports this). */
  cellular: boolean;
  webcodecs: { decode: boolean; h264Encode: boolean };
}

interface Adapter {
  features?: { has(name: string): boolean };
  info?: { isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean; // before GPUAdapterInfo had it
}

interface NavigatorExtras {
  gpu?: { requestAdapter(): Promise<Adapter | null> };
  deviceMemory?: number;
  connection?: { type?: string };
  userAgentData?: { mobile?: boolean };
}

/** Some drivers take seconds (or never answer) to hand out an adapter: past this, count WebGPU as absent. */
const ADAPTER_TIMEOUT_MS = 1500;

async function webGpu(nav: NavigatorExtras): Promise<{ webgpu: boolean; webgpuF16: boolean }> {
  const none = { webgpu: false, webgpuF16: false };
  if (!nav.gpu) return none;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ADAPTER_TIMEOUT_MS)));
    const adapter = await Promise.race([nav.gpu.requestAdapter(), timeout]);
    if (!adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) return none;
    return { webgpu: true, webgpuF16: adapter.features?.has('shader-f16') === true };
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
  }
}

async function canEncodeH264(): Promise<boolean> {
  try {
    if (typeof VideoEncoder === 'undefined' || !VideoEncoder) return false;
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f', // H.264 Baseline 3.1
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
    });
    return supported === true;
  } catch {
    return false;
  }
}

function isMobile(nav: Navigator & NavigatorExtras): boolean {
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1; // iPadOS asks for the desktop site
}

export async function detect(): Promise<Caps> {
  const nav = navigator as Navigator & NavigatorExtras;
  const [gpu, h264Encode] = await Promise.all([webGpu(nav), canEncodeH264()]);
  const caps: Caps = {
    ...gpu,
    mobile: isMobile(nav),
    cellular: nav.connection?.type === 'cellular',
    webcodecs: { decode: typeof VideoDecoder === 'function', h264Encode },
  };
  if (typeof nav.deviceMemory === 'number') caps.deviceMemoryGB = nav.deviceMemory;
  return caps;
}
