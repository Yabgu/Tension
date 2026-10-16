class E { a: i32 = 0; }
export function simple(): i32 {
  let n = 0;
  for (let f = 0; f < 100; f++) {
    for (let i = 0; i < 100; i++) { const e = new E(); e.a = i; n += e.a; }
    __collect();
  }
  return n;
}
export function noCollect(): i32 {
  let n = 0;
  for (let f = 0; f < 100; f++) {
    for (let i = 0; i < 100; i++) { const e = new E(); e.a = i; n += e.a; }
  }
  return n;
}
export function heapPages(): f64 { return <f64>memory.size(); }
