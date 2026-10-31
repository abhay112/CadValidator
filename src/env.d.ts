/// <reference types="vite/client" />

declare module "opencascade.js/dist/opencascade.wasm.js" {
  const init: new (opts?: Record<string, unknown>) => Promise<any>;
  export default init;
}
declare module "opencascade.js/dist/opencascade.wasm.wasm?url" {
  const url: string;
  export default url;
}
