/** Tiny Convex HTTP client for optional session persistence. */

type ConvexEndpoint = "query" | "mutation" | "action";

export class ConvexHttpClient {
  readonly #baseUrl: string;
  readonly #accessKey: string | null;

  constructor(options: { baseUrl: string; accessKey?: string | null }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#accessKey = options.accessKey ?? null;
  }

  /** Run a Convex query. */
  query(path: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.#call("query", path, args);
  }

  /** Run a Convex mutation. */
  mutation(path: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.#call("mutation", path, args);
  }

  async #call(endpoint: ConvexEndpoint, path: string, args: Record<string, unknown>): Promise<unknown> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.#accessKey !== null) {
      headers.set("authorization", `Convex ${this.#accessKey}`);
    }

    const response = await fetch(`${this.#baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path,
        args,
        format: "json",
      }),
    });

    if (!response.ok) {
      throw new Error(`Convex ${endpoint} failed with status ${response.status}`);
    }

    const payload = await response.json() as {
      status?: string;
      value?: unknown;
      errorMessage?: string;
    };

    if (payload.status === "success") {
      return payload.value;
    }

    throw new Error(payload.errorMessage ?? "Convex request failed");
  }
}
