export function deploymentOptions(mode = "immediate") {
  if (mode !== "immediate" && mode !== "deferred") {
    throw new Error("--code-update-mode must be immediate or deferred");
  }
  return {
    mode,
    args: [
      "run",
      "deploy",
      "--",
      "--durable-objects-code-update-mode",
      mode,
      ...(mode === "deferred" ? ["300s"] : [])
    ]
  };
}
