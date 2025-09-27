// AssemblyScript demo scene for Tension engine

// Import host functions
declare function createBox(x: f32, y: f32, w: f32, h: f32): i32;
declare function moveEntity(id: i32, dx: f32, dy: f32): void;
declare function log(ptr: usize, len: usize): void;
declare function time(): f32;
declare function input(key: i32): bool;

let boxId: i32 = -1;
let lastTime: f32 = 0;

// Helper function to log strings
function logString(message: string): void {
    const buffer = String.UTF8.encode(message);
    log(changetype<usize>(buffer), buffer.byteLength);
}

// Required export: called once when module loads
export function start(): void {
    logString("Demo scene starting!");
    
    // Create a box in the center of the screen
    boxId = createBox(400, 300, 50, 50);
    lastTime = time();
    
    logString("Demo scene initialized with box ID: " + boxId.toString());
}

// Required export: called every frame
export function update(dt: f32): void {
    const currentTime = time();
    
    // Move the box in a circle
    const radius: f32 = 100;
    const speed: f32 = 2;
    const angle = currentTime * speed;
    
    const centerX: f32 = 400;
    const centerY: f32 = 300;
    
    const targetX = centerX + Math.sin(angle) * radius;
    const targetY = centerY + Math.cos(angle) * radius;
    
    // Calculate movement delta (simple approach for demo)
    const dx = (targetX - (centerX + Math.sin((currentTime - dt) * speed) * radius));
    const dy = (targetY - (centerY + Math.cos((currentTime - dt) * speed) * radius));
    
    if (boxId >= 0) {
        moveEntity(boxId, dx, dy);
    }
    
    // Log occasionally
    if (Math.floor(currentTime) > Math.floor(lastTime)) {
        logString("Update: dt=" + dt.toString() + ", time=" + currentTime.toString());
        lastTime = currentTime;
    }
}