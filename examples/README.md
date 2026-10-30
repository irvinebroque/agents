# Agents SDK examples

Each directory contains a runnable example. See its README for setup and usage.

## Code updates

Runnable examples use deferred Durable Object code updates. Active agents can
keep running the previous version until they hibernate, for up to 300 seconds.
Updates are best effort: keep recovery state in durable storage. See
[configuration](../docs/agents/configuration.md#durable_objectscode_update_strategy)
for overrides.

The [deploy-churn harness](./deploy-churn/) explicitly uses immediate updates
when testing recovery from forced resets.
