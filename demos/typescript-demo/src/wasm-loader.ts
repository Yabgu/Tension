// wasm-loader.ts
export async function loadWasm(moduleUrl: string): Promise<WebAssembly.Instance> {
    const response = await fetch(moduleUrl);
    const buffer = await response.arrayBuffer();
    const module = await WebAssembly.instantiate(buffer);
    return module.instance;
}