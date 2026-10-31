// The runner has no browser UI. Simulation/database code is unmodified.
// Notifications and progress are forwarded to the parent by the runtime.
export default async function toUI(name, args) {
  await globalThis.campaignUI?.(name, args);
  // Never silently accept a UI decision that could change simulation behavior.
  if (['confirm', 'prompt', 'autoPlayDialog'].includes(name)) {
    throw new Error(`Unexpected interactive engine request: ${name}`);
  }
}
