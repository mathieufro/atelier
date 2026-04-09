/** Minimal Bun type declarations for Bun.serve() used in index.ts */
declare namespace Bun {
  interface ServeOptions {
    hostname?: string
    port?: number
    fetch: (request: Request) => Response | Promise<Response>
    idleTimeout?: number
  }
  interface Server {
    port: number
    hostname: string
    stop(): void
  }
  function serve(options: ServeOptions): Server
}
