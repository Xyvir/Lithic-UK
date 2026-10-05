/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * A paired folder, driven from JavaScript.
 */
export class SyncEngine {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Every file in the document, as plain objects.
     */
    entries(): Promise<Array<any>>;
    /**
     * Pair with another device from its ticket.
     */
    join(ticket: string): Promise<void>;
    /**
     * This device's endpoint id, stable for a given seed.
     */
    node_id(): string;
    /**
     * Write a file and publish it.
     */
    publish(name: string, bytes: Uint8Array): Promise<void>;
    /**
     * The latest bytes the document holds for a file, if it holds any.
     */
    read(name: string): Promise<Uint8Array | undefined>;
    /**
     * The write ticket for this folder, creating the document on first use.
     */
    share(): Promise<string>;
    /**
     * Start the engine with a fixed 32 byte identity seed.
     */
    static start(identity: Uint8Array): Promise<SyncEngine>;
    /**
     * Follow the folder; the callback receives one plain object per event.
     */
    subscribe(callback: Function): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly __wbg_syncengine_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly syncengine_entries: (a: number) => any;
    readonly syncengine_join: (a: number, b: number, c: number) => any;
    readonly syncengine_node_id: (a: number) => [number, number];
    readonly syncengine_publish: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly syncengine_read: (a: number, b: number, c: number) => any;
    readonly syncengine_share: (a: number) => any;
    readonly syncengine_start: (a: number, b: number) => any;
    readonly syncengine_subscribe: (a: number, b: any) => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke___js_sys_8d450a2a024b9ac7___Function_fn_wasm_bindgen_633f9e8aa6f6f891___JsValue_____wasm_bindgen_633f9e8aa6f6f891___sys__Undefined___js_sys_8d450a2a024b9ac7___Function_fn_wasm_bindgen_633f9e8aa6f6f891___JsValue_____wasm_bindgen_633f9e8aa6f6f891___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke___wasm_bindgen_633f9e8aa6f6f891___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_633f9e8aa6f6f891___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke___wasm_bindgen_633f9e8aa6f6f891___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke___web_sys_d635cf6250923cfb___features__gen_CloseEvent__CloseEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke___web_sys_d635cf6250923cfb___features__gen_MessageEvent__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke_______true__1_: (a: number, b: number) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke_______true__2_: (a: number, b: number) => void;
    readonly wasm_bindgen_633f9e8aa6f6f891___convert__closures_____invoke_______true__3_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
