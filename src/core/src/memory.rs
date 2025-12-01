/// Memory management - Arena allocators and memory pools for performance
use std::alloc::{alloc, dealloc, Layout};
use std::ptr::NonNull;
use std::marker::PhantomData;

/// Memory manager - tracks allocations and provides debugging
pub struct MemoryManager {
    total_allocated: usize,
    peak_allocated: usize,
    allocation_count: usize,
    arenas: Vec<Box<dyn ArenaAllocatorTrait>>,
}

impl MemoryManager {
    pub fn new() -> Self {
        Self {
            total_allocated: 0,
            peak_allocated: 0,
            allocation_count: 0,
            arenas: Vec::new(),
        }
    }
    
    pub fn create_arena<T>(&mut self, capacity: usize) -> ArenaAllocator<T> {
        let arena = ArenaAllocator::new(capacity);
        // Don't store arenas for now - we'll track them differently later
        arena
    }
    
    pub fn total_allocated(&self) -> usize {
        self.total_allocated
    }
    
    pub fn peak_allocated(&self) -> usize {
        self.peak_allocated
    }
    
    pub fn allocation_count(&self) -> usize {
        self.allocation_count
    }
    
    fn track_allocation(&mut self, size: usize) {
        self.total_allocated += size;
        self.allocation_count += 1;
        
        if self.total_allocated > self.peak_allocated {
            self.peak_allocated = self.total_allocated;
        }
    }
    
    fn track_deallocation(&mut self, size: usize) {
        self.total_allocated = self.total_allocated.saturating_sub(size);
    }
}

/// Arena allocator trait for type erasure
trait ArenaAllocatorTrait {
    fn reset(&mut self);
    fn memory_usage(&self) -> usize;
}

/// Arena allocator - fast allocation, bulk deallocation
pub struct ArenaAllocator<T> {
    memory: NonNull<u8>,
    capacity: usize,
    used: usize,
    layout: Layout,
    _phantom: PhantomData<T>,
}

unsafe impl<T> Send for ArenaAllocator<T> {}
unsafe impl<T> Sync for ArenaAllocator<T> {}

impl<T> ArenaAllocator<T> {
    pub fn new(capacity: usize) -> Self {
        let layout = Layout::array::<T>(capacity).expect("Invalid layout");
        let memory = unsafe {
            let ptr = alloc(layout);
            NonNull::new(ptr).expect("Allocation failed")
        };
        
        Self {
            memory,
            capacity,
            used: 0,
            layout,
            _phantom: PhantomData,
        }
    }
    
    pub fn allocate(&mut self) -> Option<&mut T> {
        if self.used >= self.capacity {
            return None;
        }
        
        unsafe {
            let ptr = self.memory.as_ptr().add(self.used * std::mem::size_of::<T>()) as *mut T;
            self.used += 1;
            Some(&mut *ptr)
        }
    }
    
    pub fn allocate_slice(&mut self, count: usize) -> Option<&mut [T]> {
        if self.used + count > self.capacity {
            return None;
        }
        
        unsafe {
            let ptr = self.memory.as_ptr().add(self.used * std::mem::size_of::<T>()) as *mut T;
            self.used += count;
            Some(std::slice::from_raw_parts_mut(ptr, count))
        }
    }
    
    pub fn reset(&mut self) {
        self.used = 0;
    }
    
    pub fn capacity(&self) -> usize {
        self.capacity
    }
    
    pub fn used(&self) -> usize {
        self.used
    }
    
    pub fn remaining(&self) -> usize {
        self.capacity - self.used
    }
    
    pub fn memory_usage(&self) -> usize {
        self.used * std::mem::size_of::<T>()
    }
}

impl<T> ArenaAllocatorTrait for ArenaAllocator<T> {
    fn reset(&mut self) {
        self.reset();
    }
    
    fn memory_usage(&self) -> usize {
        self.memory_usage()
    }
}

impl<T> Drop for ArenaAllocator<T> {
    fn drop(&mut self) {
        unsafe {
            dealloc(self.memory.as_ptr(), self.layout);
        }
    }
}

/// Object pool - reuse objects to avoid allocation churn
pub struct ObjectPool<T> {
    objects: Vec<T>,
    create_fn: Box<dyn Fn() -> T>,
}

impl<T> ObjectPool<T> {
    pub fn new<F>(create_fn: F) -> Self 
    where 
        F: Fn() -> T + 'static
    {
        Self {
            objects: Vec::new(),
            create_fn: Box::new(create_fn),
        }
    }
    
    pub fn get(&mut self) -> T {
        self.objects.pop().unwrap_or_else(|| (self.create_fn)())
    }
    
    pub fn return_object(&mut self, object: T) {
        self.objects.push(object);
    }
    
    pub fn len(&self) -> usize {
        self.objects.len()
    }
    
    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }
    
    pub fn clear(&mut self) {
        self.objects.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_arena_allocator() {
        let mut arena: ArenaAllocator<i32> = ArenaAllocator::new(10);
        
        assert_eq!(arena.capacity(), 10);
        assert_eq!(arena.used(), 0);
        assert_eq!(arena.remaining(), 10);
        
        let ptr1 = arena.allocate().unwrap();
        *ptr1 = 42;
        assert_eq!(arena.used(), 1);
        
        let slice = arena.allocate_slice(3).unwrap();
        slice[0] = 1;
        slice[1] = 2;
        slice[2] = 3;
        assert_eq!(arena.used(), 4);
        
        arena.reset();
        assert_eq!(arena.used(), 0);
    }
    
    #[test]
    fn test_object_pool() {
        let mut pool = ObjectPool::new(|| Vec::<i32>::new());
        
        let mut vec1 = pool.get();
        vec1.push(42);
        pool.return_object(vec1);
        
        assert_eq!(pool.len(), 1);
        
        let vec2 = pool.get();
        // Object pools should reset state if needed
        assert_eq!(pool.len(), 0);
    }
}