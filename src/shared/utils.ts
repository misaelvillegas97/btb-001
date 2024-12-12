export async function safeExecute(fn: Function, ...args: any[]) {
  try {
    await fn(...args);
  } catch ( error ) {
    console.error(`Error executing ${ fn.name }:`, error);
  }
}
