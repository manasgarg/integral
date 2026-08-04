import type http from "node:http";

export interface HttpServerRuntime {
  listen(server: http.Server, port: number, address: string): Promise<void>;
  close(server: http.Server): Promise<void>;
}

export interface IntervalRuntime {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export const nodeHttpServerRuntime: HttpServerRuntime = {
  async listen(server, port, address) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, resolve);
    });
  },
  async close(server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (
          !error ||
          (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
        )
          resolve();
        else reject(error);
      });
      server.closeAllConnections();
    });
  },
};

export const nodeIntervalRuntime: IntervalRuntime = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) =>
    clearInterval(handle as NodeJS.Timeout | undefined),
};
