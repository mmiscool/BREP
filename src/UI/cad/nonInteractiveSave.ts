export type NonInteractiveSaveSource = "local" | "github" | "mounted";

export type NonInteractiveSaveRequest = {
  modelPath: string;
  source: NonInteractiveSaveSource;
  repoFull: string;
  branch: string;
  overwrite: boolean;
};

type PersistenceTransaction<T> = {
  signal?: AbortSignal | null;
  write: () => Promise<void>;
  verify: () => Promise<T>;
  rollback: () => Promise<void>;
};

function normalizeSource(value: unknown): NonInteractiveSaveSource {
  const source = String(value || "local").trim().toLowerCase();
  if (source === "local" || source === "github" || source === "mounted") {
    return source;
  }
  throw new Error(`saveCurrentTo received unsupported source "${source}"`);
}

export function createAbortError(message = "Save operation aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfSaveAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw createAbortError();
}

export function normalizeNonInteractiveSaveRequest(
  input: Record<string, unknown> = {},
): NonInteractiveSaveRequest {
  const modelPath = String(input.modelPath ?? input.path ?? input.name ?? "").trim();
  if (!modelPath) throw new Error("saveCurrentTo requires modelPath");

  const source = normalizeSource(input.source);
  const repoFull = source === "local" ? "" : String(input.repoFull || "").trim();
  if (source !== "local" && !repoFull) {
    throw new Error(`saveCurrentTo requires repoFull for source "${source}"`);
  }
  const branch = source === "github" ? String(input.branch || "").trim() : "";
  if (source === "github" && !branch) {
    throw new Error('saveCurrentTo requires branch for source "github"');
  }

  return {
    modelPath,
    source,
    repoFull,
    branch,
    overwrite: input.overwrite === true,
  };
}

export async function persistWithRollback<T>({
  signal,
  write,
  verify,
  rollback,
}: PersistenceTransaction<T>): Promise<T> {
  throwIfSaveAborted(signal);
  let writeStarted = false;
  try {
    writeStarted = true;
    await write();
    throwIfSaveAborted(signal);
    const evidence = await verify();
    throwIfSaveAborted(signal);
    return evidence;
  } catch (error) {
    if (writeStarted) {
      try {
        await rollback();
      } catch (rollbackError) {
        const message = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        throw new Error(`Save failed and rollback failed: ${message}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}
