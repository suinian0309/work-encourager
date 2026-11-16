/**
 * Coopanion 的宠物运行时（AGPL-3.0）是没有类型声明的纯 ESM 脚本，
 * 这里只声明本应用用到的那几个入口，签名保持宽松。
 */
declare module '*/whale/body.js' {
  export function createBody(host: unknown, opts: unknown): Promise<any>;
}

declare module '*/whale/figure.js' {
  export function createWhaleFigure(base: URL | string, opts?: unknown): Promise<any>;
}

declare module '*/whale/rig.js' {
  export function createRig(canvas: HTMLCanvasElement, model: unknown): any;
}
