// This file contains TypeScript type definitions for the Tension engine, ensuring type safety when using the engine's API in TypeScript.

declare module "tension" {
    export interface EngineConfig {
        windowWidth: number;
        windowHeight: number;
        targetFps: number;
        enableDeterministicMode: boolean;
        masterSeed: number;
    }

    export class Engine {
        constructor(config: EngineConfig);
        setRenderer(renderer: Renderer): void;
        setWasmRuntime(runtime: WasmEngine): void;
        run(): Promise<void>;
        worldMut(): World;
    }

    export interface Renderer {
        // Define renderer methods and properties here
    }

    export interface WasmEngine {
        // Define WASM engine methods and properties here
    }

    export interface World {
        createEntity(): number;
        addComponent(entity: number, component: any): void;
        entityCount(): number;
    }

    export interface Transform {
        position: Vec3;
        rotation: Quat;
        scale: Vec3;
        parent: number | null;
    }

    export interface RenderComponent {
        meshId: string;
        materialId: string;
        visible: boolean;
        layer: number;
    }

    export class Vec3 {
        static ZERO: Vec3;
        static ONE: Vec3;
        static splot(value: number): Vec3;
        constructor(x: number, y: number, z: number);
        // Define Vec3 methods here
    }

    export class Quat {
        static IDENTITY: Quat;
        constructor(x: number, y: number, z: number, w: number);
        // Define Quat methods here
    }
}